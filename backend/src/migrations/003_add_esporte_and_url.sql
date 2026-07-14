-- 003_add_esporte_and_url.sql

ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS esporte TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS url TEXT;
