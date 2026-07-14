-- 007_add_visto_em.sql
-- "Visto por último": atualizado a cada re-scan que reconfirma a surebet no SureRadar.
-- A idade da odd passa a refletir a ÚLTIMA vez que a surebet foi vista, e não a 1ª detecção
-- (o SureRadar atualiza a cada ~10 min; o dedup do scanner mantinha detectada_em antigo).

ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS visto_em TIMESTAMPTZ DEFAULT now();
