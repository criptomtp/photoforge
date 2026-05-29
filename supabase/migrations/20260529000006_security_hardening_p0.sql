-- ============================================================================
-- P0 SECURITY HARDENING
-- Closes the monetization-breaking holes found in the 2026-05-29 audit.
-- Apply in the Supabase SQL Editor (or `supabase db push`) BEFORE deploying the
-- accompanying code changes.
-- ============================================================================

-- ── C-1: stop authenticated users from editing their own money/plan columns ──
-- The "Users can update own profile" RLS policy has no column restriction, so a
-- user can PATCH token_balance / plan / generations_limit directly via PostgREST.
-- Postgres RLS cannot column-restrict an UPDATE, so we enforce it with a trigger.
-- Server paths (service_role, and SECURITY DEFINER RPCs that run as the table
-- owner) are exempt; only the `authenticated`/`anon` roles are restricted.
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Allow anything from the server (service_role / migrations / definer RPCs).
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- An authenticated user may only change full_name and their own BYOK key.
  if new.id                      is distinct from old.id
     or new.email                is distinct from old.email
     or new.plan                 is distinct from old.plan
     or new.token_balance        is distinct from old.token_balance
     or new.generations_used     is distinct from old.generations_used
     or new.generations_limit    is distinct from old.generations_limit
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

drop trigger if exists guard_profile_update_trg on public.profiles;
create trigger guard_profile_update_trg
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Defense-in-depth: balances can never go negative regardless of code path.
-- (If this fails, you already have a negative balance to investigate first.)
alter table public.profiles
  drop constraint if exists profiles_token_balance_nonneg;
-- NOT VALID: enforce on all future writes without failing the migration if some
-- pre-existing row is already negative (so this script can never half-apply).
alter table public.profiles
  add constraint profiles_token_balance_nonneg check (token_balance >= 0) not valid;

-- ── C-7: remove the open INSERT policy on token_transactions ─────────────────
-- `with check (true)` let any authenticated user forge ledger rows. The server
-- writes via service_role (which bypasses RLS), so no INSERT policy is needed.
drop policy if exists "Service role can insert transactions" on public.token_transactions;

-- ── C-6: stop exposing the encrypted platform gemini_api_key to every user ───
-- Column-level grants: authenticated may read pricing/cost fields but NOT the key.
revoke select on public.platform_settings from authenticated;
grant select (
  id, cost_per_prompt_gen, cost_per_image_gen, free_plan_tokens,
  pricing_starter_usd, pricing_pro_usd, maintenance_mode, updated_at
) on public.platform_settings to authenticated;

-- ── C-2 / C-3: Stripe webhook idempotency ledger ─────────────────────────────
-- The webhook inserts event.id here on first delivery; duplicates (Stripe
-- at-least-once retries / manual re-sends) hit the PK and are skipped.
create table if not exists public.stripe_events (
  id           text primary key,
  type         text,
  processed_at timestamptz default now()
);
alter table public.stripe_events enable row level security;
-- No policies on purpose: only service_role (RLS bypass) ever touches this.

-- ── Hardening: pin search_path on all SECURITY DEFINER functions ─────────────
alter function public.handle_new_user()                       set search_path = public, pg_temp;
alter function public.is_admin()                              set search_path = public, pg_temp;
alter function public.deduct_tokens(uuid, numeric)            set search_path = public, pg_temp;
alter function public.credit_tokens(uuid, numeric)            set search_path = public, pg_temp;
alter function public.increment_generations_used(uuid)        set search_path = public, pg_temp;
