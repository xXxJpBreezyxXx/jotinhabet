-- 012: Radar Cashout — schema ISOLADO (cashout_*), 100% separado das tabelas de
-- surebet (oportunidades/operacoes/...). Trading pré-live por Dropping Odds: rastreia
-- a série temporal de odds das casas "bússola" (linha afiada: Pinnacle, Betfair...) e
-- detecta cotação atrasada/desregulada nas casas "alvo" (recreativas: Superbet, Bet365...).
--
-- APLICAR em produção via psql no container afiliadodb_supabase_db, usuário
-- supabase_admin (o postgres não é dono das tabelas). Depois do DDL: GRANT em cada
-- tabela + NOTIFY pgrst (ver memória banco-supabase-selfhosted). Se um write der
-- PGRST204, reiniciar o container afiliadodb_supabase_rest.

-- =========================================================
-- Tabelas base
-- =========================================================

create table if not exists cashout_bookmakers (
    id              uuid primary key default gen_random_uuid(),
    name            text not null unique,               -- 'Pinnacle', 'Superbet', 'Bet365'...
    bookmaker_type  text not null check (bookmaker_type in ('compass', 'target')),
    -- compass = bússola (linha justa: Pinnacle, Betfair, Matchbook)
    -- target  = alvo (casa recreativa: Superbet, Bet365, Betano, KTO, Betnacional)
    avg_update_latency_seconds integer default null,     -- calculado via cashout_outcomes
    gubbing_risk_score integer default null,             -- 0-100, opcional: risco de limitação
    active          boolean default true,
    created_at      timestamptz default now()
);

create table if not exists cashout_events (
    id              uuid primary key default gen_random_uuid(),
    sport           text not null,
    league          text,
    home_team       text not null,
    away_team       text not null,
    market          text not null,        -- normalizado (RESULTADO_FINAL_FT, TOTAIS_GOLS_FT...)
    starts_at       timestamptz,
    status          text default 'pre_live' check (status in ('pre_live','live','finished','cancelled')),
    created_at      timestamptz default now(),
    -- chave natural do evento+mercado (evita duplicar linha a cada ciclo de captura)
    event_key       text unique
);

-- Série temporal de odds — o coração do módulo
create table if not exists cashout_odds_snapshots (
    id              bigserial primary key,
    event_id        uuid not null references cashout_events(id) on delete cascade,
    bookmaker_id    uuid not null references cashout_bookmakers(id) on delete cascade,
    selection       text not null,          -- 'home' | 'away' | 'draw' | 'over' | 'under'
    line            numeric(8,3),           -- linha do mercado (2.5, -1.5...) quando aplicável
    odd_value       numeric(8,3) not null,
    implied_prob    numeric(8,6) generated always as (1.0 / nullif(odd_value,0)) stored,
    captured_at     timestamptz not null default now()
);

create index if not exists idx_cashout_snapshots_lookup
    on cashout_odds_snapshots (event_id, bookmaker_id, selection, captured_at desc);

-- Oportunidades detectadas pelo algoritmo
create table if not exists cashout_opportunities (
    id                  uuid primary key default gen_random_uuid(),
    event_id            uuid not null references cashout_events(id) on delete cascade,
    selection           text not null,
    line                numeric(8,3),
    target_bookmaker_id uuid not null references cashout_bookmakers(id),

    fair_probability     numeric(8,6) not null,   -- probabilidade de-vigged das bússolas
    target_odd_value     numeric(8,3) not null,   -- odd atrasada capturada no alvo
    target_implied_prob  numeric(8,6) not null,

    gap_pct              numeric(8,4) not null,   -- (fair_prob - target_implied_prob) / target_implied_prob
    slope                numeric(12,8),           -- inclinação da regressão nas bússolas
    r_squared            numeric(6,4),            -- qualidade do ajuste
    confirming_sources   text[] not null,         -- ex: ['Pinnacle']

    ttl_estimated_seconds integer,
    status                text default 'active' check (status in ('active','expired','converted','invalidated')),

    detected_at           timestamptz default now(),
    expires_at            timestamptz,
    -- assinatura estável (event_key + selection + line + alvo) p/ dedupe/refresh
    signature             text unique
);

create index if not exists idx_cashout_opportunities_status
    on cashout_opportunities (status, detected_at desc);

-- Campos DESNORMALIZADOS p/ o frontend ler a oportunidade num SELECT plano (sem
-- depender de embedding do PostgREST). Idempotente p/ reaplicar sobre a tabela viva.
alter table cashout_opportunities add column if not exists event_label     text;
alter table cashout_opportunities add column if not exists sport           text;
alter table cashout_opportunities add column if not exists market_label    text;
alter table cashout_opportunities add column if not exists selection_label text;
alter table cashout_opportunities add column if not exists target_name     text;
alter table cashout_opportunities add column if not exists compass_fair_odd numeric(8,3);
alter table cashout_opportunities add column if not exists starts_at       timestamptz;
alter table cashout_opportunities add column if not exists drop_pct        numeric(8,4);

-- Backtest / resultado realizado — base da calibração
create table if not exists cashout_outcomes (
    id                  uuid primary key default gen_random_uuid(),
    opportunity_id      uuid not null references cashout_opportunities(id) on delete cascade,

    odd_before          numeric(8,3) not null,
    odd_after           numeric(8,3),               -- odd no alvo N minutos depois
    converged           boolean,                    -- o alvo ajustou na direção prevista?
    gap_realized_pct    numeric(8,4),
    convergence_seconds integer,

    checked_at          timestamptz default now()
);

create index if not exists idx_cashout_outcomes_opportunity
    on cashout_outcomes (opportunity_id);

-- =========================================================
-- Funções de calibração/backtest (o motor ao vivo calcula em TS por performance;
-- estas ficam pra análise offline sobre o histórico persistido).
-- =========================================================

-- De-vig: normaliza as odds mais recentes de um mercado numa bússola (soma = 1.0).
create or replace function cashout_devig_market(
    p_event_id uuid,
    p_bookmaker_id uuid,
    p_market_selections text[]
) returns table(selection text, fair_probability numeric) as $$
declare
    v_sum_implied numeric;
begin
    with latest as (
        select distinct on (s.selection) s.selection, s.implied_prob
        from cashout_odds_snapshots s
        where s.event_id = p_event_id
          and s.bookmaker_id = p_bookmaker_id
          and s.selection = any(p_market_selections)
        order by s.selection, s.captured_at desc
    )
    select sum(implied_prob) into v_sum_implied from latest;

    return query
    with latest as (
        select distinct on (s.selection) s.selection, s.implied_prob
        from cashout_odds_snapshots s
        where s.event_id = p_event_id
          and s.bookmaker_id = p_bookmaker_id
          and s.selection = any(p_market_selections)
        order by s.selection, s.captured_at desc
    )
    select l.selection, (l.implied_prob / v_sum_implied)::numeric(8,6)
    from latest l;
end;
$$ language plpgsql;

-- Regressão linear (slope + R²) da prob implícita ao longo do tempo, janela de N min.
create or replace function cashout_trend_regression(
    p_event_id uuid,
    p_bookmaker_id uuid,
    p_selection text,
    p_window_minutes integer default 15
) returns table(slope numeric, r_squared numeric, sample_size integer) as $$
begin
    return query
    with points as (
        select extract(epoch from captured_at)::numeric as x, implied_prob::numeric as y
        from cashout_odds_snapshots
        where event_id = p_event_id
          and bookmaker_id = p_bookmaker_id
          and selection = p_selection
          and captured_at >= now() - (p_window_minutes || ' minutes')::interval
        order by captured_at asc
    ),
    stats as (
        select count(*)::int as n, regr_slope(y, x) as slope, regr_r2(y, x) as r2
        from points
    )
    select coalesce(stats.slope, 0)::numeric, coalesce(stats.r2, 0)::numeric, stats.n
    from stats;
end;
$$ language plpgsql;

-- =========================================================
-- Grants (PostgREST self-hosted: sem isto o acesso é negado)
-- =========================================================
grant all on cashout_bookmakers      to postgres, anon, authenticated, service_role;
grant all on cashout_events          to postgres, anon, authenticated, service_role;
grant all on cashout_odds_snapshots  to postgres, anon, authenticated, service_role;
grant all on cashout_opportunities   to postgres, anon, authenticated, service_role;
grant all on cashout_outcomes        to postgres, anon, authenticated, service_role;
grant usage, select on all sequences in schema public to postgres, anon, authenticated, service_role;

notify pgrst, 'reload schema';
