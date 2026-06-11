-- ============================================================================
-- C1 (CRITICAL): close the monetization bypass via direct PostgREST RPC.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
-- exposes SECURITY DEFINER functions in the `public` schema as RPC for the
-- `anon` / `authenticated` roles. The token/quota functions below were never
-- revoked, so ANY logged-in user could call e.g.
--   POST /rest/v1/rpc/credit_tokens_tx { p_user_id: <self>, p_amount: 999999 }
-- and grant themselves unlimited tokens, drain another user's balance, or reset
-- a free-quota counter. The 2026-05 hardening closed the TABLE path (guard
-- trigger + dropped INSERT policy) but left this FUNCTION path open.
--
-- These functions are only ever invoked server-side via the service-role admin
-- client (which is NOT affected by `REVOKE ... FROM public, anon, authenticated`
-- — same proven pattern already used for qa_set_slot / claim_generation /
-- reap_orphans in earlier migrations). Before this migration, the two functions
-- that WERE called from the authenticated client (try_consume_free_generation,
-- increment_generations_used) are switched to the admin client in the same PR.
--
-- is_admin() is intentionally NOT revoked: it is evaluated inside RLS policies
-- as the querying role, so `authenticated` must keep EXECUTE on it.
-- ============================================================================

revoke all on function public.credit_tokens(uuid, numeric)                         from public, anon, authenticated;
revoke all on function public.deduct_tokens(uuid, numeric)                         from public, anon, authenticated;
revoke all on function public.credit_tokens_tx(uuid, numeric, text, text, uuid)    from public, anon, authenticated;
revoke all on function public.deduct_tokens_tx(uuid, numeric, text, text, uuid)    from public, anon, authenticated;
revoke all on function public.clamp_debit_tokens(uuid, numeric, text, text)        from public, anon, authenticated;
revoke all on function public.try_consume_free_generation(uuid)                    from public, anon, authenticated;
revoke all on function public.restore_free_generation(uuid)                        from public, anon, authenticated;
revoke all on function public.increment_generations_used(uuid)                     from public, anon, authenticated;
