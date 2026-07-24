-- 016: Calibração do ALERTA de surebet (pré-match). Registra CADA decisão de alerta no
-- ponto de envio — tanto os ENVIADOS quanto os SUPRIMIDOS pela revalidação pré-alerta —
-- com o ROI do scan e o ROI revalidado AO VIVO. Isso mede a precisão do scan (quantas
-- surebets flagradas sobreviveram à revalidação) e o drift de odd, quebrado por
-- confiança / Pinnacle / fonte — pra ajustar os thresholds com dado, não no chute.
--
-- APLICAR via psql no container afiliadodb_supabase_db, usuário supabase_admin. Depois:
-- GRANTs abaixo + NOTIFY pgrst (ver memória banco-supabase-selfhosted).

create table if not exists alerta_log (
    id             uuid primary key default gen_random_uuid(),
    fonte          text,                    -- 'sureradar' | 'motor'
    esporte        text,
    evento         text not null,
    mercado        text,
    casa_a         text,
    casa_b         text,
    opcao_a        text,
    opcao_b        text,
    roi_scan       numeric(8,4),            -- ROI no momento do scan
    roi_revalidado numeric(8,4),            -- ROI recalculado na revalidação AO VIVO (null se não deu p/ calcular)
    odd_a          numeric(8,3),
    odd_b          numeric(8,3),
    confianca      numeric(4,2),
    envolve_pinnacle boolean,
    -- 'enviado': passou no gate + revalidação → WhatsApp disparado
    -- 'suprimido': arb morreu/encolheu na revalidação (falso positivo do scan)
    -- 'nao_verificado': falha de INFRA na revalidação (casa/túnel fora) — fora da precisão
    resultado      text not null check (resultado in ('enviado','suprimido','nao_verificado')),
    motivo         text,                    -- motivo da supressão (quando aplicável)
    starts_at      timestamptz,
    -- desfecho de LIQUIDAÇÃO (opcional, preenchido depois): green/red/void/expirado
    desfecho       text,
    desfecho_em    timestamptz,
    created_at     timestamptz default now()
);

create index if not exists idx_alerta_log_created on alerta_log (created_at desc);

grant all on alerta_log to postgres, anon, authenticated, service_role;
grant usage, select on all sequences in schema public to postgres, anon, authenticated, service_role;

notify pgrst, 'reload schema';
