-- Fix qa_set_slot: drive_urls is a JSONB column, but the original (migration 014)
-- read it into a text[] variable → "malformed array literal" at runtime. That
-- broke both the QA regenerate/delete actions AND the worker (which now writes
-- each photo slot through this RPC). image_urls stays text[]; drive_urls handled
-- as a jsonb array of strings.

CREATE OR REPLACE FUNCTION qa_set_slot(
  p_gen_id    uuid,
  p_index     int,
  p_image_url text,
  p_drive_url text
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  imgs text[];
  drv  jsonb;
  n    int;
BEGIN
  IF p_index < 0 THEN RAISE EXCEPTION 'index out of range'; END IF;

  SELECT coalesce(image_urls, '{}'::text[]), coalesce(drive_urls, '[]'::jsonb)
    INTO imgs, drv
  FROM generations
  WHERE id = p_gen_id
  FOR UPDATE;                       -- serialize concurrent slot writes on this row

  IF NOT FOUND THEN RAISE EXCEPTION 'generation not found'; END IF;

  -- image_urls: text[] (1-based)
  WHILE coalesce(array_length(imgs, 1), 0) < p_index + 1 LOOP imgs := array_append(imgs, ''); END LOOP;
  imgs[p_index + 1] := coalesce(p_image_url, '');

  -- drive_urls: jsonb array of strings (0-based path)
  WHILE jsonb_array_length(drv) < p_index + 1 LOOP drv := drv || to_jsonb(''::text); END LOOP;
  drv := jsonb_set(drv, ARRAY[p_index::text], to_jsonb(coalesce(p_drive_url, '')), true);

  SELECT count(*) INTO n FROM unnest(imgs) u WHERE u <> '';

  UPDATE generations
     SET image_urls = imgs,
         drive_urls = drv,
         images_generated = n
   WHERE id = p_gen_id;

  RETURN n;
END $$;

REVOKE ALL ON FUNCTION qa_set_slot(uuid, int, text, text) FROM public, anon, authenticated;
