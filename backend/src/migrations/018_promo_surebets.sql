-- 018: histórico de surebets de PROMOÇÃO (inserção manual pelo usuário).
-- Registra o lucro extraído de promoções das casas (freebet/superodd/cashback):
-- a perna da promoção numa casa + a cobertura na outra. Vive fora do radar e
-- NÃO mexe na banca ativa — é um histórico contábil à parte, com ROI próprio.
CREATE TABLE IF NOT EXISTS promo_surebets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    casa_promocao TEXT NOT NULL,
    valor_promocao NUMERIC(12,2) NOT NULL,
    evento TEXT NOT NULL,
    mercado TEXT,
    casa_cobertura TEXT NOT NULL,
    valor_cobertura NUMERIC(12,2) NOT NULL,
    roi_pct NUMERIC(8,2),
    lucro NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_surebets_criado_em ON promo_surebets (criado_em DESC);
GRANT ALL ON promo_surebets TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
