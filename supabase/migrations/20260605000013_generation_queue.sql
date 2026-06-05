-- ── Background generation queue (the "factory") ────────────────────────────
-- A generation row is a job. The worker claims one, processes its pending image
-- slots within a short time budget across passes, then finalises. This lets bulk
-- generation run in the background (tab can be closed) without the 60s request cap.

ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS params jsonb,             -- all item params for the worker
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,   -- when a worker last took it
  ADD COLUMN IF NOT EXISTS drive_folder_id text,     -- per-product Drive folder (lazy)
  ADD COLUMN IF NOT EXISTS drive_urls jsonb;         -- permanent Drive links per image (for export)

CREATE INDEX IF NOT EXISTS idx_generations_queue
  ON generations(status, claimed_at) WHERE status IN ('queued', 'processing');

-- Atomically claim the next job that needs work: a fresh 'queued' row, or a
-- 'processing' row whose claim has gone stale (worker died / multi-pass continue).
CREATE OR REPLACE FUNCTION claim_generation(p_stale_seconds int DEFAULT 25)
RETURNS SETOF generations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE gid uuid;
BEGIN
  SELECT id INTO gid FROM generations
   WHERE status = 'queued'
      OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => p_stale_seconds)))
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  IF gid IS NULL THEN RETURN; END IF;
  UPDATE generations SET status = 'processing', claimed_at = now() WHERE id = gid;
  RETURN QUERY SELECT * FROM generations WHERE id = gid;
END $$;

-- True if any job still needs work (used to decide whether to re-trigger a worker).
CREATE OR REPLACE FUNCTION queue_has_work()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM generations WHERE status IN ('queued', 'processing'));
$$;
