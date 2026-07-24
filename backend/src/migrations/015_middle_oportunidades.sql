-- 015: Middles (totais over/under com LINHAS diferentes) — tabela ISOLADA, radar-only.
-- Ex.: Over 2.5 numa casa + Under 3.5 em outra → total=3 ganha as DUAS pernas. O motor
-- de arbitragem NÃO detecta (exige linha idêntica). Detecção em src/arbitrage/valor.ts
-- (encontrarMiddles). Como o value bets: NADA aqui dispara alerta (só alimenta o radar).
--
-- APLICAR via psql no container afiliadodb_supabase_db, usuário supabase_admin. Depois do
-- DDL: GRANTs abaixo + NOTIFY pgrst (ver memória banco-supabase-selfhosted).

create table if not exists middle_oportunidades (
    id             uuid primary key default gen_random_uuid(),
    esporte        text,
    evento         text not null,
    mercado        text not null,             -- rótulo do total (ex.: "Total de Gols")
    mercado_canon  text,

    over_casa      text not null,
    over_odd       numeric(8,3) not null,
    over_linha     numeric(8,3) not null,     -- L1
    under_casa     text not null,
    under_odd      numeric(8,3) not null,
    under_linha    numeric(8,3) not null,     -- L2 > L1

    largura        numeric(8,3),              -- L2 - L1 (janela do middle)
    pior_caso_roi_pct numeric(8,4),           -- >=0: arb garantido + middle; <0: custo se o meio não bater

    starts_at      timestamptz,
    status         text default 'ativa' check (status in ('ativa','expirada','deleted')),
    detected_at    timestamptz default now(),
    visto_em       timestamptz default now(),
    -- assinatura estável: evento base + casa/linha de cada perna.
    signature      text unique
);

create index if not exists idx_middle_status_roi
    on middle_oportunidades (status, pior_caso_roi_pct desc);

grant all on middle_oportunidades to postgres, anon, authenticated, service_role;
grant usage, select on all sequences in schema public to postgres, anon, authenticated, service_role;

notify pgrst, 'reload schema';
