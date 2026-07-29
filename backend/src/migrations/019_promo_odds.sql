-- 019: odds das duas pernas da surebet de promoção. Com odd + valor de cada
-- perna o lucro é derivável (pior cenário: min entre "promoção ganha" e
-- "cobertura ganha") e o ROI sai de lucro/investido — o usuário só digita
-- lucro/ROI se quiser sobrescrever (ex.: freebet que não devolve a stake).
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS odd_promocao NUMERIC(8,3);
ALTER TABLE promo_surebets ADD COLUMN IF NOT EXISTS odd_cobertura NUMERIC(8,3);
GRANT ALL ON promo_surebets TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
