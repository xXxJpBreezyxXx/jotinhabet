-- 008_add_app_config.sql
-- Tabela genérica de configuração (chave/valor) para estado do app que precisa
-- sobreviver ao navegador — 1º uso: banca ativa (antes só no localStorage).
-- APLICADA em 2026-07-16 direto no container afiliadodb_supabase_db (a DATABASE_URL
-- do .env está com credencial inválida; ver memória do projeto).

CREATE TABLE IF NOT EXISTS app_config (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Permissões no padrão das demais tabelas expostas via PostgREST (self-hosted).
GRANT ALL ON app_config TO postgres, anon, authenticated, service_role;

-- Recarrega o schema cache do PostgREST (sem isto, a REST API dá PGRST205 até reiniciar).
NOTIFY pgrst, 'reload schema';
