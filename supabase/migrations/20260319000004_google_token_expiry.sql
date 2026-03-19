-- Add token expiry column (not in initial schema)
alter table public.profiles
  add column if not exists google_token_expires_at timestamptz;
