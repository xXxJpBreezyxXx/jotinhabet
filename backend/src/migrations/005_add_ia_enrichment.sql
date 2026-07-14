-- 005_add_ia_enrichment.sql
-- Colunas para o enriquecimento assíncrono de risco por IA.
-- ia_status: 'pendente' | 'processando' | 'concluido' | 'erro'
-- ia_risco:  'ok' | 'atencao' | 'critico' (nível para o badge do frontend)
-- ia_veredito: veredito estruturado completo { nivel_risco, tipo, motivo, confianca, fonte }

ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS ia_status TEXT DEFAULT 'pendente';
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS ia_risco TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS ia_veredito JSONB;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS ia_enriquecido_em TIMESTAMPTZ;

-- Índice para o worker buscar rapidamente os itens pendentes.
CREATE INDEX IF NOT EXISTS idx_oportunidades_ia_status ON oportunidades (ia_status);
