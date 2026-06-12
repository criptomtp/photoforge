-- ============================================================================
-- B3: make the free quota actually MONTHLY.
--
-- profiles.generations_used only ever incremented and was never reset (no cron),
-- so "N free generations / month" was really N for the lifetime of the account,
-- while the dashboard labels it "Генерацій цього місяця". This stores the start
-- of the current quota period and resets the counter when the month rolls over,
-- atomically inside the same function that consumes a slot.
-- ============================================================================

alter table public.profiles
  add column if not exists quota_period_start date not null default date_trunc('month', now())::date;

create or replace function public.try_consume_free_generation(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cur date := date_trunc('month', now())::date;
begin
  -- Roll the monthly period forward (reset the counter) if we've crossed a month.
  update public.profiles
     set generations_used = 0,
         quota_period_start = cur
   where id = p_user_id
     and (quota_period_start is null or quota_period_start < cur);

  -- Atomically consume one slot: a single conditional UPDATE closes the race
  -- where concurrent requests each pass a stale used<limit check.
  update public.profiles
     set generations_used = generations_used + 1
   where id = p_user_id
     and plan = 'free'
     and generations_used < generations_limit;

  return found;
end $$;

-- NOTE: the EXECUTE revoke for this function lives in the FINAL migration
-- (…_revoke_money_rpcs), which must be applied AFTER the new code is deployed —
-- the currently-deployed code still calls this via the authenticated client, so
-- revoking here would break production during a staged rollout. This migration
-- is safe to apply before the deploy.

-- The new quota_period_start column must be protected by the profiles guard
-- trigger too — otherwise an authenticated user could PATCH it to a past month
-- via PostgREST, which makes resolveApiKey/try_consume reset their free counter
-- and grants unlimited free generations. Re-create the guard with the column
-- added (mirrors 20260529000006_security_hardening_p0).
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.id                      is distinct from old.id
     or new.email                is distinct from old.email
     or new.plan                 is distinct from old.plan
     or new.token_balance        is distinct from old.token_balance
     or new.generations_used     is distinct from old.generations_used
     or new.generations_limit    is distinct from old.generations_limit
     or new.quota_period_start    is distinct from old.quota_period_start
     or new.stripe_customer_id   is distinct from old.stripe_customer_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id
     or new.google_access_token  is distinct from old.google_access_token
     or new.google_refresh_token is distinct from old.google_refresh_token
     or new.google_token_expires_at is distinct from old.google_token_expires_at
     or new.google_drive_connected  is distinct from old.google_drive_connected
     or new.google_sheets_connected is distinct from old.google_sheets_connected
  then
    raise exception 'Updating protected profile columns is not allowed';
  end if;

  return new;
end;
$$;
