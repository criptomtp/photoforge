-- Make MAX_PASSES enforceable even when a worker is KILLED mid-pass (Vercel 60s)
-- or throws before it can bump the counter: increment `passes` atomically at CLAIM
-- time, and refuse to re-claim a stale 'processing' job once it has burned
-- p_max_passes claims. Without this, a job that keeps dying mid-pass would be
-- reclaimed forever (unbounded retries / cost). A freshly 'queued' row is always
-- claimable — the worker stops requeuing it once passes hits the cap, so the
-- queued path is bounded by the worker; this passes-guard bounds only the
-- killed-worker (stale 'processing') path.

DROP FUNCTION IF EXISTS claim_generation(int, int);

CREATE OR REPLACE FUNCTION claim_generation(
  p_stale_seconds int DEFAULT 90,
  p_max_lanes     int DEFAULT 3,
  p_max_passes    int DEFAULT 5
)
RETURNS SETOF generations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gid    uuid;
  active int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('photoforge_claim_generation'));

  SELECT count(*) INTO active
    FROM generations
   WHERE status = 'processing'
     AND claimed_at IS NOT NULL
     AND claimed_at > now() - make_interval(secs => p_stale_seconds);

  IF active >= p_max_lanes THEN RETURN; END IF;

  SELECT id INTO gid
    FROM generations
   WHERE status = 'queued'
      OR (status = 'processing'
          AND passes < p_max_passes
          AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => p_stale_seconds)))
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF gid IS NULL THEN RETURN; END IF;

  UPDATE generations
     SET status = 'processing', claimed_at = now(), passes = passes + 1
   WHERE id = gid;

  RETURN QUERY SELECT * FROM generations WHERE id = gid;
END $$;

REVOKE ALL ON FUNCTION claim_generation(int, int, int) FROM public, anon, authenticated;
