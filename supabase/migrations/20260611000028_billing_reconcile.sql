-- ============================================================================
-- B1 + B2 + B8: reconcile reserved tokens when a generation is finalized by the
-- reaper (or abandoned by a killed synchronous request), instead of silently
-- overcharging the customer.
--
-- ROOT CAUSE (B1): reap_orphans() finalized stuck jobs but never refunded the
-- up-front token reserve — the refund lived only in the worker's finalize path,
-- which the reaper bypasses. A metered job killed mid-pass at the pass cap was
-- charged the full N-image reserve even when 0..few images landed.
--
-- ROOT CAUSE (B2): a synchronous /api/generate or /api/batch/item request
-- reserves tokens, then can be killed at Vercel's 60s cap BEFORE its own refund
-- runs, leaving the row stuck 'processing' forever and the customer overcharged.
-- Those rows have params IS NULL (they never go through the worker queue), so
-- the reaper now sweeps them too.
--
-- MECHANISM: each generation stores how to reconcile itself —
--   billing_kind : 'metered' (tokens), 'free' (monthly quota), or 'none'
--   refund_unit  : refundable tokens per un-generated image (image_gen * tier mult)
--   images_target: the reserved image count N
-- The reaper refunds refund_unit * (images_target - images_generated) for metered
-- rows, or restores one free slot for a free row that produced nothing. The
-- worker's own finalize path is unchanged and remains mutually exclusive with the
-- reaper via the existing claimed_at ownership guard (no double refund).
--
-- B8: the pass cap is unified to 8 across claim_generation / queue_has_work /
-- reap_orphans (previously claim used 5 while WORKER_MAX_PASSES defaulted to 8,
-- so passes 6-8 were unreachable and jobs stalled until the reaper).
-- ============================================================================

alter table public.generations
  add column if not exists billing_kind  text    not null default 'none',
  add column if not exists refund_unit   numeric not null default 0,
  add column if not exists images_target int     not null default 0;

-- ── claim_generation: only ever claim real worker-queue jobs (params IS NOT
-- NULL). Synchronous /api/generate rows (params IS NULL) must never be claimed
-- by the worker — they are reconciled by the reaper instead. Pass cap → 8.
create or replace function public.claim_generation(
  p_stale_seconds int default 90,
  p_max_lanes     int default 3,
  p_max_passes    int default 8
)
returns setof public.generations
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  gid    uuid;
  active int;
begin
  perform pg_advisory_xact_lock(hashtext('photoforge_claim_generation'));

  select count(*) into active
    from public.generations
   where status = 'processing'
     and claimed_at is not null
     and claimed_at > now() - make_interval(secs => p_stale_seconds);

  if active >= p_max_lanes then return; end if;

  select id into gid
    from public.generations
   where params is not null
     and (status = 'queued'
       or (status = 'processing'
           and passes < p_max_passes
           and (claimed_at is null or claimed_at < now() - make_interval(secs => p_stale_seconds))))
   order by created_at
   for update skip locked
   limit 1;

  if gid is null then return; end if;

  update public.generations
     set status = 'processing', claimed_at = now(), passes = passes + 1
   where id = gid;

  return query select * from public.generations where id = gid;
end $$;

revoke all on function public.claim_generation(int, int, int) from public, anon, authenticated;

-- ── queue_has_work: claimable worker jobs only (params not null, pass cap 8).
create or replace function public.queue_has_work()
returns boolean
language sql security definer set search_path = public, pg_temp stable as $$
  select exists (
    select 1 from public.generations
     where params is not null
       and (status = 'queued'
         or (status = 'processing' and passes < 8
             and (claimed_at is null or claimed_at < now() - interval '90 seconds')))
  );
$$;

revoke all on function public.queue_has_work() from public, anon, authenticated;

-- ── reap_orphans: finalize stuck jobs AND reconcile their reserved tokens.
--   (A) worker-queue jobs killed at the pass cap (params not null)
--   (B) abandoned synchronous gens (params null, claimed_at null, killed > 180s)
-- Drop the old 2-arg version first, else the named-arg call resolves to it
-- (exact-match overload) and skips the new refund logic.
drop function if exists public.reap_orphans(int, int);

create or replace function public.reap_orphans(
  p_stale_seconds        int default 120,
  p_max_passes           int default 8,
  p_sync_abandon_seconds int default 180
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r        record;
  n        int := 0;
  v_failed int;
  v_refund numeric;
  v_final  text;
begin
  for r in
    select * from public.generations
     where status = 'processing'
       and (
            (params is not null
             and passes >= p_max_passes
             and (claimed_at is null or claimed_at < now() - make_interval(secs => p_stale_seconds)))
         or (params is null and claimed_at is null and passes = 0
             and created_at < now() - make_interval(secs => p_sync_abandon_seconds))
       )
     for update skip locked
  loop
    v_final  := case when coalesce(r.images_generated, 0) > 0 then 'done' else 'error' end;
    v_failed := greatest(coalesce(r.images_target, 0) - coalesce(r.images_generated, 0), 0);

    -- Reconcile the reservation the worker's finalize would have settled.
    -- Mirror refundForRun(): per-image cost for every failed slot, PLUS the
    -- prompt_gen cost (0.10 = TOKEN_COSTS.prompt_gen) only when the whole run
    -- produced nothing — the worker refunds the prompt too in that case.
    if r.billing_kind = 'metered' and coalesce(r.refund_unit, 0) > 0 and v_failed > 0 then
      v_refund := coalesce(r.refund_unit, 0) * v_failed
                + case when coalesce(r.images_generated, 0) = 0 then 0.10 else 0 end;
      if v_refund > 0 then
        perform public.credit_tokens_tx(
          r.user_id, v_refund, 'refund',
          'Повернення (reaper): ' || v_failed || ' невдалих фото', r.id);
      end if;
    elsif r.billing_kind = 'free' and coalesce(r.images_generated, 0) = 0 then
      perform public.restore_free_generation(r.user_id);
    end if;

    update public.generations
       set status = v_final,
           error_message = case when v_final = 'error'
                                then coalesce(error_message, 'stalled') else error_message end,
           claimed_at = null
     where id = r.id;

    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.reap_orphans(int, int, int) from public, anon, authenticated;
