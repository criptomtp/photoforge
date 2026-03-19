-- ── 1. Alter profiles ────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists gemini_api_key text,          -- encrypted BYOK key
  add column if not exists token_balance decimal(12,4) default 0,
  add column if not exists google_drive_connected boolean default false,
  add column if not exists google_sheets_connected boolean default false;

-- ── 2. Platform settings (singleton row, id = 1) ──────────────────────────
create table if not exists public.platform_settings (
  id int primary key default 1,
  gemini_api_key text,                  -- encrypted platform key
  cost_per_prompt_gen decimal(10,6) default 0.01,   -- token cost: Gemini Pro call
  cost_per_image_gen decimal(10,6) default 0.05,    -- token cost: each image
  free_plan_tokens decimal(10,4) default 0,         -- tokens given on signup
  pricing_starter_usd decimal(10,2) default 29,
  pricing_pro_usd decimal(10,2) default 79,
  maintenance_mode boolean default false,
  updated_at timestamptz default now(),
  constraint singleton check (id = 1)
);

-- Insert default row
insert into public.platform_settings (id) values (1)
  on conflict (id) do nothing;

-- RLS: only service_role can write; authenticated can read
alter table public.platform_settings enable row level security;

create policy "Anyone authenticated can read platform settings"
  on public.platform_settings for select
  to authenticated
  using (true);

-- ── 3. Token transactions log ─────────────────────────────────────────────
create table if not exists public.token_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  amount decimal(12,4) not null,          -- positive = credit, negative = debit
  kind text not null,                     -- 'purchase', 'generation', 'refund', 'bonus'
  description text,
  generation_id uuid references public.generations(id) on delete set null,
  balance_after decimal(12,4),
  created_at timestamptz default now()
);

alter table public.token_transactions enable row level security;

create policy "Users can view own transactions"
  on public.token_transactions for select
  using (auth.uid() = user_id);

-- ── 4. Admin helper: is_admin() function ──────────────────────────────────
create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from auth.users
    where id = auth.uid()
    and email = 'criptomtp@gmail.com'
  );
$$ language sql security definer stable;

-- Admin policies for platform_settings (write)
create policy "Admin can update platform settings"
  on public.platform_settings for update
  using (public.is_admin());

-- Admin policy for token_transactions (full read)
create policy "Admin can read all transactions"
  on public.token_transactions for select
  using (public.is_admin());

-- Allow service_role to insert transactions (from API routes)
create policy "Service role can insert transactions"
  on public.token_transactions for insert
  with check (true);

-- ── 5. Admin view: users with stats ──────────────────────────────────────
create or replace view public.admin_users_view as
  select
    p.id,
    u.email,
    p.full_name,
    p.plan,
    p.token_balance,
    p.generations_used,
    p.generations_limit,
    p.google_drive_connected,
    p.google_sheets_connected,
    p.gemini_api_key is not null as has_byok,
    p.stripe_customer_id,
    p.created_at,
    count(g.id) filter (where g.status = 'done') as generations_done,
    count(g.id) filter (where g.status = 'error') as generations_error,
    max(g.created_at) as last_generation_at
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.generations g on g.user_id = p.id
  group by p.id, u.email;

-- ── 6. Admin view: analytics ─────────────────────────────────────────────
create or replace view public.admin_analytics_view as
  select
    date_trunc('day', created_at) as day,
    count(*) as total_generations,
    count(*) filter (where status = 'done') as successful,
    count(*) filter (where status = 'error') as failed,
    sum(images_generated) as total_images,
    count(distinct user_id) as unique_users
  from public.generations
  group by date_trunc('day', created_at)
  order by day desc;
