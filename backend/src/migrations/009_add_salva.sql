-- 009: oportunidade SALVA pelo usuário (botão de salvar no radar).
-- Uma oportunidade com salva = true NUNCA é removida pelos processos automáticos:
-- limpeza >24h, reconciliação do SureRadar, reconciliação do motor próprio,
-- limpeza de expiradas e o "limpar tudo" do radar. Só o delete individual remove.
-- APLICADA em produção em 17/07/2026 via psql (usuário supabase_admin — o postgres
-- não é dono da tabela): ALTER + GRANT + NOTIFY pgrst.
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS salva boolean NOT NULL DEFAULT false;
GRANT ALL ON oportunidades TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
