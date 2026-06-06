-- Fix the "frozen batch" hole: a job KILLED mid-pass at passes>=max_passes stayed
-- 'processing' forever — claim_generation refused it (passes cap) but queue_has_work
-- still reported work → endless idle kicks, batch never finished. reap_orphans()
-- finalizes such jobs (done if any image, else error); the worker runs it every
-- invocation. queue_has_work() is aligned to claim_generation so it never reports
-- work that can't actually be claimed.

CREATE OR REPLACE FUNCTION reap_orphans(
  p_stale_seconds int DEFAULT 90,
  p_max_passes    int DEFAULT 5
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  UPDATE generations
     SET status = CASE WHEN images_generated > 0 THEN 'done' ELSE 'error' END,
         error_message = CASE WHEN images_generated = 0 THEN coalesce(error_message, 'stalled') ELSE error_message END,
         claimed_at = NULL
   WHERE status = 'processing'
     AND passes >= p_max_passes
     AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => p_stale_seconds));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION reap_orphans(int, int) FROM public, anon, authenticated;

-- Only report work that claim_generation can actually claim (queued, or stale
-- 'processing' still under the pass cap).
CREATE OR REPLACE FUNCTION queue_has_work()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM generations
     WHERE status = 'queued'
        OR (status = 'processing' AND passes < 5
            AND (claimed_at IS NULL OR claimed_at < now() - interval '90 seconds'))
  );
$$;
