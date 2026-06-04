-- Product category per generation (clothing/shoes/jewelry/accessories/object).
-- Nullable + default keeps existing rows valid; the app always writes it going forward.
ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'clothing';
