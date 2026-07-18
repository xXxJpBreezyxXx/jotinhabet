-- 010: origem EXPLÍCITA da oportunidade. Hoje gravada apenas pela fonte
-- 'telegram' (sinais de grupo extraídos por IA de visão) — sem backfill: os
-- fluxos existentes continuam inferindo origem por url ILIKE '%sureradar%'
-- (scanner_v2, revalidationService, frontend), e linhas do motor/SureRadar
-- ficam com fonte NULL de propósito.
-- APLICADA em produção em 17/07/2026 via psql (usuário supabase_admin — o
-- postgres não é dono da tabela): ALTER + INDEX + GRANT + NOTIFY pgrst.
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS fonte TEXT;
CREATE INDEX IF NOT EXISTS idx_oportunidades_fonte ON oportunidades (fonte);
GRANT ALL ON oportunidades TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
