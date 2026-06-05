-- Atomic single-slot update for the QA dashboard (regenerate / delete one photo).
-- Concurrent QA actions on the same generation (different slots clicked in quick
-- succession, or a QA action racing the background worker) used to read-modify-
-- write the whole image_urls/drive_urls arrays in app code → last writer wins,
-- silently dropping the other slot's URL. This serializes via FOR UPDATE and
-- recomputes images_generated, so the write is always consistent.

create or replace function qa_set_slot(
  p_gen_id    uuid,
  p_index     int,
  p_image_url text,
  p_drive_url text
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  imgs text[];
  drv  text[];
  n    int;
begin
  if p_index < 0 then
    raise exception 'index out of range';
  end if;

  select coalesce(image_urls, '{}'), coalesce(drive_urls, '{}')
    into imgs, drv
  from generations
  where id = p_gen_id
  for update;            -- serialize concurrent slot writes on this row

  if not found then
    raise exception 'generation not found';
  end if;

  -- pad to p_index+1 (Postgres arrays are 1-based)
  while coalesce(array_length(imgs, 1), 0) < p_index + 1 loop imgs := array_append(imgs, ''); end loop;
  while coalesce(array_length(drv,  1), 0) < p_index + 1 loop drv  := array_append(drv,  ''); end loop;

  imgs[p_index + 1] := coalesce(p_image_url, '');
  drv [p_index + 1] := coalesce(p_drive_url, '');

  select count(*) into n from unnest(imgs) u where u <> '';

  update generations
     set image_urls = imgs,
         drive_urls = drv,
         images_generated = n
   where id = p_gen_id;

  return n;
end;
$$;

revoke all on function qa_set_slot(uuid, int, text, text) from public, anon, authenticated;
