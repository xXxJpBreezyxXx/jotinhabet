-- 021: tipo PROTECAO ("proteção de aposta perdida" / cashback da casa).
-- A casa devolve X% da stake se a aposta PERDER (em dinheiro ou em bônus). A
-- perna promocional é dinheiro real como na QUALIFYING, mas a cobertura só
-- precisa recuperar o principal: a devolução sobra como LUCRO. Equalização:
--     aporte = (stake × odd_promo − devolucao_efetiva) / odd_cobertura
-- Bônus não é dinheiro: valor_bonus_pct (default 70%) é a retenção estimada da
-- conversão, e é o valor EFETIVO que entra na conta — equalizar pela face
-- inflaria o cenário de perda com dinheiro que ainda não existe.
ALTER TABLE promo_surebets DROP CONSTRAINT IF EXISTS promo_surebets_promo_type_check;
ALTER TABLE promo_surebets
    ADD CONSTRAINT promo_surebets_promo_type_check
    CHECK (promo_type IN ('FREEBET_SNR', 'QUALIFYING', 'PROTECAO'));

-- Devolução da promoção. cashback = valor de FACE em reais (derivado de
-- cashback_pct × stake, já com cashback_teto aplicado, ou informado direto).
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS cashback NUMERIC(12,2);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS cashback_pct NUMERIC(6,2);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS cashback_teto NUMERIC(12,2);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS cashback_eh_bonus BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS valor_bonus_pct NUMERIC(6,2);

GRANT ALL ON promo_surebets TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
