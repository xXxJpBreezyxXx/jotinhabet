import { describe, it, expect } from 'vitest';
import {
  calcularPromocao,
  calcularMultiplaQualificadora,
  cashbackParaZerar,
  curvaRetencaoFreebet,
  margemImplicita,
  oddIdealFreebet,
  promoTypeDoTipo,
  PROMO_TYPES_BANCO,
  retencaoTeorica,
  TIPOS_PROMOCAO,
  tipoDoPromoType,
  tipoPromocaoDeTexto,
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

describe('calcularPromocao — PROTEÇÃO (devolução da aposta perdida)', () => {
  it('caso base do usuário: R$ 100 @2.00 com 50% de volta, cobertura @2.05 → lucro travado', () => {
    const r = calcularPromocao({
      tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05, cashbackPct: 50,
    })!;
    expect(r.cashbackNominal).toBeCloseTo(50, 2);
    expect(r.cashbackEfetivo).toBeCloseTo(50, 2); // dinheiro real → sem deságio
    expect(r.coverStake).toBeCloseTo(73.17, 2);   // (100·2,00 − 50)/2,05
    expect(r.lucroSePromoGanha).toBeCloseTo(26.83, 2);
    expect(r.lucroSeCoberturaGanha).toBeCloseTo(26.83, 2);
    expect(r.equalizado).toBe(true);
    // Dinheiro real na mesa é stake + cobertura: a devolução chega DEPOIS.
    expect(r.investimentoReal).toBeCloseTo(173.17, 2);
    expect(r.roiPct!).toBeCloseTo(15.49, 1);
    expect(r.retencaoPct).toBeNull();
  });

  it('% da stake e valor em reais são equivalentes', () => {
    const porPct = calcularPromocao({ tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05, cashbackPct: 50 })!;
    const porReais = calcularPromocao({ tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05, cashback: 50 })!;
    expect(porReais.coverStake).toBeCloseTo(porPct.coverStake, 2);
    expect(porReais.lucroGarantido).toBeCloseTo(porPct.lucroGarantido, 2);
  });

  it('teto corta a devolução e aponta a stake que aproveita o percentual cheio', () => {
    const r = calcularPromocao({
      tipo: 'PROTECAO', promoStake: 200, promoOdd: 2.0, coverOdd: 2.05, cashbackPct: 50, cashbackTeto: 50,
    })!;
    expect(r.cashbackNominal).toBeCloseTo(50, 2); // 50% de 200 = 100, mas o teto é 50
    expect(r.avisos.join(' ')).toMatch(/teto de R\$ 50,?\.?00/i);
    expect(r.avisos.join(' ')).toMatch(/R\$ 100,?\.?00/); // stake ótima = teto ÷ %
  });

  it('devolução em BÔNUS entra pelo valor efetivo (70%) e separa o caixa do dia', () => {
    const emDinheiro = calcularPromocao({ tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05, cashbackPct: 50 })!;
    const emBonus = calcularPromocao({
      tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05, cashbackPct: 50, cashbackEhBonus: true,
    })!;
    expect(emBonus.cashbackNominal).toBeCloseTo(50, 2);
    expect(emBonus.cashbackEfetivo).toBeCloseTo(35, 2); // 70% da face
    expect(emBonus.coverStake).toBeCloseTo(80.49, 2);   // (200 − 35)/2,05 — cobre mais
    expect(emBonus.lucroGarantido).toBeLessThan(emDinheiro.lucroGarantido);
    // Se a promo perder, o caixa do dia é NEGATIVO até o bônus ser convertido.
    expect(emBonus.lucroEmCaixaSeCoberturaGanha).toBeCloseTo(emBonus.lucroSeCoberturaGanha - 35, 2);
    expect(emBonus.lucroEmCaixaSeCoberturaGanha).toBeLessThan(0);
    expect(emBonus.avisos.join(' ')).toMatch(/B[ÔO]NUS/);
  });

  it('valor do bônus configurável (bônus difícil de converter vale menos)', () => {
    const r = calcularPromocao({
      tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05,
      cashbackPct: 50, cashbackEhBonus: true, valorBonusPct: 50,
    })!;
    expect(r.cashbackEfetivo).toBeCloseTo(25, 2);
    expect(r.coverStake).toBeCloseTo((200 - 25) / 2.05, 2);
  });

  it('em dinheiro real, o caixa do cenário de perda é o próprio lucro', () => {
    const r = calcularPromocao({ tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05, cashbackPct: 50 })!;
    expect(r.lucroEmCaixaSeCoberturaGanha).toBeCloseTo(r.lucroSeCoberturaGanha, 2);
  });

  it('proteção sem devolução informada avisa (a conta virou qualificativa e dá prejuízo)', () => {
    const r = calcularPromocao({ tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 1.9 })!;
    expect(r.cashbackNominal).toBe(0);
    expect(r.lucroGarantido).toBeLessThan(0);
    expect(r.avisos.join(' ')).toMatch(/PROTEÇÃO sem devolução/i);
  });

  it('devolução abaixo do piso D₀ avisa proteção insuficiente e mostra o alvo', () => {
    const r = calcularPromocao({ tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 1.9, cashbackPct: 5 })!;
    expect(r.lucroGarantido).toBeLessThan(0);
    const texto = r.avisos.join(' ');
    expect(texto).toMatch(/Proteção insuficiente/i);
    expect(texto).toMatch(/R\$ 10,?\.?00/);  // D₀ = 100·(2,00 − 1,90) = R$ 10
    expect(texto).toMatch(/10,?\.?0%/);
  });

  it('devolução incondicional não é proteção: avisa e não muda o aporte', () => {
    const condicional = calcularPromocao({ tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05, cashbackPct: 50 })!;
    const sempre = calcularPromocao({
      tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05, cashbackPct: 50, cashbackSoSePerder: false,
    })!;
    expect(sempre.coverStake).toBeCloseTo((100 * 2.0) / 2.05, 2); // sem o desconto da devolução
    expect(sempre.coverStake).toBeGreaterThan(condicional.coverStake);
    expect(sempre.avisos.join(' ')).toMatch(/incondicional/i);
  });

  it('D₀ = S·(O − H·(O−1)) é o piso exato: com D = D₀ o lucro é zero', () => {
    expect(cashbackParaZerar(100, 2.0, 1.9)).toBeCloseTo(10, 2);
    const r = calcularPromocao({ tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 1.9, cashback: 10 })!;
    expect(r.lucroGarantido).toBeCloseTo(0, 2);
    // Par de odds que já é surebet: o piso é negativo (não precisa de promoção nenhuma).
    expect(cashbackParaZerar(100, 2.0, 2.05)).toBeLessThan(0);
  });

  it('tipoPromocaoDeTexto entende o vocabulário do usuário', () => {
    expect(tipoPromocaoDeTexto('PROTECAO')).toBe('PROTECAO');
    expect(tipoPromocaoDeTexto('proteção')).toBe('PROTECAO');
    expect(tipoPromocaoDeTexto('cashback de 50%')).toBe('PROTECAO');
    expect(tipoPromocaoDeTexto('seguro da aposta')).toBe('PROTECAO');
    expect(tipoPromocaoDeTexto('devolução se perder')).toBe('PROTECAO');
    expect(tipoPromocaoDeTexto('QUALIFICATIVA')).toBe('QUALIFICATIVA');
    expect(tipoPromocaoDeTexto('aposta qualificadora')).toBe('QUALIFICATIVA');
    expect(tipoPromocaoDeTexto('freebet')).toBe('FREEBET_SNR');
    expect(tipoPromocaoDeTexto(undefined)).toBe('FREEBET_SNR');
  });
});

describe('calcularPromocao — FREEBET_SRR (a ficha volta)', () => {
  it('R = S·O (não S·(O−1)): o aporte é O/(O−1) vezes o da SNR e a retenção passa de 100%', () => {
    const srr = calcularPromocao({ tipo: 'FREEBET_SRR', promoStake: 50, promoOdd: 2.0, coverOdd: 2.05 })!;
    const snr = calcularPromocao({ tipo: 'FREEBET_SNR', promoStake: 50, promoOdd: 2.0, coverOdd: 2.05 })!;
    expect(srr.coverStake).toBeCloseTo(100 / 2.05, 2); // 48,78
    expect(srr.coverStake / snr.coverStake).toBeCloseTo(2.0 / (2.0 - 1), 3);
    expect(srr.lucroSePromoGanha).toBeCloseTo(51.22, 2);
    expect(srr.lucroSeCoberturaGanha).toBeCloseTo(51.22, 2);
    // A ficha é grátis: o investimento real é só a cobertura.
    expect(srr.investimentoReal).toBeCloseTo(srr.coverStake, 2);
    // Retenção > 100% é CORRETO na SRR (a ficha volta, então o lucro supera o valor dela).
    expect(srr.retencaoPct!).toBeGreaterThan(100);
    expect(srr.retencaoPct!).toBeCloseTo(102.44, 1);
  });

  it('retenção segue 1 − m·(O−1): odd baixa retém mais e imobiliza menos caixa', () => {
    // H = O/((O−1)·(1+m)) com m = 6% → o par tem margem medida de exatamente 6%.
    const oddH = (o: number) => o / ((o - 1) * 1.06);
    const baixa = calcularPromocao({ tipo: 'FREEBET_SRR', promoStake: 100, promoOdd: 1.5, coverOdd: oddH(1.5) })!;
    const alta = calcularPromocao({ tipo: 'FREEBET_SRR', promoStake: 100, promoOdd: 4.0, coverOdd: oddH(4.0) })!;
    expect(baixa.retencaoPct!).toBeCloseTo(97, 0); // 1 − 0,06·0,5
    expect(alta.retencaoPct!).toBeCloseTo(82, 0); // 1 − 0,06·3,0
    expect(baixa.retencaoPct!).toBeGreaterThan(alta.retencaoPct!);
    // E o caixa preso na cobertura é proporcional a (O−1): 6× menor em odd 1,50.
    expect(alta.coverStake / baixa.coverStake).toBeCloseTo(3 / 0.5, 1);
  });

  it('SNR e SRR têm ótimos OPOSTOS: a SRR avisa para descer a odd', () => {
    const r = calcularPromocao({ tipo: 'FREEBET_SRR', promoStake: 100, promoOdd: 4.0, coverOdd: 1.25 })!;
    expect(r.avisos.join(' ')).toMatch(/menor odd/i);
    expect(r.avisos.join(' ')).not.toMatch(/queima a retenção/i); // aviso da SNR não vaza
    // oddIdealFreebet com v=1 não tem pico interior (e não devolve NaN cru para a UI).
    expect(Number.isFinite(oddIdealFreebet(0.06, 1))).toBe(false);
    expect(oddIdealFreebet(0.06, 0)).toBeCloseTo(Math.sqrt(1 + 1 / 0.06), 3);
    const curva = curvaRetencaoFreebet(100, 0.06, [1.5, 2, 4], 1);
    expect(curva.direcaoDoOtimo).toBe('menor-odd');
    expect(curva.oddIdeal).toBeNull();
    expect(curva.curva[0].retencaoPct).toBeGreaterThan(curva.curva[2].retencaoPct);
  });

  it('ficha que volta em BÔNUS: R = S·(O−1+v) e o caixa do green fica menor que o lucro', () => {
    const r = calcularPromocao({
      tipo: 'FREEBET_SRR', promoStake: 100, promoOdd: 2.0, coverOdd: 1.8868, valorFichaPct: 70,
    })!;
    expect(r.retornoBrutoPromo).toBeCloseTo(170, 2); // 100·(2−1+0,7)
    expect(r.coverStake).toBeCloseTo(90.1, 1);
    expect(r.lucroGarantido).toBeCloseTo(79.9, 1);
    expect(r.bonusSePromoGanha).toBeCloseTo(70, 2);
    expect(r.lucroEmCaixaSePromoGanha).toBeCloseTo(9.9, 1);
    expect(r.avisos.join(' ')).toMatch(/BÔNUS/);
  });

  it('teto de GANHO e teto de RETORNO não são a mesma fórmula (o erro que faz o green fechar negativo)', () => {
    const base = { tipo: 'FREEBET_SRR' as const, promoStake: 100, promoOdd: 4.0, coverOdd: 1.2578616, tetoGanho: 100 };
    const sobreGanho = calcularPromocao({ ...base, tetoIncideSobre: 'GANHO' })!;
    const sobreRetorno = calcularPromocao({ ...base, tetoIncideSobre: 'RETORNO' })!;
    // "ganhe até R$ 100": paga a ficha de volta + 100 → R = 200.
    expect(sobreGanho.retornoBrutoPromo).toBeCloseTo(200, 2);
    expect(sobreGanho.coverStake).toBeCloseTo(159.0, 1);
    expect(sobreGanho.lucroGarantido).toBeCloseTo(41.0, 1);
    // "retorno máximo R$ 100": a casa paga 100 e ponto → R = 100, aporte MUITO menor.
    expect(sobreRetorno.retornoBrutoPromo).toBeCloseTo(100, 2);
    expect(sobreRetorno.coverStake).toBeCloseTo(79.5, 1);
    expect(sobreRetorno.lucroGarantido).toBeCloseTo(20.5, 1);
    // Ler "RETORNO" como "GANHO" manda aportar 159 contra um pagamento de 100: green −59.
    const lidoErrado = calcularPromocao({ ...base, tetoIncideSobre: 'RETORNO', coverStake: sobreGanho.coverStake })!;
    expect(lidoErrado.lucroSePromoGanha).toBeCloseTo(-59.0, 1);
    expect(sobreRetorno.avisos.join(' ')).toMatch(/RETORNO/);
  });

  it('tipo desconhecido não vira SNR em silêncio', () => {
    const r = calcularPromocao({ tipo: 'FREEBET_XX' as any, promoStake: 50, promoOdd: 2, coverOdd: 2 })!;
    expect(r.tipo).toBe('FREEBET_SNR');
    expect(r.avisos.join(' ')).toMatch(/desconhecido/i);
  });
});

describe('calcularPromocao — SUPERODD (odd turbinada)', () => {
  it('boost em DINHEIRO colapsa na surebet clássica', () => {
    const r = calcularPromocao({
      tipo: 'SUPERODD', promoStake: 30, promoOdd: 2.0, oddPadrao: 1.6, coverOdd: 2.5,
    })!;
    expect(r.coverStake).toBeCloseTo(24, 2); // 60/2,5
    expect(r.lucroSePromoGanha).toBeCloseTo(6, 2);
    expect(r.lucroSeCoberturaGanha).toBeCloseTo(6, 2);
    expect(r.roiPct!).toBeCloseTo(11.11, 1);
    expect(r.oddEfetivaPromo).toBeCloseTo(2.0, 3);
    expect(r.retencaoPct).toBeNull(); // dinheiro real: retenção não se aplica
  });

  it('boost em BÔNUS: a casa paga a odd padrão em caixa e o excedente vira freebet', () => {
    const r = calcularPromocao({
      tipo: 'SUPERODD', promoStake: 30, promoOdd: 2.0, oddPadrao: 1.6, coverOdd: 2.5, extraEmBonus: true,
    })!;
    expect(r.extraNominal).toBeCloseTo(12, 2); // 30·(2,00−1,60)
    expect(r.extraEfetivo).toBeCloseTo(8.4, 2); // 70%
    expect(r.retornoBrutoPromo).toBeCloseTo(56.4, 2); // 48 + 8,4
    expect(r.coverStake).toBeCloseTo(22.56, 2);
    expect(r.lucroGarantido).toBeCloseTo(3.84, 2);
    // O bônus cai no GREEN (ramo oposto ao da proteção): o caixa do dia fica negativo.
    expect(r.bonusSePromoGanha).toBeCloseTo(8.4, 2);
    expect(r.lucroEmCaixaSePromoGanha).toBeCloseTo(-4.56, 2);
    expect(r.lucroEmCaixaSeCoberturaGanha).toBeCloseTo(r.lucroSeCoberturaGanha, 2);
  });

  it('teto de stake manda a conta ser feita na parte elegível (e avisa)', () => {
    const semTeto = calcularPromocao({ tipo: 'SUPERODD', promoStake: 100, promoOdd: 2.0, oddPadrao: 1.6, coverOdd: 2.5 })!;
    const comTeto = calcularPromocao({
      tipo: 'SUPERODD', promoStake: 100, promoOdd: 2.0, oddPadrao: 1.6, coverOdd: 2.5, tetoStake: 30,
    })!;
    expect(comTeto.stakeElegivel).toBeCloseTo(30, 2);
    expect(comTeto.coverStake).toBeCloseTo(24, 2); // idêntico ao caso de S=30
    expect(comTeto.lucroGarantido).toBeCloseTo(6, 2);
    expect(comTeto.investimentoReal).toBeCloseTo(54, 2); // 30 + 24, não 100 + algo
    expect(semTeto.coverStake).toBeGreaterThan(comTeto.coverStake);
    expect(comTeto.avisos.join(' ')).toMatch(/teto de stake/i);
  });

  it('sem a odd padrão avisa (medir a margem pela odd turbinada esconde o pedágio)', () => {
    const r = calcularPromocao({ tipo: 'SUPERODD', promoStake: 30, promoOdd: 2.0, coverOdd: 2.5 })!;
    expect(r.avisos.join(' ')).toMatch(/odd PADRÃO/i);
    expect(r.extraNominal).toBe(0);
  });

  it('super odd que não paga a margem avisa com o extra que faltou', () => {
    const r = calcularPromocao({
      tipo: 'SUPERODD', promoStake: 100, promoOdd: 1.7, oddPadrao: 1.6, coverOdd: 2.0, extraEmBonus: true,
    })!;
    expect(r.lucroGarantido).toBeLessThan(0);
    const texto = r.avisos.join(' ');
    expect(texto).toMatch(/Boost insuficiente/i);
    expect(texto).not.toMatch(/devolução efetiva precisaria/i); // piso da proteção não vaza
    // Piso: S·(H/(H−1) − odd base) = 100·(2,00 − 1,60) = R$ 40,00 de extra efetivo.
    expect(r.extraParaZerar!).toBeCloseTo(40, 2);
  });
});

describe('calcularPromocao — LUCRO_EXTRA (profit boost)', () => {
  it('o boost incide sobre o LUCRO: R = S·O + b·S·(O−1)', () => {
    const r = calcularPromocao({ tipo: 'LUCRO_EXTRA', promoStake: 100, promoOdd: 2.0, coverOdd: 1.9, boostPct: 30 })!;
    expect(r.extraNominal).toBeCloseTo(30, 2); // 30% de 100 de lucro
    expect(r.retornoBrutoPromo).toBeCloseTo(230, 2);
    expect(r.oddEfetivaPromo).toBeCloseTo(2.3, 3);
    expect(r.coverStake).toBeCloseTo(121.05, 1);
    expect(r.lucroSePromoGanha).toBeCloseTo(8.95, 1);
    expect(r.lucroSeCoberturaGanha).toBeCloseTo(8.95, 1);
  });

  it('boost sobre o VALOR APOSTADO é outro regulamento (e outro número)', () => {
    const sobreLucro = calcularPromocao({ tipo: 'LUCRO_EXTRA', promoStake: 100, promoOdd: 3.0, coverOdd: 1.55, boostPct: 30 })!;
    const sobreStake = calcularPromocao({
      tipo: 'LUCRO_EXTRA', promoStake: 100, promoOdd: 3.0, coverOdd: 1.55, boostPct: 30, boostSobreStake: true,
    })!;
    expect(sobreLucro.extraNominal).toBeCloseTo(60, 2); // 30% de 200 de lucro
    expect(sobreStake.extraNominal).toBeCloseTo(30, 2); // 30% de 100 apostados
    expect(sobreStake.avisos.join(' ')).toMatch(/VALOR APOSTADO/);
  });

  it('teto do extra corta a FACE antes da valorização, e stake grande passa a piorar', () => {
    const r = calcularPromocao({
      tipo: 'LUCRO_EXTRA', promoStake: 500, promoOdd: 2.0, coverOdd: 1.9, boostPct: 30, tetoExtra: 50,
    })!;
    expect(r.extraNominal).toBeCloseTo(50, 2); // 30% de 500 seria 150
    expect(r.retornoBrutoPromo).toBeCloseTo(1050, 2);
    expect(r.coverStake).toBeCloseTo(552.63, 1);
    // Mesmo com boost de 30% (acima do piso), a stake grande com teto vira prejuízo.
    expect(r.lucroGarantido).toBeCloseTo(-2.63, 1);
    const texto = r.avisos.join(' ');
    expect(texto).toMatch(/teto/i);
    expect(texto).toMatch(/reduza a stake/i);
  });

  it('extra em bônus valendo 0% é entrada válida (não cai no default de 70%)', () => {
    const zero = calcularPromocao({
      tipo: 'LUCRO_EXTRA', promoStake: 100, promoOdd: 2.0, coverOdd: 1.9,
      boostPct: 30, extraEmBonus: true, valorExtraPct: 0,
    })!;
    const padrao = calcularPromocao({
      tipo: 'LUCRO_EXTRA', promoStake: 100, promoOdd: 2.0, coverOdd: 1.9, boostPct: 30, extraEmBonus: true,
    })!;
    expect(zero.extraEfetivo).toBe(0);
    expect(padrao.extraEfetivo).toBeCloseTo(21, 2); // 70% de 30
    expect(zero.lucroGarantido).toBeLessThan(0);
    expect(zero.avisos.join(' ')).toMatch(/SEM VALOR/i);
  });

  it('piso do extra: extraParaZerar = S·(H/(H−1) − O) e o aviso mostra o boost mínimo', () => {
    const r = calcularPromocao({ tipo: 'LUCRO_EXTRA', promoStake: 100, promoOdd: 4.0, coverOdd: 1.25, boostPct: 30 })!;
    expect(r.extraParaZerar!).toBeCloseTo(100, 2); // 100·(5,00 − 4,00)
    expect(r.extraNominal).toBeCloseTo(90, 2);
    expect(r.lucroGarantido).toBeCloseTo(-2, 1);
    expect(r.avisos.join(' ')).toMatch(/33[,.]3/); // boost mínimo ~33,3%
  });

  it('sem percentual informado avisa que virou qualificativa crua', () => {
    const r = calcularPromocao({ tipo: 'LUCRO_EXTRA', promoStake: 100, promoOdd: 2.0, coverOdd: 1.9 })!;
    expect(r.extraNominal).toBe(0);
    expect(r.lucroGarantido).toBeLessThan(0);
    expect(r.avisos.join(' ')).toMatch(/sem o percentual/i);
  });

  // Regressão pega no smoke em produção: o endpoint manda os campos opcionais como `null`
  // explícito, e `Number(null)` é 0 — então "ausente" virava ZERO, que tem significado nesses
  // campos. A SRR caía para matemática de SNR (aporte pela metade) e o bônus da proteção
  // passava a valer 0% em vez de 70%.
  it('campo ausente enviado como null se comporta como ausente, não como zero', () => {
    const omitido = calcularPromocao({ tipo: 'FREEBET_SRR', promoStake: 50, promoOdd: 2.0, coverOdd: 2.05 })!;
    const nulo = calcularPromocao({
      tipo: 'FREEBET_SRR', promoStake: 50, promoOdd: 2.0, coverOdd: 2.05, valorFichaPct: null,
    })!;
    expect(nulo.coverStake).toBeCloseTo(omitido.coverStake, 2);
    expect(nulo.coverStake).toBeCloseTo(48.78, 2); // SRR, não os 24,39 da SNR
    expect(nulo.retornoBrutoPromo).toBeCloseTo(100, 2);

    // Mesma armadilha na valorização do bônus: null = default 70%, 0 = "não vale nada".
    const bonusPadrao = calcularPromocao({
      tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05,
      cashbackPct: 50, cashbackEhBonus: true, valorBonusPct: null,
    })!;
    expect(bonusPadrao.cashbackEfetivo).toBeCloseTo(35, 2); // 70% de 50
    const bonusZero = calcularPromocao({
      tipo: 'PROTECAO', promoStake: 100, promoOdd: 2.0, coverOdd: 2.05,
      cashbackPct: 50, cashbackEhBonus: true, valorBonusPct: 0,
    })!;
    expect(bonusZero.cashbackEfetivo).toBe(0);
  });

  it('tradutor único banco ↔ core (ida e volta em todos os tipos)', () => {
    expect(tipoDoPromoType('QUALIFYING')).toBe('QUALIFICATIVA');
    expect(promoTypeDoTipo('QUALIFICATIVA')).toBe('QUALIFYING');
    for (const tipo of TIPOS_PROMOCAO) {
      const noBanco = promoTypeDoTipo(tipo);
      expect(PROMO_TYPES_BANCO).toContain(noBanco as any);
      expect(tipoDoPromoType(noBanco)).toBe(tipo); // round-trip sem perda
    }
    expect(tipoDoPromoType('BANANA')).toBe('FREEBET_SNR');
  });

  it('tipoPromocaoDeTexto roteia o vocabulário dos tipos novos', () => {
    expect(tipoPromocaoDeTexto('SUPERODD')).toBe('SUPERODD');
    expect(tipoPromocaoDeTexto('super odd')).toBe('SUPERODD');
    expect(tipoPromocaoDeTexto('odd turbinada')).toBe('SUPERODD');
    expect(tipoPromocaoDeTexto('LUCRO_EXTRA')).toBe('LUCRO_EXTRA');
    expect(tipoPromocaoDeTexto('lucro extra de 30%')).toBe('LUCRO_EXTRA');
    expect(tipoPromocaoDeTexto('profit boost')).toBe('LUCRO_EXTRA');
    expect(tipoPromocaoDeTexto('FREEBET_SRR')).toBe('FREEBET_SRR');
    expect(tipoPromocaoDeTexto('aposta grátis que devolve a ficha')).toBe('FREEBET_SRR');
    expect(tipoPromocaoDeTexto('freebet')).toBe('FREEBET_SNR');
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
