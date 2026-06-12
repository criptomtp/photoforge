-- ============================================================================
-- O7: drop the dead `batch_jobs` table.
--
-- It was defined in the initial schema (source/total_items/processed_items) but
-- the real bulk pipeline tracks everything on `generations.batch_id`. A grep of
-- app/ and lib/ finds ZERO references to batch_jobs — it is never written or
-- read by any route. Its presence (with its own RLS policies) only creates the
-- false impression that batches live there.
-- ============================================================================

drop table if exists public.batch_jobs cascade;
