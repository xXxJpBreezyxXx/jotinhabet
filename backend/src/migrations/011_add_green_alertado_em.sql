-- 011: acompanhamento pós-partida das ENTRADAS. Marca quando o WhatsApp de GREEN
-- (parabéns + lucro + banca) já foi enviado para a entrada — NULL = ainda não
-- alertada. O GreenMonitorService (a cada 15 min) alerta as entradas cujo jogo
-- terminou (kickoff do evento + margem) e marca aqui; entradas cujo jogo terminou
-- há >24h (backlog do 1º deploy) são marcadas em silêncio (sem WhatsApp).
-- APLICAR em produção via psql (usuário supabase_admin — o postgres não é dono da
-- tabela): ALTER + GRANT + NOTIFY pgrst (ver banco-supabase-selfhosted).
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS green_alertado_em TIMESTAMP WITH TIME ZONE;
GRANT ALL ON operacoes TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
