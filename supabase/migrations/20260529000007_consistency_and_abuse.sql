-- ============================================================================
-- CONSISTENCY & ABUSE HARDENING  (apply AFTER 20260529000006)
--  - Atomic balance+ledger writes (no more divergence on partial failure)
--  - Atomic free-quota consumption (closes the concurrency bypass)
--  - Clamp-at-zero debit for refunds/chargebacks
-- All functions are SECURITY DEFINER (owned by postgres) so they run past the
-- guard_profile_update trigger and may write the ledger regardless of RLS.
-- ============================================================================

-- ── Atomic debit + ledger row in ONE transaction ────────────────────────────
create or replace function public.deduct_tokens_tx(
  p_user_id uuid,
  p_amount numeric,
  p_kind text,
  p_description text,
  p_generation_id uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance numeric;
begin
  select token_balance into v_balance
  from public.profiles
  where id = p_user_id
  for update;  -- row lock: serializes concurrent generations

  if v_balance is null then
    raise exception 'Profile % not found', p_user_id;
  end if;
  if v_balance < p_amount then
    raise exception 'Insufficient token balance: % < %', v_balance, p_amount;
  end if;

  update public.profiles
  set token_balance = token_balance - p_amount
  where id = p_user_id
  returning token_balance into v_balance;

  insert into public.token_transactions (user_id, amount, kind, description, generation_id, balance_after)
  values (p_user_id, -p_amount, p_kind, p_description, p_generation_id, v_balance);

  return v_balance;
end;
$$;

-- ── Atomic credit + ledger row in ONE transaction ───────────────────────────
create or replace function public.credit_tokens_tx(
  p_user_id uuid,
  p_amount numeric,
  p_kind text,
  p_description text,
  p_generation_id uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance numeric;
begin
  update public.profiles
  set token_balance = token_balance + p_amount
  where id = p_user_id
  returning token_balance into v_balance;

  if v_balance is null then
    raise exception 'Profile % not found', p_user_id;
  end if;

  insert into public.token_transactions (user_id, amount, kind, description, generation_id, balance_after)
  values (p_user_id, p_amount, p_kind, p_description, p_generation_id, v_balance);

  return v_balance;
end;
$$;

-- ── Clamp-at-zero debit (refunds / chargebacks) ─────────────────────────────
-- Removes up to p_amount tokens but never below 0 (the non-negative CHECK from
-- migration 006 forbids going negative). Already-spent tokens are not recovered.
create or replace function public.clamp_debit_tokens(
  p_user_id uuid,
  p_amount numeric,
  p_kind text,
  p_description text
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance numeric;
  v_debit numeric;
begin
  select token_balance into v_balance
  from public.profiles
  where id = p_user_id
  for update;

  if v_balance is null then
    return 0;
  end if;

  v_debit := least(p_amount, v_balance);
  if v_debit <= 0 then
    return v_balance;  -- nothing left to claw back; skip spurious zero-row write
  end if;

  update public.profiles
  set token_balance = token_balance - v_debit
  where id = p_user_id
  returning token_balance into v_balance;

  insert into public.token_transactions (user_id, amount, kind, description, balance_after)
  values (p_user_id, -v_debit, p_kind, p_description, v_balance);

  return v_balance;
end;
$$;

-- ── Atomic free-quota consumption ───────────────────────────────────────────
-- Increments generations_used only if still under the limit, in a single
-- statement — so N concurrent free requests cannot all pass a stale check.
create or replace function public.try_consume_free_generation(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles
  set generations_used = generations_used + 1
  where id = p_user_id
    and plan = 'free'
    and generations_used < generations_limit;

  return found;
end;
$$;
