-- Make queue_has_work() mirror what claim_generation can actually claim: a
-- 'queued' row, or a 'processing' row whose claim has gone stale (>90s). Before,
-- it returned true for ANY processing row, so every worker finish + status poll
-- kicked fresh workers that just returned idle (the lane cap made them harmless
-- but they burned Vercel invocations). Now a kick only fires when a worker could
-- genuinely pick something up.

CREATE OR REPLACE FUNCTION queue_has_work()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM generations
     WHERE status = 'queued'
        OR (status = 'processing'
            AND (claimed_at IS NULL OR claimed_at < now() - interval '90 seconds'))
  );
$$;
