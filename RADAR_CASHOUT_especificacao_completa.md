# RADAR CASHOUT — Especificação Técnica Completa

Módulo paralelo e isolado do motor de Surebet, focado em Trading Pré-Live via
detecção de Dropping Odds e busca de cotação desregulada (delay de atualização
entre casas "bússola" e casas "alvo").

---

## 1. Estrutura SQL (Supabase / PostgreSQL)

### 1.1 Tabelas base

```sql
-- =========================================================
-- SCHEMA ISOLADO: cashout_*
-- Totalmente separado das tabelas de surebet_*
-- =========================================================

create table if not exists cashout_bookmakers (
    id              uuid primary key default gen_random_uuid(),
    name            text not null unique,               -- 'Pinnacle', 'Bet365', 'Betfair Exchange'...
    bookmaker_type  text not null check (bookmaker_type in ('compass', 'target')),
    -- compass = bússola (linha justa: Pinnacle, Betfair, Matchbook, Bolsa BR)
    -- target  = alvo (casa recreativa: Bet365, Betano, Superbet, KTO, Betnacional)
    avg_update_latency_seconds integer default null,     -- calculado via cashout_outcomes (histórico)
    gubbing_risk_score integer default null,              -- 0-100, opcional: risco de limitação de conta
    active          boolean default true,
    created_at      timestamptz default now()
);

create table if not exists cashout_events (
    id              uuid primary key default gen_random_uuid(),
    sport           text not null,
    league          text,
    home_team       text not null,
    away_team       text not null,
    market          text not null,        -- ex: '1X2', 'Over/Under 2.5', 'Handicap Asiático -1'
    starts_at       timestamptz not null,
    status          text default 'pre_live' check (status in ('pre_live','live','finished','cancelled')),
    created_at      timestamptz default now()
);

-- Série temporal de odds — o coração do módulo (time-series puro)
create table if not exists cashout_odds_snapshots (
    id              bigserial primary key,
    event_id        uuid not null references cashout_events(id) on delete cascade,
    bookmaker_id    uuid not null references cashout_bookmakers(id) on delete cascade,
    selection       text not null,          -- ex: 'home', 'draw', 'away', 'over', 'under'
    odd_value       numeric(8,3) not null,
    implied_prob    numeric(8,6) generated always as (1.0 / nullif(odd_value,0)) stored,
    captured_at     timestamptz not null default now()
);

-- Index crítico: consultas de janela deslizante por evento/casa/seleção
create index if not exists idx_cashout_snapshots_lookup
    on cashout_odds_snapshots (event_id, bookmaker_id, selection, captured_at desc);

-- Oportunidades detectadas pelo algoritmo
create table if not exists cashout_opportunities (
    id                  uuid primary key default gen_random_uuid(),
    event_id            uuid not null references cashout_events(id) on delete cascade,
    selection           text not null,
    target_bookmaker_id uuid not null references cashout_bookmakers(id),

    fair_probability     numeric(8,6) not null,   -- probabilidade de-vigged das bússolas
    target_odd_value     numeric(8,3) not null,   -- odd atrasada capturada no alvo
    target_implied_prob  numeric(8,6) not null,

    gap_pct              numeric(8,4) not null,   -- (fair_prob - target_implied_prob) / target_implied_prob
    slope                numeric(12,8),           -- inclinação da regressão nas bússolas
    r_squared            numeric(6,4),            -- qualidade do ajuste da regressão
    confirming_sources   text[] not null,          -- ex: ['Pinnacle','Betfair Exchange']

    ttl_estimated_seconds integer,                 -- estimado a partir de avg_update_latency das bússolas/alvo
    status                text default 'active' check (status in ('active','expired','converted','invalidated')),

    detected_at           timestamptz default now(),
    expires_at            timestamptz
);

create index if not exists idx_cashout_opportunities_status
    on cashout_opportunities (status, detected_at desc);

-- Backtest / resultado realizado — sem isso não há calibração possível
create table if not exists cashout_outcomes (
    id                  uuid primary key default gen_random_uuid(),
    opportunity_id      uuid not null references cashout_opportunities(id) on delete cascade,

    odd_before          numeric(8,3) not null,
    odd_after           numeric(8,3),               -- odd no alvo N minutos depois
    converged           boolean,                     -- o alvo realmente ajustou na direção prevista?
    gap_realized_pct    numeric(8,4),
    convergence_seconds integer,                     -- tempo real até a casa ajustar

    checked_at          timestamptz default now()
);

create index if not exists idx_cashout_outcomes_opportunity
    on cashout_outcomes (opportunity_id);
```

### 1.2 Função de-vig (remoção do overround) em SQL

```sql
-- Recebe as odds mais recentes de todas as seleções de um mercado numa bússola
-- e devolve a probabilidade "justa" normalizada (soma = 1.0)
create or replace function cashout_devig_market(
    p_event_id uuid,
    p_bookmaker_id uuid,
    p_market_selections text[]   -- ex: array['home','draw','away']
) returns table(selection text, fair_probability numeric) as $$
declare
    v_sum_implied numeric;
begin
    -- pega o snapshot mais recente de cada seleção nessa bússola
    with latest as (
        select distinct on (s.selection)
            s.selection, s.implied_prob
        from cashout_odds_snapshots s
        where s.event_id = p_event_id
          and s.bookmaker_id = p_bookmaker_id
          and s.selection = any(p_market_selections)
        order by s.selection, s.captured_at desc
    )
    select sum(implied_prob) into v_sum_implied from latest;

    return query
    with latest as (
        select distinct on (s.selection)
            s.selection, s.implied_prob
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
```

### 1.3 Regressão linear (slope + R²) sobre janela deslizante

```sql
-- Calcula slope e R² da probabilidade implícita ao longo do tempo
-- para uma seleção específica numa bússola, na janela dos últimos N minutos
create or replace function cashout_trend_regression(
    p_event_id uuid,
    p_bookmaker_id uuid,
    p_selection text,
    p_window_minutes integer default 15
) returns table(slope numeric, r_squared numeric, sample_size integer) as $$
begin
    return query
    with points as (
        select
            extract(epoch from captured_at)::numeric as x,
            implied_prob::numeric as y
        from cashout_odds_snapshots
        where event_id = p_event_id
          and bookmaker_id = p_bookmaker_id
          and selection = p_selection
          and captured_at >= now() - (p_window_minutes || ' minutes')::interval
        order by captured_at asc
    ),
    stats as (
        select
            count(*)::int as n,
            regr_slope(y, x) as slope,
            regr_r2(y, x) as r2
        from points
    )
    select
        coalesce(stats.slope, 0)::numeric,
        coalesce(stats.r2, 0)::numeric,
        stats.n
    from stats;
end;
$$ language plpgsql;
```

---

## 2. Algoritmo de Gatilho (Lógica de Negócio)

### 2.1 Visão matemática resumida

```
1. DE-VIG (por bússola, por mercado):
   fair_prob(selection) = implied_prob(selection) / Σ implied_prob(todas seleções do mercado)

2. TENDÊNCIA (por bússola, janela deslizante de W minutos):
   regressão linear de fair_prob(t) sobre t
   → slope negativo e |slope| acima de threshold = odd caindo (prob subindo, pois prob = 1/odd)
   → r_squared >= R2_MIN (ex: 0.7) = tendência consistente, não ruído

3. CONFIRMAÇÃO MULTI-FONTE:
   tendência só é válida se >= MIN_SOURCES (ex: 2) bússolas confirmarem
   a mesma direção na mesma janela

4. GAP (bússola confirmada vs casa alvo):
   gap_pct = (fair_probability_consenso - target_implied_prob) / target_implied_prob
   → gap_pct positivo e acima de GAP_MIN (ex: 3%) = oportunidade

5. TTL estimado:
   ttl = avg_update_latency_seconds(target_bookmaker) - tempo_desde_confirmacao_da_tendencia
```

### 2.2 Implementação em TypeScript (Edge Function / worker do backend)

```typescript
// cashoutEngine.ts
// Roda a cada ciclo (ex: a cada 5-10s) para eventos pre_live monitorados

interface OddSnapshot {
  bookmakerId: string;
  bookmakerType: 'compass' | 'target';
  selection: string;
  oddValue: number;
  impliedProb: number;
  capturedAt: string;
}

interface CompassTrend {
  bookmakerId: string;
  bookmakerName: string;
  slope: number;
  rSquared: number;
  sampleSize: number;
  fairProbability: number;
  direction: 'falling' | 'rising' | 'flat';
}

const CONFIG = {
  windowMinutes: 15,
  rSquaredMin: 0.7,
  minSlopeAbs: 0.00005,   // sensibilidade mínima da inclinação (ajustar empiricamente)
  minConfirmingSources: 2,
  minGapPct: 0.03,        // 3% de gap mínimo para considerar oportunidade
};

// 1. DE-VIG: normaliza as odds de todas as seleções de um mercado numa bússola
function devigMarket(latestOddsBySelection: Record<string, number>): Record<string, number> {
  const impliedProbs = Object.entries(latestOddsBySelection).map(
    ([selection, odd]) => [selection, 1 / odd] as const
  );
  const sum = impliedProbs.reduce((acc, [, p]) => acc + p, 0);
  return Object.fromEntries(impliedProbs.map(([sel, p]) => [sel, p / sum]));
}

// 2. Regressão linear simples (least squares) — retorna slope e R²
function linearRegression(points: { x: number; y: number }[]): { slope: number; rSquared: number } {
  const n = points.length;
  if (n < 3) return { slope: 0, rSquared: 0 };

  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);

  const meanX = sumX / n;
  const meanY = sumY / n;

  const slope = (sumXY - n * meanX * meanY) / (sumXX - n * meanX * meanX);
  const intercept = meanY - slope * meanX;

  const ssTot = points.reduce((a, p) => a + Math.pow(p.y - meanY, 2), 0);
  const ssRes = points.reduce((a, p) => a + Math.pow(p.y - (slope * p.x + intercept), 2), 0);
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, rSquared };
}

// 3. Avalia tendência de uma bússola para uma seleção específica
function evaluateCompassTrend(
  bookmakerId: string,
  bookmakerName: string,
  history: OddSnapshot[] // já filtrado por bookmaker + selection + janela
): CompassTrend {
  const points = history.map((h) => ({
    x: new Date(h.capturedAt).getTime() / 1000,
    y: h.impliedProb,
  }));

  const { slope, rSquared } = linearRegression(points);

  let direction: CompassTrend['direction'] = 'flat';
  if (rSquared >= CONFIG.rSquaredMin && Math.abs(slope) >= CONFIG.minSlopeAbs) {
    // slope positivo em implied_prob = prob subindo = ODD CAINDO (dropping odd)
    direction = slope > 0 ? 'falling' : 'rising';
    // nota: "falling" aqui se refere à ODD, não à probabilidade
  }

  return {
    bookmakerId,
    bookmakerName,
    slope,
    rSquared,
    sampleSize: points.length,
    fairProbability: points.length ? points[points.length - 1].y : 0,
    direction,
  };
}

// 4. Confirma consenso entre múltiplas bússolas e calcula o gap contra o alvo
function detectOpportunity(
  compassTrends: CompassTrend[],
  targetImpliedProb: number,
  targetBookmakerName: string
): {
  isOpportunity: boolean;
  gapPct: number;
  confirmingSources: string[];
  consensusFairProbability: number;
} {
  const fallingCompasses = compassTrends.filter((c) => c.direction === 'falling');

  if (fallingCompasses.length < CONFIG.minConfirmingSources) {
    return { isOpportunity: false, gapPct: 0, confirmingSources: [], consensusFairProbability: 0 };
  }

  // consenso = média das probabilidades justas das bússolas que confirmaram
  const consensusFairProbability =
    fallingCompasses.reduce((sum, c) => sum + c.fairProbability, 0) / fallingCompasses.length;

  const gapPct = (consensusFairProbability - targetImpliedProb) / targetImpliedProb;

  return {
    isOpportunity: gapPct >= CONFIG.minGapPct,
    gapPct,
    confirmingSources: fallingCompasses.map((c) => c.bookmakerName),
    consensusFairProbability,
  };
}

// 5. Estima o TTL da oportunidade com base na latência histórica do alvo
function estimateTTL(
  targetAvgUpdateLatencySeconds: number | null,
  secondsSinceTrendConfirmed: number
): number {
  const baseline = targetAvgUpdateLatencySeconds ?? 60; // fallback conservador: 60s
  const remaining = baseline - secondsSinceTrendConfirmed;
  return Math.max(remaining, 0);
}
```

### 2.3 Observação sobre calibração

Os thresholds em `CONFIG` (`rSquaredMin`, `minSlopeAbs`, `minGapPct`) **não devem ser
fixos no código para sempre** — eles precisam ser ajustados usando os dados gravados
em `cashout_outcomes`. Rode uma query periódica que cruze `gap_pct` previsto com
`gap_realized_pct` e `converged` para saber que faixa de threshold realmente
antecipa movimentos reais, e não ruído.

---

## 3. Componente React (Tailwind CSS)

Rota isolada, ex: `/radar-cashout`, totalmente separada do módulo de Surebet.

```tsx
// RadarCashoutPage.tsx
import { useEffect, useState } from "react";
import { TrendingDown, Clock, ShieldCheck, AlertTriangle } from "lucide-react";

interface Opportunity {
  id: string;
  eventLabel: string;      // "Time A vs Time B"
  market: string;
  selection: string;
  compassFairOdd: number;       // odd justa implícita (1 / fair_probability)
  targetOdd: number;
  targetBookmakerName: string;
  gapPct: number;
  confirmingSources: string[];
  ttlSeconds: number;
  detectedAt: string;
}

function GapBadge({ gapPct }: { gapPct: number }) {
  const color =
    gapPct >= 0.08 ? "bg-emerald-500" : gapPct >= 0.05 ? "bg-amber-500" : "bg-slate-500";
  return (
    <span className={`${color} text-white text-xs font-semibold px-2 py-1 rounded-full`}>
      +{(gapPct * 100).toFixed(1)}%
    </span>
  );
}

function TTLCountdown({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    setRemaining(seconds);
    const interval = setInterval(() => {
      setRemaining((r) => Math.max(r - 1, 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [seconds]);

  const urgent = remaining <= 15;

  return (
    <div className={`flex items-center gap-1 text-sm ${urgent ? "text-red-500" : "text-slate-400"}`}>
      <Clock size={14} />
      <span>{remaining}s</span>
    </div>
  );
}

function OpportunityCard({ opp }: { opp: Opportunity }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-3 hover:border-emerald-600/50 transition-colors">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-slate-100 font-semibold">{opp.eventLabel}</p>
          <p className="text-slate-400 text-xs">{opp.market} · {opp.selection}</p>
        </div>
        <GapBadge gapPct={opp.gapPct} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/60 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 flex items-center gap-1">
            <ShieldCheck size={12} /> Odd Bússola (justa)
          </p>
          <p className="text-slate-100 text-lg font-bold">{opp.compassFairOdd.toFixed(2)}</p>
        </div>
        <div className="bg-amber-950/40 rounded-lg p-3 border border-amber-800/40">
          <p className="text-[10px] uppercase tracking-wide text-amber-400 flex items-center gap-1">
            <AlertTriangle size={12} /> Odd Desregulada
          </p>
          <p className="text-amber-300 text-lg font-bold">{opp.targetOdd.toFixed(2)}</p>
          <p className="text-[10px] text-amber-500/80 mt-0.5">{opp.targetBookmakerName}</p>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-400">
        <div className="flex items-center gap-1">
          <TrendingDown size={14} className="text-emerald-400" />
          <span>Confirmado por: {opp.confirmingSources.join(", ")}</span>
        </div>
        <TTLCountdown seconds={opp.ttlSeconds} />
      </div>
    </div>
  );
}

export default function RadarCashoutPage() {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // substituir por fetch real ao endpoint / subscription do Supabase
    async function loadOpportunities() {
      setLoading(true);
      // const { data } = await supabase.from('cashout_opportunities').select('*').eq('status','active');
      // setOpportunities(mapToViewModel(data));
      setLoading(false);
    }
    loadOpportunities();
    const interval = setInterval(loadOpportunities, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100">Radar Cashout</h1>
        <p className="text-slate-400 text-sm">
          Rastreamento de tendência (Bússolas) e cotações desreguladas em tempo real.
        </p>
      </header>

      {loading ? (
        <p className="text-slate-500">Carregando oportunidades...</p>
      ) : opportunities.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-500">
          Nenhuma oportunidade ativa no momento. O radar continua monitorando as bússolas.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {opportunities.map((opp) => (
            <OpportunityCard key={opp.id} opp={opp} />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## 4. Checklist de calibração contínua (não esquecer)

- [ ] Rodar `cashout_outcomes` para cada oportunidade disparada (revisitar em N minutos)
- [ ] Recalcular `avg_update_latency_seconds` por bookmaker periodicamente com base nos outcomes
- [ ] Ajustar `rSquaredMin`, `minSlopeAbs` e `minGapPct` usando taxa de acerto real (gap previsto vs realizado)
- [ ] Monitorar `gubbing_risk_score` por casa alvo para não recomendar stakes agressivas em contas já sinalizadas
- [ ] Nunca misturar `cashout_*` com as tabelas `surebet_*` — schemas e rotas devem permanecer 100% isolados
