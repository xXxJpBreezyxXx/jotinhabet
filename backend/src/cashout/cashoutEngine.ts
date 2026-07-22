// cashoutEngine.ts
// Motor do Radar Cashout — funções PURAS (sem I/O), testáveis isoladamente.
//
// Estratégia (Dropping Odds / cotação desregulada):
//   1. DE-VIG por bússola: remove a margem da casa afiada p/ obter a probabilidade
//      "justa" de cada seleção. Como o modelo de odds do projeto é 2-vias (ScrapedOdd
//      opcaoA/opcaoB), o de-vig é feito dentro do par.
//   2. TENDÊNCIA: regressão linear da prob justa ao longo do tempo (janela deslizante).
//      prob subindo (slope>0) = ODD CAINDO = "dropping odd" = dinheiro entrando naquele lado.
//   3. CONSENSO: a tendência só vale se >= minConfirmingSources bússolas concordarem.
//   4. GAP vs ALVO: gap = (fairProb_consenso - 1/oddAlvo) / (1/oddAlvo). Isso É o EV
//      da aposta naquele lado no alvo (gap 3% = 3% de valor esperado). gap>0 = o alvo
//      ainda paga uma odd generosa que a linha afiada já não paga.
//   5. TTL: quanto tempo o alvo tende a levar p/ ajustar (latência histórica do alvo).

export type CashoutSelection = 'home' | 'away' | 'draw' | 'over' | 'under';

export interface CashoutConfig {
  windowMinutes: number;     // janela da série temporal
  rSquaredMin: number;       // R² mínimo p/ ROTULAR a tendência como limpa (só métrica)
  minSlopeAbs: number;       // |slope| mínimo (sensibilidade) — em prob/segundo
  minSampleSize: number;     // pontos mínimos p/ a estimativa da bússola ser confiável
  minConfirmingSources: number; // nº de bússolas (com estimativa válida) exigidas
  minDropPct: number;        // queda MÍNIMA da odd afiada na janela (0.03 = odd caiu 3%)
  minGapPct: number;         // lag MÍNIMO do alvo vs a justa afiada (0.03 = 3%)
}

// MODELO CASHOUT (Dropping Odds): a oportunidade só dispara quando a odd na LINHA AFIADA
// CAIU na janela (a seleção ficou mais provável) E o ALVO ainda paga a odd antiga/alta
// (lag). Você pega o alvo atrasado numa odd que está descendo → tende a cair no alvo
// também → cashout. Exigir a QUEDA (direção) exclui "valores" que revertem (ex.: Eva
// Lopez, cuja odd na verdade subiu). minConfirmingSources=1 porque a única bússola hoje é
// a Pinnacle (ver pinnacle-asn-bloqueio). Thresholds calibráveis via env.
export const CASHOUT_CONFIG: CashoutConfig = {
  windowMinutes: 15,
  rSquaredMin: 0.7,
  minSlopeAbs: 0.00005,
  minSampleSize: 3,
  minConfirmingSources: 1,
  minDropPct: 0.02,
  minGapPct: 0.03,
};

/** Um ponto da série temporal: prob justa (de-vigged) de UMA seleção num instante. */
export interface OddPoint {
  tSeconds: number;    // epoch em segundos
  fairProb: number;    // prob justa (0..1) após de-vig
}

export type OddDirection = 'dropping' | 'lengthening' | 'flat';

export interface CompassTrend {
  bookmakerName: string;
  slope: number;         // slope da prob justa vs tempo (prob/segundo)
  rSquared: number;
  sampleSize: number;
  fairProbability: number; // prob justa mais recente
  dropPct: number;       // queda da odd justa na janela (mais antigo → agora); >0 = odd caiu
  oddDirection: OddDirection; // direção da ODD (dropping = odd caindo = prob subindo)
}

/**
 * De-vig de um mercado 2-vias: recebe as odds crua das duas seleções e devolve as
 * probabilidades justas (normalizadas, somam 1). null se alguma odd for inválida.
 */
export function devig2Way(oddA: number, oddB: number): { probA: number; probB: number } | null {
  if (!Number.isFinite(oddA) || !Number.isFinite(oddB) || oddA <= 1 || oddB <= 1) return null;
  const iA = 1 / oddA;
  const iB = 1 / oddB;
  const soma = iA + iB;
  if (soma <= 0) return null;
  return { probA: iA / soma, probB: iB / soma };
}

/** Regressão linear (mínimos quadrados). Retorna slope, R² e intercepto. */
export function linearRegression(
  points: { x: number; y: number }[]
): { slope: number; rSquared: number; intercept: number } {
  const n = points.length;
  if (n < 3) return { slope: 0, rSquared: 0, intercept: n ? points[0].y : 0 };

  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);

  const meanX = sumX / n;
  const meanY = sumY / n;

  const denom = sumXX - n * meanX * meanX;
  if (Math.abs(denom) < 1e-12) return { slope: 0, rSquared: 0, intercept: meanY };

  const slope = (sumXY - n * meanX * meanY) / denom;
  const intercept = meanY - slope * meanX;

  const ssTot = points.reduce((a, p) => a + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, rSquared, intercept };
}

/**
 * Avalia a tendência de UMA bússola p/ UMA seleção, sobre o histórico (já filtrado
 * na janela). Classifica a direção da ODD: prob justa subindo consistentemente
 * (slope>0, R²>=min, |slope|>=min) = odd caindo = 'dropping'.
 */
export function evaluateCompassTrend(
  bookmakerName: string,
  history: OddPoint[],
  cfg: CashoutConfig = CASHOUT_CONFIG
): CompassTrend {
  const points = history.map((h) => ({ x: h.tSeconds, y: h.fairProb }));
  const { slope, rSquared } = linearRegression(points);

  // Queda da ODD justa na janela: compara a odd mais ANTIGA com a mais RECENTE.
  // fairOdd = 1/fairProb; dropPct>0 = a odd caiu (prob subiu) = sinal de cashout.
  const yOldest = points.length ? points[0].y : 0;
  const yNow = points.length ? points[points.length - 1].y : 0;
  let dropPct = 0;
  if (yOldest > 0 && yNow > 0) {
    const oddOldest = 1 / yOldest;
    const oddNow = 1 / yNow;
    dropPct = (oddOldest - oddNow) / oddOldest;
  }

  let oddDirection: OddDirection = 'flat';
  if (points.length >= 3 && Math.abs(dropPct) >= 0.005) {
    oddDirection = dropPct > 0 ? 'dropping' : 'lengthening';
  }

  return {
    bookmakerName,
    slope,
    rSquared,
    sampleSize: points.length,
    fairProbability: yNow,
    dropPct,
    oddDirection,
  };
}

export interface OpportunityDetection {
  isOpportunity: boolean;
  gapPct: number;                 // lag do alvo vs a justa afiada (= EV imediato)
  dropPct: number;                // queda média da odd afiada na janela (>0 = caiu)
  confirmingSources: string[];    // bússolas com estimativa válida usadas no consenso
  consensusFairProbability: number;
  trending: boolean;              // a odd afiada está caindo o suficiente (>= minDropPct)
}

/**
 * MODELO CASHOUT: consenso das bússolas com estimativa ESTÁVEL. Dispara quando a odd
 * afiada CAIU na janela (dropPct >= minDropPct) E o alvo ainda paga acima da justa
 * (gap >= minGapPct). targetImpliedProb = 1/oddAlvo (CRUA). Exigir a queda dá a DIREÇÃO
 * do cashout (a odd tende a descer também no alvo) e exclui "valores" que revertem.
 */
export function detectOpportunity(
  compassTrends: CompassTrend[],
  targetImpliedProb: number,
  cfg: CashoutConfig = CASHOUT_CONFIG
): OpportunityDetection {
  const validos = compassTrends.filter((c) => c.sampleSize >= cfg.minSampleSize);
  const vazio: OpportunityDetection = {
    isOpportunity: false, gapPct: 0, dropPct: 0, confirmingSources: [], consensusFairProbability: 0, trending: false,
  };
  if (validos.length < cfg.minConfirmingSources) return vazio;
  if (!Number.isFinite(targetImpliedProb) || targetImpliedProb <= 0) return vazio;

  const consensusFairProbability =
    validos.reduce((s, c) => s + c.fairProbability, 0) / validos.length;
  const consensusDrop = validos.reduce((s, c) => s + c.dropPct, 0) / validos.length;

  const gapPct = (consensusFairProbability - targetImpliedProb) / targetImpliedProb;
  const caindo = consensusDrop >= cfg.minDropPct;

  return {
    isOpportunity: caindo && gapPct >= cfg.minGapPct,
    gapPct,
    dropPct: consensusDrop,
    confirmingSources: validos.map((c) => c.bookmakerName),
    consensusFairProbability,
    trending: caindo,
  };
}

/**
 * Estima o TTL da oportunidade: quanto ainda resta da latência típica do alvo até
 * ele ajustar. Fallback conservador de 60s quando não há latência histórica.
 */
export function estimateTTL(
  targetAvgUpdateLatencySeconds: number | null,
  secondsSinceTrendConfirmed: number
): number {
  const baseline = targetAvgUpdateLatencySeconds ?? 60;
  return Math.max(baseline - secondsSinceTrendConfirmed, 0);
}

// ============================================================================
// CASHOUT DE UMA APOSTA JÁ FEITA (rastreio "Minha aposta")
// ----------------------------------------------------------------------------
// Diferente do scanner de oportunidades (bússola × alvo), aqui o usuário TEM uma
// aposta travada (odd de entrada) e quer saber, AO VIVO, quanto ela vale e se é
// hora de sacar. A referência de valor é a prob JUSTA ao vivo da bússola.
//
// ⚠️ A casa (KTO/Betano/bet365) calcula a oferta de cashout internamente e NÃO
// dá pra ler o valor do botão pelos feeds; entregamos (a) o valor JUSTO da posição
// (decisão) e (b) uma ESTIMATIVA da oferta da casa a partir da odd ao vivo da mesma
// seleção. hedgeToLock é a alternativa sem depender do botão: bancar o lado oposto.
// ============================================================================

export interface CashoutPosition {
  stake: number;                 // valor apostado (0 quando não informado — %s ainda valem)
  oddEntrada: number;            // odd decimal travada na entrada
  fairProbNow: number;           // prob JUSTA ao vivo (de-vigged da bússola), 0..1
  oddCasaNow?: number | null;    // odd atual da MESMA seleção na casa (p/ estimar a oferta)
  oddOpostoNow?: number | null;  // odd atual do lado OPOSTO (p/ hedge/greenup)
}

export interface CashoutEstimateConfig {
  houseMargin: number;   // haircut aplicado à oferta estimada da casa (0.06 = -6%)
  signalDropPct: number; // queda mínima da odd desde a entrada p/ sinalizar "sacar"
}

// Defaults calibráveis por env (o monitor passa os overrides).
export const CASHOUT_ESTIMATE_CONFIG: CashoutEstimateConfig = {
  houseMargin: 0.06,
  signalDropPct: 0.05,
};

export interface HedgeSuggestion {
  oddOposto: number;
  stakeHedge: number;    // quanto bancar no lado oposto p/ igualar o retorno
  lucroTravado: number;  // lucro garantido em QUALQUER resultado (mesma unidade do stake)
}

export interface CashoutEstimate {
  valida: boolean;
  fairProbNow: number;
  fairOddNow: number;           // 1/fairProbNow (odd justa ao vivo)
  dropPctSinceEntry: number;    // (oddEntrada - fairOddNow)/oddEntrada; >0 = odd CAIU (bom p/ back)
  fairValue: number;            // stake * oddEntrada * fairProbNow (valor verdadeiro da posição)
  fairProfit: number;           // fairValue - stake
  houseCashout: number | null;  // estimativa da oferta da casa (null sem oddCasaNow)
  houseProfit: number | null;   // houseCashout - stake
  emLucro: boolean;             // a odd afiada caiu abaixo da de entrada (posição no lucro)
  sacarAgora: boolean;          // sinal: a odd caiu o suficiente desde a entrada
  hedge: HedgeSuggestion | null;
}

/**
 * Hedge/greenup: bancar o lado OPOSTO na odd ao vivo p/ travar lucro sem depender do
 * botão de cashout da casa. Iguala o retorno nos dois resultados:
 *   stakeHedge = stake * oddEntrada / oddOposto   → retorno igual = stake*oddEntrada
 *   lucroTravado = stake*oddEntrada - (stake + stakeHedge)   (retorno − total apostado)
 * Nos preços JUSTOS do oposto (1/(1-p)) o lucro travado converge p/ o fairProfit.
 */
export function hedgeToLock(stake: number, oddEntrada: number, oddOpostoNow: number): HedgeSuggestion | null {
  if (!Number.isFinite(stake) || stake <= 0) return null;
  if (!Number.isFinite(oddEntrada) || oddEntrada <= 1) return null;
  if (!Number.isFinite(oddOpostoNow) || oddOpostoNow <= 1) return null;
  const retorno = stake * oddEntrada;
  const stakeHedge = retorno / oddOpostoNow;
  const lucroTravado = retorno - (stake + stakeHedge);
  return { oddOposto: oddOpostoNow, stakeHedge, lucroTravado };
}

/**
 * Avalia AO VIVO uma aposta já feita. Puro (sem I/O). A prob justa vem da bússola
 * de-vigged ao vivo. `valida=false` para entradas impossíveis (não quebra o monitor).
 */
export function estimateCashout(
  pos: CashoutPosition,
  cfg: CashoutEstimateConfig = CASHOUT_ESTIMATE_CONFIG
): CashoutEstimate {
  const stake = Number.isFinite(pos.stake) && pos.stake > 0 ? pos.stake : 0;
  const vazio: CashoutEstimate = {
    valida: false, fairProbNow: 0, fairOddNow: 0, dropPctSinceEntry: 0,
    fairValue: 0, fairProfit: 0, houseCashout: null, houseProfit: null,
    emLucro: false, sacarAgora: false, hedge: null,
  };
  if (!Number.isFinite(pos.oddEntrada) || pos.oddEntrada <= 1) return vazio;
  if (!Number.isFinite(pos.fairProbNow) || pos.fairProbNow <= 0 || pos.fairProbNow >= 1) return vazio;

  const fairProbNow = pos.fairProbNow;
  const fairOddNow = 1 / fairProbNow;
  const dropPctSinceEntry = (pos.oddEntrada - fairOddNow) / pos.oddEntrada; // >0 = odd caiu
  const fairValue = stake * pos.oddEntrada * fairProbNow;
  const fairProfit = fairValue - stake;

  let houseCashout: number | null = null;
  let houseProfit: number | null = null;
  if (Number.isFinite(pos.oddCasaNow as number) && (pos.oddCasaNow as number) > 1 && stake > 0) {
    houseCashout = (stake * pos.oddEntrada) / (pos.oddCasaNow as number) * (1 - cfg.houseMargin);
    houseProfit = houseCashout - stake;
  }

  const emLucro = pos.oddEntrada * fairProbNow > 1; // ⇔ fairOddNow < oddEntrada ⇔ dropPctSinceEntry > 0
  const sacarAgora = dropPctSinceEntry >= cfg.signalDropPct;
  const hedge = Number.isFinite(pos.oddOpostoNow as number) && stake > 0
    ? hedgeToLock(stake, pos.oddEntrada, pos.oddOpostoNow as number)
    : null;

  return {
    valida: true, fairProbNow, fairOddNow, dropPctSinceEntry,
    fairValue, fairProfit, houseCashout, houseProfit, emLucro, sacarAgora, hedge,
  };
}
