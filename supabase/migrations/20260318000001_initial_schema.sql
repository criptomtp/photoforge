-- PhotoForge initial schema

-- Profiles (extends auth.users)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  full_name text,
  plan text default 'free' check (plan in ('free', 'starter', 'pro', 'enterprise')),
  generations_used int default 0,
  generations_limit int default 5,
  stripe_customer_id text,
  stripe_subscription_id text,
  google_access_token text,
  google_refresh_token text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email)
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Generations
create table public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  brand text,
  product_type text,
  season text,
  gender text,
  status text default 'queued' check (status in ('queued', 'processing', 'done', 'error')),
  images_generated int default 0,
  google_drive_folder_id text,
  google_drive_folder_url text,
  image_urls text[],
  error_message text,
  created_at timestamptz default now()
);

alter table public.generations enable row level security;

create policy "Users can view own generations"
  on public.generations for select
  using (auth.uid() = user_id);

create policy "Users can insert own generations"
  on public.generations for insert
  with check (auth.uid() = user_id);

create policy "Users can update own generations"
  on public.generations for update
  using (auth.uid() = user_id);

-- Batch jobs
create table public.batch_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  source text check (source in ('sheets', 'excel')),
  source_id text,
  total_items int,
  processed_items int default 0,
  status text default 'queued' check (status in ('queued', 'processing', 'done', 'error')),
  created_at timestamptz default now()
);

alter table public.batch_jobs enable row level security;

create policy "Users can view own batch jobs"
  on public.batch_jobs for select
  using (auth.uid() = user_id);

create policy "Users can insert own batch jobs"
  on public.batch_jobs for insert
  with check (auth.uid() = user_id);

create policy "Users can update own batch jobs"
  on public.batch_jobs for update
  using (auth.uid() = user_id);
