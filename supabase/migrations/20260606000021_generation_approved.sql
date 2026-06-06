-- Persist QA approval server-side (was localStorage-only) so the bulk tab can
-- cross-reference which SKUs are already approved and filter them out.
ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_generations_user_sku ON generations(user_id, sku) WHERE sku IS NOT NULL;
