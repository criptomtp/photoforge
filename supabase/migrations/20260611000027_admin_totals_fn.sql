-- ============================================================================
-- O4: replace the admin-analytics full-table scan with a SQL aggregate.
--
-- app/admin/analytics/page.tsx loaded EVERY generations row into Node memory
-- (`.select("status, images_generated")` with no limit) and counted with JS
-- filter/reduce. This function does the aggregation in Postgres and returns a
-- single row. Called only from the admin page via the service-role client.
-- ============================================================================

create or replace function public.generation_totals()
returns table (total bigint, done bigint, error bigint, images bigint)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    count(*)                                         as total,
    count(*) filter (where status = 'done')          as done,
    count(*) filter (where status = 'error')         as error,
    coalesce(sum(images_generated), 0)               as images
  from public.generations;
$$;

revoke all on function public.generation_totals() from public, anon, authenticated;
