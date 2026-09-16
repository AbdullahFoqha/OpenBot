ALTER TABLE studio_products ADD COLUMN IF NOT EXISTS is_selected boolean NOT NULL DEFAULT false;
UPDATE studio_products SET is_selected = true WHERE id = 'studio-local' AND local_path IS NOT NULL;
