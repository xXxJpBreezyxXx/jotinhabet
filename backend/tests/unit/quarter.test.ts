import { describe, it, expect } from 'vitest';
import { linhaArbitravel, ehLinhaQuarter } from '../../src/arbitrage/markets';
import { ArbitrageEngine, ArbitrageOpportunity } from '../../src/arbitrage/engine';

describe('markets.linhaArbitravel / ehLinhaQuarter', () => {
  it('meia-linha e quarter passam; inteira não', () => {
    expect(linhaArbitravel(2.5)).toBe(true);
    expect(linhaArbitravel(2.25)).toBe(true);
    expect(linhaArbitravel(2.75)).toBe(true);
    expect(linhaArbitravel(-1.75)).toBe(true);
    expect(linhaArbitravel(2)).toBe(false);
    expect(linhaArbitravel(0)).toBe(false);
    expect(linhaArbitravel(-3)).toBe(false);
  });
  it('ehLinhaQuarter só .25/.75', () => {
    expect(ehLinhaQuarter(2.25)).toBe(true);
    expect(ehLinhaQuarter(-1.75)).toBe(true);
    expect(ehLinhaQuarter(0.25)).toBe(true);
    expect(ehLinhaQuarter(2.5)).toBe(false);
    expect(ehLinhaQuarter(2)).toBe(false);
  });
});

const fonteTotal = (nome: string, linha: number, oddA: number, oddB: number) => ({
  nome,
  odds: [{
    esporte: 'Futebol',
    evento: 'Alpha vs Beta',
    dataHora: '2099-01-01T12:00:00Z',
    mercado: 'Total de Gols',
    linha,
    opcaoA: `Mais de ${linha}`,
    opcaoB: `Menos de ${linha}`,
    oddA,
    oddB,
  }],
});

describe('engine — lucro garantido de quarter-line é o PISO (metade do nominal)', () => {
  it('meia-linha 2.5: ROI nominal (4.76%)', async () => {
    const engine = new ArbitrageEngine();
    const ops = await engine.encontrarMelhoresOportunidades([
      fonteTotal('CasaX', 2.5, 2.1, 1.7),
      fonteTotal('CasaY', 2.5, 1.7, 2.1),
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0].lucroGarantidoPerc).toBeCloseTo(4.76, 2);
  });
  it('quarter 2.25: mesmas odds → ROI garantido cai pra METADE (2.38%)', async () => {
    const engine = new ArbitrageEngine();
    const ops = await engine.encontrarMelhoresOportunidades([
      fonteTotal('CasaX', 2.25, 2.1, 1.7),
      fonteTotal('CasaY', 2.25, 1.7, 2.1),
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0].lucroGarantidoPerc).toBeCloseTo(2.38, 2);
    expect(ops[0].linha).toBe(2.25);
  });
  it('quarter 2.25 NUNCA cruza com meia-linha 2.5 (linhas diferentes)', async () => {
    const engine = new ArbitrageEngine();
    const ops = await engine.encontrarMelhoresOportunidades([
      fonteTotal('CasaX', 2.25, 2.1, 1.7),
      fonteTotal('CasaY', 2.5, 1.7, 2.1),
    ]);
    expect(ops).toHaveLength(0);
  });
});

describe('engine.calcularDistribuicaoStake — lucroR$ de quarter é o piso', () => {
  const oppBase: ArbitrageOpportunity = {
    evento: 'Alpha vs Beta',
    mercado: 'Total de Gols',
    opcaoA: 'Mais de 2.25',
    opcaoB: 'Menos de 2.25',
    oddA: 2.1,
    oddB: 2.1,
    casaA: 'CasaX',
    casaB: 'CasaY',
    lucroGarantidoPerc: 2.38,
    oddCombinadaA: 0.5,
    oddCombinadaB: 0.5,
    totalPerc: 2 / 2.1,
  };
  it('quarter: lucroR$ = metade do nominal (stakes inalteradas)', () => {
    const d = new ArbitrageEngine().calcularDistribuicaoStake({ ...oppBase, linha: 2.25 }, 100);
    expect(d.apostaA).toBe('50.00');
    expect(d.apostaB).toBe('50.00');
    expect(d.retornoEsperado).toBe('105.00');
    expect(d.lucroR$).toBe('2.50'); // nominal seria 5.00
  });
  it('meia-linha: lucroR$ nominal', () => {
    const d = new ArbitrageEngine().calcularDistribuicaoStake({ ...oppBase, linha: 2.5 }, 100);
    expect(d.lucroR$).toBe('5.00');
  });
});
