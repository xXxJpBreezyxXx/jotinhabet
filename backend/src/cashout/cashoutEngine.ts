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
  windowMinutes: number;     // janela da regressão
  rSquaredMin: number;       // R² mínimo p/ a tendência não ser ruído
  minSlopeAbs: number;       // |slope| mínimo (sensibilidade) — em prob/segundo
  minConfirmingSources: number; // nº de bússolas que precisam confirmar a queda
  minGapPct: number;         // gap/EV mínimo p/ virar oportunidade (0.03 = 3%)
}

// Defaults calibráveis via cashout_outcomes (ver checklist da spec). minConfirmingSources=1
// no 1º corte porque a única bússola confiável hoje é a Pinnacle (ver memória
// pinnacle-asn-bloqueio); subir p/ 2 quando houver Betfair/Matchbook.
export const CASHOUT_CONFIG: CashoutConfig = {
  windowMinutes: 15,
  rSquaredMin: 0.7,
  minSlopeAbs: 0.00005,
  minConfirmingSources: 1,
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

  let oddDirection: OddDirection = 'flat';
  if (points.length >= 3 && rSquared >= cfg.rSquaredMin && Math.abs(slope) >= cfg.minSlopeAbs) {
    // slope>0 = prob justa subindo = ODD caindo (dropping); slope<0 = odd abrindo.
    oddDirection = slope > 0 ? 'dropping' : 'lengthening';
  }

  return {
    bookmakerName,
    slope,
    rSquared,
    sampleSize: points.length,
    fairProbability: points.length ? points[points.length - 1].y : 0,
    oddDirection,
  };
}

export interface OpportunityDetection {
  isOpportunity: boolean;
  gapPct: number;                 // = EV da aposta no alvo
  confirmingSources: string[];    // bússolas cuja odd está caindo
  consensusFairProbability: number;
}

/**
 * Confirma o consenso entre bússolas (odd caindo) e calcula o gap contra o alvo.
 * targetImpliedProb = 1/oddAlvo (CRUA, com a margem do alvo) — é o que o alvo paga.
 */
export function detectOpportunity(
  compassTrends: CompassTrend[],
  targetImpliedProb: number,
  cfg: CashoutConfig = CASHOUT_CONFIG
): OpportunityDetection {
  const caindo = compassTrends.filter((c) => c.oddDirection === 'dropping');
  const vazio: OpportunityDetection = {
    isOpportunity: false, gapPct: 0, confirmingSources: [], consensusFairProbability: 0,
  };
  if (caindo.length < cfg.minConfirmingSources) return vazio;
  if (!Number.isFinite(targetImpliedProb) || targetImpliedProb <= 0) return vazio;

  // consenso = média das probs justas das bússolas que confirmaram a queda
  const consensusFairProbability =
    caindo.reduce((s, c) => s + c.fairProbability, 0) / caindo.length;

  const gapPct = (consensusFairProbability - targetImpliedProb) / targetImpliedProb;

  return {
    isOpportunity: gapPct >= cfg.minGapPct,
    gapPct,
    confirmingSources: caindo.map((c) => c.bookmakerName),
    consensusFairProbability,
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
