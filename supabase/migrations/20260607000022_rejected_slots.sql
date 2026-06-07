-- Per-angle "rejected" marks: a slot the user gave up on (can't be generated).
-- Excluded from "missing"/regenerate so the batch can be considered complete.
ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS rejected_slots int[] NOT NULL DEFAULT '{}';
