-- Persist the per-image prompts (aligned by index with image_urls) so the UI can
-- show "what created each photo" and the regenerate button can re-run one prompt.
alter table public.generations
  add column if not exists prompts text[];
