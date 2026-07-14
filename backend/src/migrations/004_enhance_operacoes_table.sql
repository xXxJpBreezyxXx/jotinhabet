-- 004_enhance_operacoes_table.sql
-- Adiciona campos completos à tabela de operacoes para persistência independente das oportunidades

ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS evento TEXT;
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS mercado TEXT;
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS casa_a TEXT;
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS casa_b TEXT;
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS opcao_a TEXT;
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS opcao_b TEXT;
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS odd_a NUMERIC(6,3);
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS odd_b NUMERIC(6,3);
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS roi NUMERIC(5,2);
