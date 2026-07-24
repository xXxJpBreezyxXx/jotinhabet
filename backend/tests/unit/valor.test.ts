import { describe, it, expect } from 'vitest';
import {
  justaSemVig2Vias,
  edgeValorPct,
  detectarValor2Vias,
  encontrarValor,
  encontrarMiddles,
} from '../../src/arbitrage/valor';
import { ScrapedOdd } from '../../src/scraping/scraper_base';

const odd = (o: Partial<ScrapedOdd>): ScrapedOdd => ({
  esporte: 'Basquete',
  evento: 'Time A vs Time B',
  dataHora: '2026-07-20T20:00:00Z',
  mercado: 'Resultado Final',
  opcaoA: 'Time A',
  opcaoB: 'Time B',
  oddA: 1.9,
  oddB: 1.9,
  ...o,
});

describe('valor.justaSemVig2Vias — de-vig proporcional', () => {
  it('linha simétrica 1.90/1.90 → prob 0.5 cada, justa 2.00', () => {
    const j = justaSemVig2Vias(1.9, 1.9)!;
    expect(j.probA).toBeCloseTo(0.5, 10);
    expect(j.probB).toBeCloseTo(0.5, 10);
    expect(j.fairOddA).toBeCloseTo(2.0, 10);
    expect(j.overround).toBeCloseTo(1 / 1.9 + 1 / 1.9, 10); // ~1.0526
  });

  it('linha assimétrica preserva a razão das probabilidades implícitas', () => {
    const j = justaSemVig2Vias(1.5, 2.75)!;
    // prob implícitas: 0.6667 e 0.3636; overround 1.0303
    expect(j.probA + j.probB).toBeCloseTo(1, 10); // de-vig soma 1
    expect(j.probA).toBeCloseTo((1 / 1.5) / (1 / 1.5 + 1 / 2.75), 10);
    expect(j.fairOddA).toBeCloseTo(1 / j.probA, 10);
  });

  it('odds inválidas → null', () => {
    expect(justaSemVig2Vias(1.0, 2.0)).toBeNull();
    expect(justaSemVig2Vias(2.0, 0)).toBeNull();
  });
});

describe('valor.edgeValorPct', () => {
  it('justa 0.5 e soft 2.10 → +5%', () => {
    expect(edgeValorPct(2.1, 0.5)).toBeCloseTo(5, 10);
  });
  it('justa 0.5 e soft 1.95 → -2.5% (sem valor)', () => {
    expect(edgeValorPct(1.95, 0.5)).toBeCloseTo(-2.5, 10);
  });
  it('odd inválida → -Infinity', () => {
    expect(edgeValorPct(1.0, 0.5)).toBe(-Infinity);
  });
});

describe('valor.detectarValor2Vias', () => {
  it('reporta o lado com edge acima do piso; ignora o sem valor', () => {
    // ref 1.90/1.90 → justa 2.00/2.00 (prob 0.5). Soft paga 2.10 no A, 1.90 no B.
    const achados = detectarValor2Vias({ oddA: 1.9, oddB: 1.9 }, { oddA: 2.1, oddB: 1.9 }, 2);
    expect(achados).toHaveLength(1);
    expect(achados[0].lado).toBe('A');
    expect(achados[0].edgePct).toBeCloseTo(5, 2);
    expect(achados[0].fairOdd).toBeCloseTo(2.0, 6);
  });

  it('descarta edge acima do teto de sanidade (linha travada/erro)', () => {
    // justa 2.00; soft 2.90 → edge +45% → acima do teto default (20%) → descartado.
    const achados = detectarValor2Vias({ oddA: 1.9, oddB: 1.9 }, { oddA: 2.9, oddB: 1.9 }, 2);
    expect(achados).toHaveLength(0);
  });

  it('nenhum lado com valor → lista vazia', () => {
    const achados = detectarValor2Vias({ oddA: 1.9, oddB: 1.9 }, { oddA: 1.95, oddB: 1.95 }, 2);
    expect(achados).toEqual([]);
  });

  it('referência inválida → lista vazia', () => {
    expect(detectarValor2Vias({ oddA: 1.0, oddB: 1.9 }, { oddA: 2.1, oddB: 1.9 }, 2)).toEqual([]);
  });
});

describe('valor.encontrarValor (snapshot multi-casa vs Pinnacle)', () => {
  it('detecta valor na casa soft que paga acima da justa da Pinnacle', () => {
    const pin = odd({ oddA: 1.9, oddB: 1.9 }); // justa 2.00/2.00 (prob 0.5)
    const soft = odd({ oddA: 2.1, oddB: 1.85 }); // A: +5% | B: -7.5%
    const achados = encontrarValor(
      [{ nome: 'Pinnacle', odds: [pin] }, { nome: 'CasaX', odds: [soft] }],
      { minEdgePct: 2 }
    );
    expect(achados).toHaveLength(1);
    expect(achados[0].casa).toBe('CasaX');
    expect(achados[0].opcao).toBe('Time A');
    expect(achados[0].edgePct).toBeCloseTo(5, 1);
    expect(achados[0].fairOdd).toBeCloseTo(2.0, 2);
    expect(achados[0].confianca).toBeGreaterThan(0.9);
  });

  it('sem casa de referência (Pinnacle) → lista vazia', () => {
    const achados = encontrarValor([{ nome: 'CasaX', odds: [odd({ oddA: 2.1 })] }], {});
    expect(achados).toEqual([]);
  });

  it('respeita a doutrina de mercado: futebol Resultado Final é bloqueado', () => {
    const pin = odd({ esporte: 'Futebol', oddA: 1.9, oddB: 1.9 });
    const soft = odd({ esporte: 'Futebol', oddA: 2.2, oddB: 1.8 }); // A seria +10%
    const achados = encontrarValor(
      [{ nome: 'Pinnacle', odds: [pin] }, { nome: 'CasaX', odds: [soft] }],
      { minEdgePct: 2 }
    );
    expect(achados).toEqual([]);
  });

  it('lados invertidos (casa lista os times na ordem oposta) alinham', () => {
    const pin = odd({ evento: 'Time A vs Time B', oddA: 1.9, oddB: 1.9 });
    // Soft: "Time B vs Time A" com oddA=2.10 (Time B) e oddB=1.85 (Time A) → valor no Time B.
    const soft = odd({ evento: 'Time B vs Time A', opcaoA: 'Time B', opcaoB: 'Time A', oddA: 2.1, oddB: 1.85 });
    const achados = encontrarValor(
      [{ nome: 'Pinnacle', odds: [pin] }, { nome: 'CasaX', odds: [soft] }],
      { minEdgePct: 2 }
    );
    expect(achados).toHaveLength(1);
    expect(achados[0].opcao).toBe('Time B');
    expect(achados[0].edgePct).toBeCloseTo(5, 1);
  });

  it('sign-aware: handicap espelhado (-1.5/+1.5) NÃO vira valor', () => {
    const pin = odd({
      mercado: 'Handicap Asiático', linha: 1.5,
      opcaoA: 'Time A (-1.5)', opcaoB: 'Time B (+1.5)', oddA: 1.9, oddB: 1.9,
    });
    // Mesmos times e |linha|, mas ancorado no time oposto → oferta espelhada.
    const soft = odd({
      mercado: 'Handicap Asiático', linha: 1.5,
      opcaoA: 'Time A (+1.5)', opcaoB: 'Time B (-1.5)', oddA: 2.2, oddB: 1.7,
    });
    const achados = encontrarValor(
      [{ nome: 'Pinnacle', odds: [pin] }, { nome: 'CasaX', odds: [soft] }],
      { minEdgePct: 2 }
    );
    expect(achados).toEqual([]);
  });

  it('descarta edge acima do teto de sanidade (linha travada/erro)', () => {
    const pin = odd({ oddA: 1.9, oddB: 1.9 });
    const soft = odd({ oddA: 3.0, oddB: 1.5 }); // A: +50% → acima do teto default (20%)
    const achados = encontrarValor(
      [{ nome: 'Pinnacle', odds: [pin] }, { nome: 'CasaX', odds: [soft] }],
      { minEdgePct: 2 }
    );
    expect(achados).toEqual([]);
  });
});

describe('valor.encontrarMiddles (totais over/under com linhas diferentes)', () => {
  // Oferta de total: opcaoA=Over@linha, opcaoB=Under@linha.
  const total = (o: Partial<ScrapedOdd> & { linha: number }): ScrapedOdd => ({
    esporte: 'Futebol',
    evento: 'Time A vs Time B',
    dataHora: '2026-07-20T20:00:00Z',
    mercado: 'Total de Gols',
    opcaoA: `Mais de ${o.linha}`,
    opcaoB: `Menos de ${o.linha}`,
    oddA: 2.0,
    oddB: 2.0,
    ...o,
  });

  it('detecta o middle Over 2.5 × Under 3.5 (total=3 ganha os dois)', () => {
    const casaA = total({ linha: 2.5, oddA: 2.0, oddB: 1.7 }); // Over 2.5 @ 2.0
    const casaB = total({ linha: 3.5, oddA: 1.7, oddB: 2.0 }); // Under 3.5 @ 2.0
    const ms = encontrarMiddles([
      { nome: 'CasaA', odds: [casaA] },
      { nome: 'CasaB', odds: [casaB] },
    ]);
    expect(ms).toHaveLength(1);
    expect(ms[0].overCasa).toBe('CasaA');
    expect(ms[0].overLinha).toBe(2.5);
    expect(ms[0].underCasa).toBe('CasaB');
    expect(ms[0].underLinha).toBe(3.5);
    expect(ms[0].largura).toBe(1);
    expect(ms[0].piorCasoRoiPct).toBeCloseTo(0, 1); // 1/2 + 1/2 = 1 → breakeven garantido
  });

  it('linhas IGUAIS não são middle (é candidato a arb, não middle)', () => {
    const a = total({ linha: 2.5, oddA: 2.0, oddB: 1.9 });
    const b = total({ linha: 2.5, oddA: 1.9, oddB: 2.0 });
    expect(encontrarMiddles([{ nome: 'CasaA', odds: [a] }, { nome: 'CasaB', odds: [b] }])).toEqual([]);
  });

  it('descarta middle com custo alto demais no pior caso', () => {
    const a = total({ linha: 2.5, oddA: 1.7, oddB: 1.7 });
    const b = total({ linha: 3.5, oddA: 1.7, oddB: 1.7 }); // 1/1.7+1/1.7 ≈ 1.176 → ~-15%
    expect(encontrarMiddles([{ nome: 'CasaA', odds: [a] }, { nome: 'CasaB', odds: [b] }])).toEqual([]);
  });

  it('tênis: grupos de W.O. incompatíveis (A×B) bloqueiam o middle', () => {
    const betano = total({ esporte: 'Tenis', mercado: 'Total de Games', linha: 21.5, oddA: 2.0, oddB: 1.7 });
    const stake = total({ esporte: 'Tenis', mercado: 'Total de Games', linha: 22.5, oddA: 1.7, oddB: 2.0 });
    // Betano = grupo A, Stake = grupo B → cruzamento proibido (Diretrizes).
    const ms = encontrarMiddles([{ nome: 'Betano', odds: [betano] }, { nome: 'Stake', odds: [stake] }]);
    expect(ms).toEqual([]);
  });
});
