-- 017: links diretos do grupo do Telegram na oportunidade. Antes os links
-- colhidos das mensagens de contexto só iam pro alerta do WhatsApp e eram
-- descartados (url ficava NULL fixo) — o frontend nunca via link nenhum.
--  · url_casa_1/url_casa_2: link casado com a casa de cada perna;
--  · links_grupo: TODOS os links colhidos, como [{"url": "...", "casa": "..."|null}]
--    (inclui os que não casaram com perna nenhuma).
-- A coluna url (legada) segue intocada — o scanner_v2 usa url para inferir
-- SureRadar e para a limpeza do motor próprio.
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS url_casa_1 TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS url_casa_2 TEXT;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS links_grupo JSONB;
GRANT ALL ON oportunidades TO postgres, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
