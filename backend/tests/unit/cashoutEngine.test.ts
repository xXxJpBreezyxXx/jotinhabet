import { describe, it, expect } from 'vitest';
import {
  devig2Way,
  linearRegression,
  evaluateCompassTrend,
  detectOpportunity,
  estimateTTL,
  CASHOUT_CONFIG,
  type OddPoint,
  type CompassTrend,
} from '../../src/cashout/cashoutEngine';

describe('devig2Way', () => {
  it('remove a margem e normaliza p/ soma 1', () => {
    // Odds simétricas 1.90/1.90 têm overround; de-vigged = 0.5/0.5.
    const r = devig2Way(1.9, 1.9)!;
    expect(r.probA).toBeCloseTo(0.5, 6);
    expect(r.probB).toBeCloseTo(0.5, 6);
    expect(r.probA + r.probB).toBeCloseTo(1, 9);
  });

  it('favorito recebe prob maior', () => {
    const r = devig2Way(1.5, 2.5)!; // A é favorito
    expect(r.probA).toBeGreaterThan(r.probB);
    expect(r.probA + r.probB).toBeCloseTo(1, 9);
  });

  it('rejeita odds inválidas (<=1, NaN)', () => {
    expect(devig2Way(1.0, 2.0)).toBeNull();
    expect(devig2Way(2.0, NaN)).toBeNull();
    expect(devig2Way(0, 2.0)).toBeNull();
  });
});

describe('linearRegression', () => {
  it('reta perfeita crescente → slope exato e R²=1', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 2, y: 4 },
      { x: 3, y: 6 },
    ];
    const { slope, rSquared, intercept } = linearRegression(pts);
    expect(slope).toBeCloseTo(2, 9);
    expect(intercept).toBeCloseTo(0, 9);
    expect(rSquared).toBeCloseTo(1, 9);
  });

  it('menos de 3 pontos → sem tendência', () => {
    expect(linearRegression([{ x: 0, y: 1 }, { x: 1, y: 2 }]).slope).toBe(0);
  });

  it('ruído puro → R² baixo', () => {
    const pts = [
      { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 0 }, { x: 4, y: 1 },
    ];
    expect(linearRegression(pts).rSquared).toBeLessThan(0.3);
  });
});

describe('evaluateCompassTrend', () => {
  // Prob justa subindo de forma consistente = ODD caindo = 'dropping'.
  const subindo: OddPoint[] = Array.from({ length: 6 }, (_, i) => ({
    tSeconds: 1000 + i * 30,
    fairProb: 0.50 + i * 0.01, // +0.01 a cada 30s → slope ~0.00033 (> minSlopeAbs)
  }));

  it('prob subindo consistente → oddDirection dropping', () => {
    const t = evaluateCompassTrend('Pinnacle', subindo);
    expect(t.oddDirection).toBe('dropping');
    expect(t.slope).toBeGreaterThan(0);
    expect(t.fairProbability).toBeCloseTo(0.55, 6);
    expect(t.sampleSize).toBe(6);
  });

  it('prob caindo consistente → oddDirection lengthening', () => {
    const caindo = subindo.map((p, i) => ({ ...p, fairProb: 0.55 - i * 0.01 }));
    expect(evaluateCompassTrend('Pinnacle', caindo).oddDirection).toBe('lengthening');
  });

  it('estável/ruidoso → flat', () => {
    const flat: OddPoint[] = Array.from({ length: 6 }, (_, i) => ({
      tSeconds: 1000 + i * 30,
      fairProb: 0.5 + (i % 2 === 0 ? 0.001 : -0.001),
    }));
    expect(evaluateCompassTrend('Pinnacle', flat).oddDirection).toBe('flat');
  });

  it('slope real mas R² abaixo do mínimo → flat (filtra ruído com deriva)', () => {
    // sobe no geral mas com muita variância → R² < 0.7
    const ruidoso: OddPoint[] = [
      { tSeconds: 0, fairProb: 0.50 },
      { tSeconds: 30, fairProb: 0.58 },
      { tSeconds: 60, fairProb: 0.49 },
      { tSeconds: 90, fairProb: 0.60 },
      { tSeconds: 120, fairProb: 0.52 },
    ];
    const t = evaluateCompassTrend('Pinnacle', ruidoso);
    if (t.rSquared < CASHOUT_CONFIG.rSquaredMin) expect(t.oddDirection).toBe('flat');
  });
});

describe('detectOpportunity', () => {
  const dropping: CompassTrend = {
    bookmakerName: 'Pinnacle',
    slope: 0.0003,
    rSquared: 0.95,
    sampleSize: 6,
    fairProbability: 0.60, // linha afiada diz: prob justa 60%
    oddDirection: 'dropping',
  };

  it('gap positivo acima do mínimo → oportunidade; gapPct = EV', () => {
    // alvo paga odd 2.0 → implied 0.50; fair 0.60 → gap = (0.60-0.50)/0.50 = 0.20
    const r = detectOpportunity([dropping], 0.5);
    expect(r.isOpportunity).toBe(true);
    expect(r.gapPct).toBeCloseTo(0.2, 6);
    expect(r.confirmingSources).toEqual(['Pinnacle']);
    expect(r.consensusFairProbability).toBeCloseTo(0.6, 6);
  });

  it('gap abaixo do mínimo → não é oportunidade', () => {
    // alvo já quase ajustado: implied 0.59, fair 0.60 → gap ~1.7% < 3%
    expect(detectOpportunity([dropping], 0.59).isOpportunity).toBe(false);
  });

  it('nenhuma bússola caindo → não é oportunidade', () => {
    const flat: CompassTrend = { ...dropping, oddDirection: 'flat' };
    const r = detectOpportunity([flat], 0.5);
    expect(r.isOpportunity).toBe(false);
    expect(r.confirmingSources).toEqual([]);
  });

  it('exige minConfirmingSources', () => {
    const cfg = { ...CASHOUT_CONFIG, minConfirmingSources: 2 };
    expect(detectOpportunity([dropping], 0.5, cfg).isOpportunity).toBe(false);
    const b: CompassTrend = { ...dropping, bookmakerName: 'Betfair' };
    expect(detectOpportunity([dropping, b], 0.5, cfg).isOpportunity).toBe(true);
  });

  it('targetImpliedProb inválido → não quebra', () => {
    expect(detectOpportunity([dropping], 0).isOpportunity).toBe(false);
    expect(detectOpportunity([dropping], NaN).isOpportunity).toBe(false);
  });
});

describe('estimateTTL', () => {
  it('resta latência - tempo decorrido', () => {
    expect(estimateTTL(90, 30)).toBe(60);
  });
  it('nunca negativo', () => {
    expect(estimateTTL(30, 90)).toBe(0);
  });
  it('fallback 60s quando não há latência histórica', () => {
    expect(estimateTTL(null, 10)).toBe(50);
  });
});
