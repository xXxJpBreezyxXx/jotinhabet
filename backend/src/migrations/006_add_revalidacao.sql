-- 006_add_revalidacao.sql
-- Revalidação de odds (requisito §6 do kickoff): guarda a última reconsulta da odd
-- e a classificação do movimento (IA).
-- revalidacao (JSONB): { checado_em, fonte, odd_a, odd_b, roi_anterior, roi_atual, status, movimento }
--   status: 'ok' | 'reduzida' | 'melhorou' | 'expirada' | 'nao_encontrada' | 'nao_suportado' | 'erro'

ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS revalidado_em TIMESTAMPTZ;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS revalidacao JSONB;
