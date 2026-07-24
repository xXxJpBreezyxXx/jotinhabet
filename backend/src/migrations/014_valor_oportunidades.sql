-- 014: Value bets (+EV) — tabela ISOLADA das surebets (oportunidades/operacoes/...).
-- Aposta de VALOR = odd de casa SOFT acima da JUSTA sem-vig da casa de referência
-- sharp (Pinnacle). Detecção em src/arbitrage/valor.ts (encontrarValor). RADAR-ONLY
-- por decisão de produto (23/07/2026): NADA aqui dispara alerta no WhatsApp — a
-- separação em tabela própria garante isso por design (o gate de alerta de arb só
-- olha a tabela `oportunidades`).
--
-- APLICAR em produção via psql no container afiliadodb_supabase_db, usuário
-- supabase_admin (o postgres não é dono das tabelas). Depois do DDL: os GRANTs abaixo
-- + NOTIFY pgrst (ver memória banco-supabase-selfhosted). Se um write der PGRST204,
-- reiniciar o container afiliadodb_supabase_rest.

create table if not exists valor_oportunidades (
    id             uuid primary key default gen_random_uuid(),
    esporte        text,
    evento         text not null,             -- rótulo "Time A vs Time B (DD/MM/AAAA HH:MM)"
    mercado        text not null,             -- rótulo cru da casa soft
    mercado_canon  text,                      -- normalizado (RESULTADO_FINAL_FT, TOTAIS_GOLS_FT...)
    linha          numeric(8,3),              -- linha do mercado (2.5, -1.5...) quando aplicável

    casa           text not null,             -- casa SOFT onde está o valor
    opcao          text not null,             -- seleção com valor (rótulo da casa soft)
    odd_casa       numeric(8,3) not null,     -- odd da casa soft

    fair_odd       numeric(8,3) not null,     -- odd justa (de-vig da referência)
    prob_real      numeric(8,6) not null,     -- probabilidade real estimada [0..1]
    edge_pct       numeric(8,4) not null,     -- edge de EV (%) = (odd_casa*prob_real - 1)*100

    referencia     text not null,             -- casa de referência (ex.: 'Pinnacle')
    odd_ref_a      numeric(8,3),              -- odds da referência (lados A/B) — auditoria
    odd_ref_b      numeric(8,3),
    confianca      numeric(4,2),              -- 0..1 — força do casamento de times

    starts_at      timestamptz,               -- início da partida (quando conhecido)
    status         text default 'ativa' check (status in ('ativa','expirada','deleted')),

    detected_at    timestamptz default now(),
    visto_em       timestamptz default now(), -- última vez re-detectada (idade da odd)
    -- assinatura estável p/ dedupe/refresh: evento_base + mercado_canon + linha + casa + opção.
    signature      text unique
);

create index if not exists idx_valor_status_edge
    on valor_oportunidades (status, edge_pct desc);

-- =========================================================
-- Grants (PostgREST self-hosted: sem isto o acesso é negado)
-- =========================================================
grant all on valor_oportunidades to postgres, anon, authenticated, service_role;
grant usage, select on all sequences in schema public to postgres, anon, authenticated, service_role;

notify pgrst, 'reload schema';
