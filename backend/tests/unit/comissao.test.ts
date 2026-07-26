import { describe, it, expect } from 'vitest';
import { comissaoDaCasa, ehExchangeComComissao, oddEfetiva } from '../../src/arbitrage/comissao';
import { ArbitrageEngine, ArbitrageOpportunity } from '../../src/arbitrage/engine';

describe('comissão de exchange', () => {
  it('reconhece a Bolsa de Aposta como exchange 1,5% em várias grafias', () => {
    expect(comissaoDaCasa('Bolsa de Aposta')).toBeCloseTo(0.015, 6);
    expect(comissaoDaCasa('BolsaDeAposta')).toBeCloseTo(0.015, 6);
    expect(comissaoDaCasa('bolsa de aposta')).toBeCloseTo(0.015, 6);
    expect(comissaoDaCasa('Bolsa de Aposta (BR)')).toBeCloseTo(0.015, 6);
    expect(ehExchangeComComissao('Bolsa de Aposta')).toBe(true);
  });

  it('casa comum não tem comissão', () => {
    expect(comissaoDaCasa('Pinnacle')).toBe(0);
    expect(comissaoDaCasa('Betano')).toBe(0);
    expect(ehExchangeComComissao('KTO')).toBe(false);
  });

  it('odd efetiva desconta 1,5% do lucro na exchange e preserva a odd de casa comum', () => {
    // 1 + (3.0-1)*(1-0.015) = 1 + 2*0.985 = 2.97
    expect(oddEfetiva('Bolsa de Aposta', 3.0)).toBeCloseTo(2.97, 6);
    // 1 + (2.0-1)*0.985 = 1.985
    expect(oddEfetiva('Bolsa de Aposta', 2.0)).toBeCloseTo(1.985, 6);
    // casa comum → inalterada
    expect(oddEfetiva('Pinnacle', 3.0)).toBe(3.0);
    // odd inválida → devolvida como veio (sem quebrar)
    expect(oddEfetiva('Bolsa de Aposta', 1)).toBe(1);
  });
});

describe('distribuição de stake com comissão de exchange', () => {
  const engine = new ArbitrageEngine();

  function opp(casaA: string, casaB: string, oddA: number, oddB: number): ArbitrageOpportunity {
    const totalPerc = 1 / oddA + 1 / oddB;
    return {
      evento: 'A vs B', mercado: 'Resultado Final', opcaoA: 'A', opcaoB: 'B',
      oddA, oddB, casaA, casaB,
      lucroGarantidoPerc: (1 - totalPerc) * 100,
      oddCombinadaA: 1 / oddA / totalPerc, oddCombinadaB: 1 / oddB / totalPerc,
      totalPerc,
    };
  }

  it('sem exchange: pernas travam o MESMO retorno bruto (arb clássica)', () => {
    const d = engine.calcularDistribuicaoStake(opp('Pinnacle', 'KTO', 2.1, 2.1), 100);
    const retA = Number(d.apostaA) * 2.1;
    const retB = Number(d.apostaB) * 2.1;
    expect(retA).toBeCloseTo(retB, 2);
    expect(Number(d.retornoEsperado)).toBeCloseTo(retA, 2);
  });

  it('com exchange: o retorno LÍQUIDO (pós-comissão) é igual dos dois lados', () => {
    // Bolsa 3.0 (efetiva 2.97) x casa comum 2.1
    const d = engine.calcularDistribuicaoStake(opp('Bolsa de Aposta', 'KTO', 3.0, 2.1), 100);
    const retLiquidoBolsa = Number(d.apostaA) * oddEfetiva('Bolsa de Aposta', 3.0);
    const retComum = Number(d.apostaB) * 2.1;
    expect(retLiquidoBolsa).toBeCloseTo(retComum, 2);
    // total apostado bate com o stake informado
    expect(Number(d.apostaA) + Number(d.apostaB)).toBeCloseTo(100, 1);
  });

  it('a comissão REDUZ o lucro garantido vs ignorá-la', () => {
    const semComissao = engine.calcularDistribuicaoStake(opp('X', 'KTO', 3.0, 2.1), 100);
    const comComissao = engine.calcularDistribuicaoStake(opp('Bolsa de Aposta', 'KTO', 3.0, 2.1), 100);
    expect(Number(comComissao.lucroR$)).toBeLessThan(Number(semComissao.lucroR$));
  });
});
