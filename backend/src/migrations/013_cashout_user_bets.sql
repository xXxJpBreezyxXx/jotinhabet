-- 013: Radar Cashout — apostas do USUÁRIO ("Minha aposta").
-- Enquanto cashout_opportunities é o scanner AUTOMÁTICO (bússola × alvo), esta tabela
-- guarda a aposta que a PESSOA já fez (casa, seleção, odd de entrada, stake) para o
-- monitor por-aposta (cashoutBetMonitor) rastrear AO VIVO quanto ela vale e sinalizar
-- a hora de sacar. Schema isolado, no mesmo cluster cashout_*.
--
-- APLICAR em produção via psql no container afiliadodb_supabase_db, usuário
-- supabase_admin (o postgres não é dono das tabelas). Depois do DDL: os GRANTs abaixo
-- + NOTIFY pgrst. Se um write der PGRST204, reiniciar o container afiliadodb_supabase_rest.
-- (Ver memória banco-supabase-selfhosted.)

create table if not exists cashout_user_bets (
    id              uuid primary key default gen_random_uuid(),

    -- Identidade da aposta (o que o usuário travou)
    casa            text not null,          -- casa ALVO onde apostou (ex.: 'KTO', 'Betano')
    sport           text not null,          -- 'Futebol' | 'Basquete' | 'Tenis' | 'Esports'
    event_label     text not null,          -- "Time A vs Time B"
    market_label    text not null,          -- rótulo humano (ex.: "Resultado Final")
    market_norm     text not null,          -- mercado normalizado (RESULTADO_FINAL_FT...)
    selection       text not null check (selection in ('home','away','draw','over','under')),
    selection_label text,                   -- rótulo humano da seleção
    line            numeric(8,3),           -- linha (2.5, -1.5...) quando aplicável
    odd_entrada     numeric(8,3) not null,  -- odd DECIMAL travada na entrada
    stake           numeric(12,2),          -- valor apostado (opcional; %s valem sem ele)
    starts_at       timestamptz,            -- kickoff, quando conhecido

    status          text not null default 'open'
                    check (status in ('open','cashed','settled','deleted')),

    -- Última avaliação AO VIVO gravada pelo monitor (p/ o frontend ler num SELECT plano)
    last_fair_prob     numeric(8,6),
    last_fair_odd      numeric(8,3),        -- odd justa ao vivo (bússola de-vigged)
    last_house_odd     numeric(8,3),        -- odd atual da MESMA seleção na casa
    last_cashout_value numeric(12,2),       -- estimativa da oferta de saque da casa
    last_profit        numeric(12,2),       -- lucro travado estimado (saque - stake)
    last_drop_pct      numeric(8,4),        -- queda da odd desde a entrada (>0 = caiu)
    last_signal        boolean,             -- true = "hora de sacar"
    last_note          text,                -- ex.: "bússola indisponível", "fora do ar ao vivo"
    last_eval_at       timestamptz,

    created_at      timestamptz default now(),
    updated_at      timestamptz default now()
);

create index if not exists idx_cashout_user_bets_status
    on cashout_user_bets (status, created_at desc);

-- =========================================================
-- Grants (PostgREST self-hosted: sem isto o acesso é negado)
-- =========================================================
grant all on cashout_user_bets to postgres, anon, authenticated, service_role;
grant usage, select on all sequences in schema public to postgres, anon, authenticated, service_role;

notify pgrst, 'reload schema';
