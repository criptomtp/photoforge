-- Give back a free-quota slot when a run produced zero result (prompt failure or
-- all images failed). Without this, a quota-throttled run silently burns the
-- user's monthly free allowance for nothing.
create or replace function public.restore_free_generation(p_user_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.profiles
     set generations_used = greatest(0, generations_used - 1)
   where id = p_user_id;
$$;
