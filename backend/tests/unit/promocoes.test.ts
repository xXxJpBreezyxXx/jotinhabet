import { describe, it, expect } from 'vitest';
import {
  calcularPromocao,
  calcularMultiplaQualificadora,
  curvaRetencaoFreebet,
  margemImplicita,
  oddIdealFreebet,
  retencaoTeorica,
} from '../../src/core/promocoes';

describe('calcularPromocao — freebet SNR', () => {
  it('reproduz o caso real da conversa: freebet R$ 10 @7.75 com cobertura @1.06', () => {
    const r = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 7.75, coverOdd: 1.06 })!;
    expect(r.coverStake).toBeCloseTo(63.68, 2);
    expect(r.lucroSePromoGanha).toBeCloseTo(3.82, 2);
    expect(r.lucroSeCoberturaGanha).toBeCloseTo(3.82, 2);
    expect(r.lucroGarantido).toBeCloseTo(3.82, 2);
    // Retenção real do caso (~38%), MUITO abaixo dos "75% a 85%" projetados na conversa.
    expect(r.retencaoPct!).toBeGreaterThan(37);
    expect(r.retencaoPct!).toBeLessThan(39);
  });

  it('cobertura @1.07 pede menos aporte e rende mais (o outro cenário do caso real)', () => {
    const r = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 7.75, coverOdd: 1.07 })!;
    expect(r.coverStake).toBeCloseTo(63.08, 2);
    expect(r.lucroGarantido).toBeCloseTo(4.42, 2);
  });

  it('a ficha da freebet NÃO entra no investimento (o bug que motivou a refatoração)', () => {
    const r = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 50, promoOdd: 4.45, coverOdd: 1.19 })!;
    expect(r.investimentoReal).toBeCloseTo(r.coverStake, 2);
    expect(r.lucroGarantido).toBeGreaterThan(0);
    expect(r.roiPct!).toBeGreaterThan(0);
  });

  it('caso do refatoracao promocoes.md: 50 @4.45 × 144.96 @1.19 → ~R$ 27,5 nos dois lados', () => {
    const r = calcularPromocao({
      tipo: 'FREEBET_SNR', promoStake: 50, promoOdd: 4.45, coverOdd: 1.19, coverStake: 144.96,
    })!;
    expect(r.lucroSePromoGanha).toBeCloseTo(27.54, 1);
    expect(r.lucroSeCoberturaGanha).toBeCloseTo(27.54, 1);
    expect(r.roiPct!).toBeGreaterThan(18);
    expect(r.roiPct!).toBeLessThan(20);
  });
});

describe('calcularPromocao — qualificativa e cashback', () => {
  it('qualificativa equaliza com c = S·O/C e costuma dar prejuízo (pedágio do bônus)', () => {
    const r = calcularPromocao({ tipo: 'QUALIFICATIVA', promoStake: 20, promoOdd: 2.0, coverOdd: 1.9 })!;
    expect(r.coverStake).toBeCloseTo((20 * 2.0) / 1.9, 2);
    expect(r.lucroSePromoGanha).toBeCloseTo(r.lucroSeCoberturaGanha, 2);
    expect(r.lucroGarantido).toBeLessThan(0);
    expect(r.avisos.join(' ')).toMatch(/qualificador/i);
  });

  it('cashback de perda reduz o aporte da cobertura e melhora o pior caso', () => {
    const sem = calcularPromocao({ tipo: 'QUALIFICATIVA', promoStake: 20, promoOdd: 2.0, coverOdd: 1.9 })!;
    const com = calcularPromocao({ tipo: 'QUALIFICATIVA', promoStake: 20, promoOdd: 2.0, coverOdd: 1.9, cashback: 10 })!;
    expect(com.coverStake).toBeLessThan(sem.coverStake);
    expect(com.lucroGarantido).toBeGreaterThan(sem.lucroGarantido);
    // Equalização com cashback condicional: c = (S·O − CB)/C
    expect(com.coverStake).toBeCloseTo((20 * 2.0 - 10) / 1.9, 2);
  });

  it('comissão de exchange na cobertura entra pela odd efetiva', () => {
    const semComissao = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 4, coverOdd: 1.35 })!;
    const comComissao = calcularPromocao({
      tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 4, coverOdd: 1.35, casaCobertura: 'Bolsa de Aposta',
    })!;
    expect(comComissao.coverOddEfetiva).toBeLessThan(1.35);
    expect(comComissao.lucroGarantido).toBeLessThan(semComissao.lucroGarantido);
    expect(comComissao.avisos.join(' ')).toMatch(/comiss/i);
  });

  it('aporte diferente do equalizado marca equalizado=false e avisa', () => {
    const r = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 4, coverOdd: 1.35, coverStake: 10 })!;
    expect(r.equalizado).toBe(false);
    expect(r.lucroSePromoGanha).not.toBeCloseTo(r.lucroSeCoberturaGanha, 2);
    expect(r.avisos.join(' ')).toMatch(/NÃO pagam igual/i);
  });

  it('rejeita entrada inválida', () => {
    expect(calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 0, promoOdd: 4, coverOdd: 1.3 })).toBeNull();
    expect(calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 1, coverOdd: 1.3 })).toBeNull();
    expect(calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 4, coverOdd: 1 })).toBeNull();
  });
});

describe('retenção da freebet — o pico em √(1+1/m)', () => {
  it('mede a margem implícita do par observado', () => {
    // Odd justa oposta de 7.75 é 7.75/6.75 = 1.148; a casa pagando 1.06 embute ~8,3%.
    const m = margemImplicita(7.75, 1.06);
    expect(m).toBeGreaterThan(0.07);
    expect(m).toBeLessThan(0.1);
  });

  it('a odd ótima é √(1 + 1/m) e maximiza a retenção de verdade', () => {
    const m = 0.06;
    const otima = oddIdealFreebet(m);
    expect(otima).toBeCloseTo(Math.sqrt(1 + 1 / m), 6);
    const noPico = retencaoTeorica(otima, m);
    for (const o of [2, 3, 3.5, 4.5, 5, 6, 7.75, 10]) {
      expect(retencaoTeorica(o, m)).toBeLessThanOrEqual(noPico + 1e-9);
    }
  });

  it('desmente o mito "odd maior sempre retém mais": 7.75 rende menos que 4.00', () => {
    const m = 0.08;
    expect(retencaoTeorica(7.75, m)).toBeLessThan(retencaoTeorica(4, m));
  });

  it('curva devolve odd ideal, cobertura esperada e lucro por odd', () => {
    const c = curvaRetencaoFreebet(10, 0.06);
    expect(c.oddIdeal).toBeCloseTo(4.2, 1);
    expect(c.coverOddNoIdeal).toBeGreaterThan(1.2);
    expect(c.coverOddNoIdeal).toBeLessThan(1.35);
    const em775 = c.curva.find((p) => p.promoOdd === 7.75)!;
    const em4 = c.curva.find((p) => p.promoOdd === 4)!;
    expect(em775.retencaoPct).toBeLessThan(em4.retencaoPct);
  });
});

describe('múltipla qualificadora + cobertura sequencial', () => {
  const pernas = (n: number, odd: number, oddCobertura: number | null) =>
    Array.from({ length: n }, (_, i) => ({
      descricao: `Perna ${i + 1}`,
      odd,
      oddCobertura,
      resolveEm: `dia ${i + 1}`,
    }));

  it('reprova bilhete abaixo da odd total exigida e diz a odd que falta', () => {
    const r = calcularMultiplaQualificadora({
      stake: 50,
      pernas: [
        { odd: 1.32, oddCobertura: 2.7, resolveEm: 'jogo 1' },
        { odd: 1.22, oddCobertura: 2.7, resolveEm: 'jogo 2' },
        { odd: 1.96, oddCobertura: 2.7, resolveEm: 'jogo 3' },
      ],
      oddTotalMinima: 4,
      oddMinimaPorPerna: 1.2,
    })!;
    expect(r.oddTotal).toBeCloseTo(3.157, 2);
    expect(r.qualifica).toBe(false);
    expect(r.problemas.join(' ')).toMatch(/1\.2[67]/); // precisa de ~1,27 numa 4ª seleção
  });

  it('aprova o bilhete corrigido (4.36) e sugere pernas equilibradas', () => {
    const r = calcularMultiplaQualificadora({
      stake: 50,
      pernas: [
        { odd: 1.32, oddCobertura: 2.7, resolveEm: 'jogo 1' },
        { odd: 1.7, oddCobertura: 2.6, resolveEm: 'jogo 2' },
        { odd: 1.96, oddCobertura: 2.4, resolveEm: 'jogo 3' },
      ],
      oddTotalMinima: 4,
      oddMinimaPorPerna: 1.2,
    })!;
    expect(r.qualifica).toBe(true);
    expect(r.oddTotal).toBeCloseTo(4.39, 1);
    expect(r.oddPorPernaEquilibrada).toBeCloseTo(Math.cbrt(4), 2);
  });

  it('cobertura sequencial: red em qualquer perna devolve o gasto acumulado', () => {
    const r = calcularMultiplaQualificadora({ stake: 50, pernas: pernas(3, 1.59, 2.7), oddTotalMinima: 4 })!;
    expect(r.cobertura.possivel).toBe(true);
    for (const p of r.cobertura.passos) {
      // perda aceita = 0 → o retorno da cobertura zera exatamente o gasto até ali
      expect(p.resultadoSeRed!).toBeCloseTo(0, 1);
      expect(p.aporte!).toBeGreaterThan(0);
    }
    // O caixa cresce a cada perna coberta (o ponto que o material original não menciona).
    const gastos = r.cobertura.passos.map((p) => p.gastoAcumulado);
    expect(gastos[1]).toBeGreaterThan(gastos[0]);
    expect(gastos[2]).toBeGreaterThan(gastos[1]);
    expect(r.cobertura.caixaPico).toBeCloseTo(gastos[2], 2);
    expect(r.cobertura.avisos.join(' ')).toMatch(/Caixa de pico/i);
  });

  it('perda aceita > 0 reduz o aporte de cada cobertura', () => {
    const zero = calcularMultiplaQualificadora({ stake: 50, pernas: pernas(2, 1.59, 2.7), perdaAceita: 0 })!;
    const com5 = calcularMultiplaQualificadora({ stake: 50, pernas: pernas(2, 1.59, 2.7), perdaAceita: 5 })!;
    expect(com5.cobertura.passos[0].aporte!).toBeLessThan(zero.cobertura.passos[0].aporte!);
  });

  it('avisa quando duas pernas resolvem no MESMO momento (sequencial quebra)', () => {
    const r = calcularMultiplaQualificadora({
      stake: 50,
      pernas: [
        { odd: 1.7, oddCobertura: 2.2, resolveEm: '30/07 21:30' },
        { odd: 1.5, oddCobertura: 2.6, resolveEm: '30/07 21:30' },
      ],
    })!;
    expect(r.cobertura.avisos.join(' ')).toMatch(/MESMO momento/i);
  });

  it('sem odd de cobertura, marca a cobertura como impossível e pede as odds', () => {
    const r = calcularMultiplaQualificadora({ stake: 50, pernas: pernas(2, 1.59, null) })!;
    expect(r.cobertura.possivel).toBe(false);
    expect(r.cobertura.passos.every((p) => p.aporte === null)).toBe(true);
    expect(r.cobertura.avisos.join(' ')).toMatch(/Faltam odds de cobertura/i);
  });
});

describe('correções do lote de revisão (30/07)', () => {
  it('múltipla: avisa que o caminho ALL-GREEN pode dar PREJUÍZO', () => {
    // Caso da própria doutrina: R$ 50, 4 pernas de 1,42 (total ~4,07), coberturas a 2,70.
    const r = calcularMultiplaQualificadora({
      stake: 50,
      pernas: Array.from({ length: 4 }, (_, i) => ({
        descricao: `Perna ${i + 1}`, odd: 1.42, oddCobertura: 2.7, resolveEm: `dia ${i + 1}`,
      })),
      oddTotalMinima: 4,
    })!;
    expect(r.cobertura.lucroSeTudoBater!).toBeLessThan(0);
    expect(r.cobertura.caixaPico).toBeGreaterThan(r.retornoSeBater);
    expect(r.cobertura.avisos.join(' ')).toMatch(/se TODAS as pernas baterem você PERDE/i);
  });

  it('múltipla: caminho all-green positivo é informado como lucro', () => {
    const r = calcularMultiplaQualificadora({
      stake: 50,
      pernas: [
        { odd: 2.0, oddCobertura: 2.2, resolveEm: 'dia 1' },
        { odd: 2.1, oddCobertura: 2.1, resolveEm: 'dia 2' },
      ],
    })!;
    expect(r.cobertura.lucroSeTudoBater!).toBeGreaterThan(0);
    expect(r.cobertura.avisos.join(' ')).toMatch(/lucro é R\$/i);
  });

  it('múltipla: perna sem odd de cobertura interrompe a cadeia (não inventa passo)', () => {
    const r = calcularMultiplaQualificadora({
      stake: 100,
      pernas: [
        { odd: 1.6, oddCobertura: 2.5, resolveEm: 'dia 1' },
        { odd: 1.5, oddCobertura: null, resolveEm: 'dia 2' },
        { odd: 1.65, oddCobertura: 2.4, resolveEm: 'dia 3' },
      ],
    })!;
    expect(r.cobertura.possivel).toBe(false);
    expect(r.cobertura.passos[0].aporte).not.toBeNull();
    // A partir da perna sem odd, nada é calculado (o gasto acumulado seria fictício).
    expect(r.cobertura.passos[1].aporte).toBeNull();
    expect(r.cobertura.passos[2].aporte).toBeNull();
    expect(r.cobertura.lucroSeTudoBater).toBeNull();
  });

  it('cashback NÃO condicional não entra na equalização (só soma no lucro)', () => {
    const semCb = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 4, coverOdd: 1.3 })!;
    const cbSempre = calcularPromocao({
      tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 4, coverOdd: 1.3, cashback: 5, cashbackSoSePerder: false,
    })!;
    // Mesmo aporte (o cashback é constante), lucro maior nos DOIS cenários, e equalizado.
    expect(cbSempre.coverStake).toBeCloseTo(semCb.coverStake, 2);
    expect(cbSempre.equalizado).toBe(true);
    expect(cbSempre.lucroSePromoGanha).toBeCloseTo(semCb.lucroSePromoGanha + 5, 2);
    expect(cbSempre.lucroSeCoberturaGanha).toBeCloseTo(semCb.lucroSeCoberturaGanha + 5, 2);
  });

  it('equalizado compara os LUCROS, não o aporte', () => {
    const r = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 4, coverOdd: 1.3, coverStake: 5 })!;
    expect(r.equalizado).toBe(false);
    expect(Math.abs(r.lucroSePromoGanha - r.lucroSeCoberturaGanha)).toBeGreaterThan(0.02);
  });

  it('aviso de freebet esticada sugere a cobertura DA ODD ÓTIMA (não a atual)', () => {
    const r = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 10, promoOdd: 7.75, coverOdd: 1.06 })!;
    const aviso = r.avisos.join(' ');
    expect(aviso).toMatch(/o ótimo é odd 3\.6\d/);
    // A cobertura sugerida NÃO pode colapsar na odd ruim que ele já tinha (1.06).
    expect(aviso).toMatch(/costuma pagar ~1\.2\d/);
  });

  it('curva marca odds fora do domínio do modelo em vez de devolver número sem sentido', () => {
    const c = curvaRetencaoFreebet(10, 0.06, [4, 15, 20, 30]);
    expect(c.oddMaximaDoModelo).toBeCloseTo(1 + 1 / 0.06, 1);
    expect(c.curva.find((p) => p.promoOdd === 4)!.foraDoDominio).toBeUndefined();
    expect(c.curva.find((p) => p.promoOdd === 20)!.foraDoDominio).toBe(true);
    expect(c.curva.find((p) => p.promoOdd === 30)!.foraDoDominio).toBe(true);
  });

  it('doutrina bate com a matemática: retenção no ótimo por margem', () => {
    for (const [m, esperado] of [[0.05, 64.2], [0.06, 61.6], [0.08, 57.2]] as Array<[number, number]>) {
      const o = oddIdealFreebet(m);
      expect(retencaoTeorica(o, m) * 100).toBeCloseTo(esperado, 0);
    }
  });
});
