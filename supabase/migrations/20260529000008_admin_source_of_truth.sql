-- ============================================================================
-- ADMIN SOURCE OF TRUTH  (apply AFTER 006 and 007)
-- Replaces the email hardcoded inside is_admin() with a data-driven allowlist,
-- so the admin can be changed without editing SQL and there is one source of
-- truth on the DB side.
-- ============================================================================

create table if not exists public.app_admins (
  email    text primary key,
  added_at timestamptz default now()
);

alter table public.app_admins enable row level security;
-- No policies: only service_role (RLS bypass) and SECURITY DEFINER functions
-- read this table — clients cannot see or edit the admin list.

-- Seed the current admin. Keep this in sync with the ADMIN_EMAIL env var.
insert into public.app_admins (email) values ('criptomtp@gmail.com')
  on conflict (email) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.app_admins a
    join auth.users u on u.email = a.email
    where u.id = auth.uid()
  );
$$;
