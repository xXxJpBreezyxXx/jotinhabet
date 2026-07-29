-- 020: tipo da promoção (refatoracao promocoes.md). FREEBET_SNR = aposta
-- extra/freebet cuja ficha NÃO retorna no ganho — o custo do lado da promoção
-- é R$ 0 e o investimento real é só a cobertura (o cálculo antigo tratava tudo
-- como dinheiro real e mostrava ROI negativo irreal para freebets).
-- QUALIFYING = aposta qualificativa com dinheiro real (fórmula clássica).
ALTER TABLE promo_surebets
    ADD COLUMN IF NOT EXISTS promo_type TEXT NOT NULL DEFAULT 'FREEBET_SNR'
    CHECK (promo_type IN ('FREEBET_SNR', 'QUALIFYING'));
GRANT ALL ON promo_surebets TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
