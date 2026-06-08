-- Add 'draft' status for the step-by-step card mode: products are enqueued as
-- drafts the worker IGNORES, and generated one at a time on demand.
ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_status_check;
ALTER TABLE generations ADD CONSTRAINT generations_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'queued'::text, 'processing'::text, 'done'::text, 'error'::text]));
