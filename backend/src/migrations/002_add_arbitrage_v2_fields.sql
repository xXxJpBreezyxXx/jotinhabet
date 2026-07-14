-- 002_add_arbitrage_v2_fields.sql

ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS casa_a_nome TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS casa_b_nome TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS opcao_a TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS opcao_b TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS mercado TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS analise_ia TEXT;
