-- Track how many worker passes a job has had, so failed image slots (e.g. a 429
-- from Vertex shared quota) get RETRIED on later passes instead of being given up
-- on after one pass — but bounded, so a persistently-failing slot (e.g. safety
-- block) can't loop forever.

ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS passes int NOT NULL DEFAULT 0;
