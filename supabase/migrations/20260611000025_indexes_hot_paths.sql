-- ============================================================================
-- O5 / O6: indexes for the hottest query patterns.
--
-- 1) Every money-spending route runs a per-user rate-limit check
--      SELECT count(*) FROM generations WHERE user_id = ? AND created_at >= ?
--    before each generation, and History/Dashboard list a user's rows ordered
--    by created_at. No index covered (user_id, created_at) — only (user_id, sku),
--    batch, and the queue partial index existed.
-- 2) The token ledger page and Stripe webhook look up token_transactions by
--    user_id ordered by created_at, with no index at all on that table.
-- ============================================================================

create index if not exists idx_generations_user_created
  on public.generations (user_id, created_at desc);

create index if not exists idx_token_tx_user_created
  on public.token_transactions (user_id, created_at desc);
