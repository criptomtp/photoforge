-- Bulk generation: tag each generation with its batch + source SKU, and store an
-- optional AI listing (title/description/bullets/tags) alongside the images.
ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS batch_id text,
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS listing jsonb;

CREATE INDEX IF NOT EXISTS idx_generations_batch
  ON generations(batch_id) WHERE batch_id IS NOT NULL;
