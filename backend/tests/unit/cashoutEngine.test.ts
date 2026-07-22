import { describe, it, expect } from 'vitest';
import {
  devig2Way,
  linearRegression,
  evaluateCompassTrend,
  detectOpportunity,
  estimateTTL,
  estimateCashout,
  hedgeToLock,
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

  it('prob subindo consistente → odd CAIU (dropPct>0, dropping)', () => {
    const t = evaluateCompassTrend('Pinnacle', subindo);
    expect(t.oddDirection).toBe('dropping');
    expect(t.dropPct).toBeGreaterThan(0); // odd 2.0 → 1.82 = caiu ~9%
    expect(t.fairProbability).toBeCloseTo(0.55, 6);
    expect(t.sampleSize).toBe(6);
  });

  it('prob caindo consistente → odd ABRIU (dropPct<0, lengthening)', () => {
    const caindo = subindo.map((p, i) => ({ ...p, fairProb: 0.55 - i * 0.01 }));
    const t = evaluateCompassTrend('Pinnacle', caindo);
    expect(t.oddDirection).toBe('lengthening');
    expect(t.dropPct).toBeLessThan(0);
  });

  it('estável/ruidoso → flat (dropPct ~0)', () => {
    const flat: OddPoint[] = Array.from({ length: 6 }, (_, i) => ({
      tSeconds: 1000 + i * 30,
      fairProb: 0.5 + (i % 2 === 0 ? 0.001 : -0.001),
    }));
    const t = evaluateCompassTrend('Pinnacle', flat);
    expect(t.oddDirection).toBe('flat');
    expect(Math.abs(t.dropPct)).toBeLessThan(0.005);
  });
});

describe('detectOpportunity', () => {
  // odd caiu 6% na janela (dropPct 0.06 >= minDropPct 0.03) e prob justa atual 60%.
  const dropping: CompassTrend = {
    bookmakerName: 'Pinnacle',
    slope: 0.0003,
    rSquared: 0.95,
    sampleSize: 6,
    fairProbability: 0.60,
    dropPct: 0.06,
    oddDirection: 'dropping',
  };

  it('odd caiu + alvo atrasado → oportunidade; gapPct = lag; trending', () => {
    // alvo paga odd 2.0 → implied 0.50; fair 0.60 → gap = (0.60-0.50)/0.50 = 0.20
    const r = detectOpportunity([dropping], 0.5);
    expect(r.isOpportunity).toBe(true);
    expect(r.gapPct).toBeCloseTo(0.2, 6);
    expect(r.dropPct).toBeCloseTo(0.06, 6);
    expect(r.confirmingSources).toEqual(['Pinnacle']);
    expect(r.trending).toBe(true);
  });

  it('odd caiu mas gap abaixo do mínimo (3%) → não é oportunidade', () => {
    // implied 0.59, fair 0.60 → gap ~1.7% < 3%
    expect(detectOpportunity([dropping], 0.59).isOpportunity).toBe(false);
  });

  it('gap grande mas odd NÃO caiu → NÃO é oportunidade (exige direção do cashout)', () => {
    // é o caso Eva Lopez: alvo paga muito mais, mas a odd afiada não está caindo (ou subiu)
    const semQueda: CompassTrend = { ...dropping, dropPct: 0.0, oddDirection: 'flat' };
    const r = detectOpportunity([semQueda], 0.5);
    expect(r.isOpportunity).toBe(false);
    expect(r.trending).toBe(false);
    const subindo: CompassTrend = { ...dropping, dropPct: -0.08, oddDirection: 'lengthening' };
    expect(detectOpportunity([subindo], 0.5).isOpportunity).toBe(false);
  });

  it('poucos pontos (< minSampleSize) → estimativa não conta', () => {
    const rasa: CompassTrend = { ...dropping, sampleSize: 2 };
    expect(detectOpportunity([rasa], 0.5).isOpportunity).toBe(false);
    expect(detectOpportunity([rasa], 0.5).confirmingSources).toEqual([]);
  });

  it('exige minConfirmingSources (bússolas com estimativa válida)', () => {
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

describe('estimateCashout', () => {
  // Apostou R$100 a 2.75. A odd JUSTA caiu para ~2.20 (fairProb ~0.4545): posição no lucro.
  it('odd caiu desde a entrada → no lucro, saque > stake, sinal de sacar', () => {
    const e = estimateCashout({ stake: 100, oddEntrada: 2.75, fairProbNow: 1 / 2.2 });
    expect(e.valida).toBe(true);
    expect(e.fairOddNow).toBeCloseTo(2.2, 6);
    expect(e.dropPctSinceEntry).toBeGreaterThan(0); // (2.75-2.20)/2.75 = 20%
    expect(e.dropPctSinceEntry).toBeCloseTo(0.2, 6);
    expect(e.emLucro).toBe(true);
    expect(e.sacarAgora).toBe(true);
    // valor justo = 100*2.75*(1/2.2) = 125; lucro = 25
    expect(e.fairValue).toBeCloseTo(125, 6);
    expect(e.fairProfit).toBeCloseTo(25, 6);
  });

  it('odd subiu desde a entrada → sem lucro, saque < stake, não sinaliza', () => {
    // fairOddNow 3.30 > entrada 2.75 → a seleção ficou MENOS provável
    const e = estimateCashout({ stake: 100, oddEntrada: 2.75, fairProbNow: 1 / 3.3, oddCasaNow: 3.3 });
    expect(e.valida).toBe(true);
    expect(e.dropPctSinceEntry).toBeLessThan(0);
    expect(e.emLucro).toBe(false);
    expect(e.sacarAgora).toBe(false);
    expect(e.houseCashout!).toBeLessThan(100);
  });

  it('estima a oferta da casa a partir da odd ao vivo (com haircut de margem)', () => {
    // odd da casa caiu p/ 2.20 → oferta ≈ 100*2.75/2.20*(1-0.06) = 125*0.94 = 117.5
    const e = estimateCashout({ stake: 100, oddEntrada: 2.75, fairProbNow: 1 / 2.2, oddCasaNow: 2.2 });
    expect(e.houseCashout!).toBeCloseTo(117.5, 4);
    expect(e.houseProfit!).toBeCloseTo(17.5, 4);
  });

  it('sem odd da casa → só valor justo (houseCashout null)', () => {
    const e = estimateCashout({ stake: 100, oddEntrada: 2.75, fairProbNow: 1 / 2.2 });
    expect(e.houseCashout).toBeNull();
    expect(e.houseProfit).toBeNull();
    expect(e.fairValue).toBeCloseTo(125, 6);
  });

  it('stake não informado (0) → %s valem, valores monetários = 0', () => {
    const e = estimateCashout({ stake: 0, oddEntrada: 2.75, fairProbNow: 1 / 2.2 });
    expect(e.valida).toBe(true);
    expect(e.emLucro).toBe(true);              // independe do stake
    expect(e.dropPctSinceEntry).toBeCloseTo(0.2, 6);
    expect(e.fairValue).toBe(0);
    expect(e.houseCashout).toBeNull();
  });

  it('entradas inválidas → valida=false, não quebra', () => {
    expect(estimateCashout({ stake: 100, oddEntrada: 1, fairProbNow: 0.5 }).valida).toBe(false);
    expect(estimateCashout({ stake: 100, oddEntrada: 2.0, fairProbNow: 0 }).valida).toBe(false);
    expect(estimateCashout({ stake: 100, oddEntrada: 2.0, fairProbNow: 1 }).valida).toBe(false);
    expect(estimateCashout({ stake: 100, oddEntrada: NaN, fairProbNow: 0.5 }).valida).toBe(false);
  });

  it('hedge: nos preços justos do oposto, o lucro travado ≈ fairProfit', () => {
    const p = 1 / 2.2;                 // fairProb do lado apostado
    const oddOposto = 1 / (1 - p);     // odd justa do lado oposto
    const e = estimateCashout({ stake: 100, oddEntrada: 2.75, fairProbNow: p, oddOpostoNow: oddOposto });
    expect(e.hedge).not.toBeNull();
    expect(e.hedge!.lucroTravado).toBeCloseTo(e.fairProfit, 4); // ≈ 25
    // retorno igual nos dois lados = stake*oddEntrada = 275
    expect(e.hedge!.stakeHedge).toBeCloseTo(275 / oddOposto, 6);
  });
});

describe('hedgeToLock', () => {
  it('iguala o retorno e trava lucro positivo quando o oposto pagou pouco', () => {
    // apostou 100 @ 2.75 (retorno 275); oposto ao vivo @ 1.80 → hedge 275/1.8 = 152.78
    const h = hedgeToLock(100, 2.75, 1.8)!;
    expect(h.stakeHedge).toBeCloseTo(152.78, 2);
    // lucro travado = 275 - (100 + 152.78) = 22.22 em qualquer resultado
    expect(h.lucroTravado).toBeCloseTo(22.22, 2);
  });

  it('rejeita entradas inválidas', () => {
    expect(hedgeToLock(0, 2.0, 2.0)).toBeNull();
    expect(hedgeToLock(100, 1.0, 2.0)).toBeNull();
    expect(hedgeToLock(100, 2.0, 1.0)).toBeNull();
  });
});
