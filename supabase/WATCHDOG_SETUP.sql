-- ============================================================================
-- B6: queue-liveness watchdog (OPTIONAL, NOT part of the migration chain).
--
-- Today the worker queue is kept alive only by the worker self-chaining and by
-- the client polling the batch page. If every worker invocation dies AND the
-- user closes the tab, queued jobs (with reserved tokens) sit idle forever.
--
-- This sets up a Supabase pg_cron job that pings the Vercel /api/worker endpoint
-- every minute, so the queue drains even with no browser open. It needs:
--   1. pg_cron + pg_net extensions enabled (Supabase Dashboard → Database →
--      Extensions, or the CREATE EXTENSION lines below).
--   2. Two secrets stored in Supabase Vault: the worker URL and WORKER_SECRET.
--
-- Run this MANUALLY in the Supabase SQL editor once (do NOT add it to the
-- migrations folder — pg_cron/pg_net availability is environment-specific and a
-- `supabase db push` on an environment without them would fail).
--
-- Alternative if you move to Vercel Pro: a Vercel Cron hitting /api/worker is
-- simpler and needs no DB extensions.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store secrets once (replace the placeholders, then optionally delete these two
-- lines so the secrets aren't left in your SQL history):
--   select vault.create_secret('https://photoforge-zeta.vercel.app/api/worker', 'worker_url');
--   select vault.create_secret('<YOUR_WORKER_SECRET>', 'worker_secret');

select cron.schedule(
  'photoforge-worker-watchdog',
  '* * * * *',  -- every minute
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'worker_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'worker_secret')
    ),
    body    := '{}'::jsonb
  )
  where exists (
    -- only ping when there is actually claimable work, to avoid waking the
    -- function pointlessly every minute
    select 1 from public.generations
     where params is not null
       and (status = 'queued'
         or (status = 'processing' and passes < 8
             and (claimed_at is null or claimed_at < now() - interval '90 seconds')))
  );
  $$
);

-- To remove later:  select cron.unschedule('photoforge-worker-watchdog');
