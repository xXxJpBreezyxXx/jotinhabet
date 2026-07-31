/**
 * Matemática das APOSTAS DE PROMOÇÃO (matched betting) — o núcleo que as skills do
 * Agente e a aba "Promoções" usam.
 *
 * Fonte da doutrina: IA/conhecimento/doutrinaPromocoes.ts (destilada da conversa do
 * usuário com o Gemini em 30/07/2026). Aqui é só matemática pura e testável, sem I/O.
 *
 * Convenção de sinais: TODO valor de lucro é em reais e pode ser negativo (o
 * qualificador quase sempre é). Nada de arredondar antes do fim: só as saídas são
 * arredondadas (2 casas), para o aporte poder ser digitado "no centavo".
 */

import { oddEfetiva } from '../arbitrage/comissao';

export type TipoPromocao = 'FREEBET_SNR' | 'QUALIFICATIVA';

const r2 = (v: number): number => Math.round(v * 100) / 100;
const num = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);

export interface EntradaPromocao {
  tipo: TipoPromocao;
  /** Valor da freebet (SNR) ou stake real (qualificativa). */
  promoStake: number;
  /** Odd da perna promocional. */
  promoOdd: number;
  /** Odd do mercado OPOSTO na casa de cobertura. */
  coverOdd: number;
  /** Aporte da cobertura. Ausente/0 → calculado para EQUALIZAR os dois cenários. */
  coverStake?: number | null;
  /** Cashback em reais já garantido/prometido pela casa da promo. */
  cashback?: number | null;
  /** true (default) = cashback só entra se a perna promocional PERDER. */
  cashbackSoSePerder?: boolean;
  /** Nomes das casas — usados só para descontar comissão de exchange na odd. */
  casaPromo?: string | null;
  casaCobertura?: string | null;
}

export interface ResultadoPromocao {
  tipo: TipoPromocao;
  promoStake: number;
  promoOdd: number;
  coverOdd: number;
  /** Odds efetivas (com comissão de exchange descontada, quando houver). */
  promoOddEfetiva: number;
  coverOddEfetiva: number;
  coverStake: number;
  coverStakeEqualizado: number;
  /** Dinheiro real que sai do bolso (freebet SNR não conta a ficha). */
  investimentoReal: number;
  /** Caixa necessário na casa de cobertura. */
  caixaCobertura: number;
  lucroSePromoGanha: number;
  lucroSeCoberturaGanha: number;
  lucroGarantido: number;
  /** ROI sobre o dinheiro real investido (null quando não há dinheiro real). */
  roiPct: number | null;
  /** Só para freebet: lucro garantido / valor da freebet. */
  retencaoPct: number | null;
  equalizado: boolean;
  avisos: string[];
}

/**
 * Cobertura de uma perna promocional.
 *
 * FREEBET SNR: a ficha não retorna → custo real 0, retorno bruto F·(O−1).
 * QUALIFICATIVA: dinheiro real → custo S, retorno bruto S·O.
 *
 * Equalização (mesmo lucro nos dois cenários), já com cashback condicional:
 *     coverStake = (retornoBrutoPromo − cashbackSePerder) / coverOdd
 */
export function calcularPromocao(entrada: EntradaPromocao): ResultadoPromocao | null {
  const tipo: TipoPromocao = entrada.tipo === 'QUALIFICATIVA' ? 'QUALIFICATIVA' : 'FREEBET_SNR';
  const promoStake = num(entrada.promoStake);
  const promoOdd = num(entrada.promoOdd);
  const coverOdd = num(entrada.coverOdd);
  if (promoStake === null || promoOdd === null || coverOdd === null) return null;
  if (promoStake <= 0 || promoOdd <= 1 || coverOdd <= 1) return null;

  const avisos: string[] = [];
  const promoOddEf = entrada.casaPromo ? oddEfetiva(entrada.casaPromo, promoOdd) : promoOdd;
  const coverOddEf = entrada.casaCobertura ? oddEfetiva(entrada.casaCobertura, coverOdd) : coverOdd;

  const cashback = Math.max(0, num(entrada.cashback) ?? 0);
  const soSePerder = entrada.cashbackSoSePerder !== false;
  const cashbackSePromoGanha = soSePerder ? 0 : cashback;
  const cashbackSePromoPerde = cashback;

  const ehFreebet = tipo === 'FREEBET_SNR';
  const custoRealPromo = ehFreebet ? 0 : promoStake;
  // Retorno bruto do lado promocional quando ele bate (SNR devolve só o lucro).
  const retornoBrutoPromo = ehFreebet ? promoStake * (promoOddEf - 1) : promoStake * promoOddEf;

  // Só a PARTE CONDICIONAL do cashback entra na equalização: se ele cai nos dois
  // cenários (cashbackSoSePerder=false), é uma constante e não muda o aporte que iguala
  // os lucros — antes, subtrair sempre desequalizava a operação e ainda reportava
  // equalizado=true.
  const cashbackDiferencial = cashbackSePromoPerde - cashbackSePromoGanha;
  const coverStakeEqualizado = Math.max(0, (retornoBrutoPromo - cashbackDiferencial) / coverOddEf);
  const informado = num(entrada.coverStake);
  const coverStake = informado !== null && informado > 0 ? informado : coverStakeEqualizado;

  // Cenário 1 — a perna promocional bate: recebe o retorno bruto, perde o aporte da cobertura.
  const lucroSePromoGanha = retornoBrutoPromo - custoRealPromo - coverStake + cashbackSePromoGanha;
  // Cenário 2 — a cobertura bate: lucro líquido da cobertura, perde o custo real da promo.
  const lucroSeCoberturaGanha = coverStake * (coverOddEf - 1) - custoRealPromo + cashbackSePromoPerde;

  // "Equalizado" = os dois cenários pagam IGUAL (é isso que interessa), não "o aporte
  // saiu da nossa conta". Com cashback ou clamp em zero, o aporte podia bater com o
  // calculado e os lucros continuarem diferentes.
  const equalizado = Math.abs(lucroSePromoGanha - lucroSeCoberturaGanha) < 0.02;
  const lucroGarantido = Math.min(lucroSePromoGanha, lucroSeCoberturaGanha);
  const investimentoReal = custoRealPromo + coverStake;
  const roiPct = investimentoReal > 0 ? (lucroGarantido / investimentoReal) * 100 : null;
  const retencaoPct = ehFreebet ? (lucroGarantido / promoStake) * 100 : null;

  if (ehFreebet && coverOdd < 1.1 && promoOdd >= 6) {
    const m = margemImplicita(promoOdd, coverOdd);
    const oddOtima = oddIdealFreebet(m);
    // A cobertura sugerida tem que ser a esperada NA ODD ÓTIMA — usando promoOdd aqui, a
    // conta voltava para a própria coverOdd atual (a margem foi medida nesse mesmo par) e
    // o aviso mandava "buscar" exatamente a odd ruim que o usuário já tinha.
    const coberturaNoOtimo = Number.isFinite(oddOtima) ? oddOtima / ((oddOtima - 1) * (1 + m)) : null;
    avisos.push(
      `Cobertura em ${coverOdd.toFixed(2)} para uma freebet de odd ${promoOdd.toFixed(2)} queima a retenção ` +
        `(~${retencaoPct?.toFixed(0)}%). Com a margem medida (${(m * 100).toFixed(1)}%), o ótimo é odd ` +
        `${Number.isFinite(oddOtima) ? oddOtima.toFixed(2) : '—'} na promoção` +
        `${coberturaNoOtimo ? `, cujo mercado oposto costuma pagar ~${coberturaNoOtimo.toFixed(2)}` : ''} ` +
        `(retenção estimada ${(retencaoTeorica(oddOtima, m) * 100).toFixed(0)}%).`
    );
  }
  if (!ehFreebet && lucroGarantido < 0) {
    avisos.push(
      `Qualificador com custo de R$ ${Math.abs(lucroGarantido).toFixed(2)} — compare com o valor extraível do bônus ` +
        'antes de executar (doutrina: perda acima de ~35% do bônus pede outro par de casas).'
    );
  }
  if (!equalizado) {
    avisos.push(
      `Os dois cenários NÃO pagam igual: promo ganha → R$ ${r2(lucroSePromoGanha).toFixed(2)}, ` +
        `cobertura ganha → R$ ${r2(lucroSeCoberturaGanha).toFixed(2)}. O aporte que equaliza é R$ ${r2(coverStakeEqualizado).toFixed(2)} ` +
        `(informado: R$ ${r2(coverStake).toFixed(2)}).`
    );
  }
  if (entrada.casaCobertura && coverOddEf !== coverOdd) {
    avisos.push(
      `Comissão de exchange na cobertura (${entrada.casaCobertura}): odd efetiva ${coverOddEf.toFixed(3)} em vez de ${coverOdd.toFixed(2)}.`
    );
  }

  return {
    tipo,
    promoStake: r2(promoStake),
    promoOdd,
    coverOdd,
    promoOddEfetiva: Math.round(promoOddEf * 1000) / 1000,
    coverOddEfetiva: Math.round(coverOddEf * 1000) / 1000,
    coverStake: r2(coverStake),
    coverStakeEqualizado: r2(coverStakeEqualizado),
    investimentoReal: r2(investimentoReal),
    caixaCobertura: r2(coverStake),
    lucroSePromoGanha: r2(lucroSePromoGanha),
    lucroSeCoberturaGanha: r2(lucroSeCoberturaGanha),
    lucroGarantido: r2(lucroGarantido),
    roiPct: roiPct === null ? null : r2(roiPct),
    retencaoPct: retencaoPct === null ? null : r2(retencaoPct),
    equalizado,
    avisos,
  };
}

/**
 * Margem implícita do mercado de cobertura, dado o par (odd da promo, odd oposta real).
 * A odd justa oposta de O é O/(O−1); se a casa oferece C, a margem é justa/C − 1.
 */
export function margemImplicita(promoOdd: number, coverOdd: number): number {
  if (!(promoOdd > 1) || !(coverOdd > 1)) return 0;
  const justaOposta = promoOdd / (promoOdd - 1);
  return Math.max(0, justaOposta / coverOdd - 1);
}

/** Odd de freebet que MAXIMIZA a retenção para uma margem m do mercado oposto: √(1 + 1/m). */
export function oddIdealFreebet(margem: number): number {
  if (!(margem > 0)) return Infinity;
  return Math.sqrt(1 + 1 / margem);
}

/** Retenção teórica R(O) = (O−1)·(1 − m·(O−1))/O (fração, pode ficar negativa em odd absurda). */
export function retencaoTeorica(promoOdd: number, margem: number): number {
  if (!(promoOdd > 1)) return 0;
  const u = promoOdd - 1;
  return (u * (1 - margem * u)) / promoOdd;
}

export interface CurvaRetencao {
  margemPct: number;
  oddIdeal: number;
  retencaoIdealPct: number;
  coverOddNoIdeal: number;
  /** Odd a partir da qual o modelo perde sentido (cobertura estimada ≤ 1,01). */
  oddMaximaDoModelo: number;
  curva: Array<{
    promoOdd: number;
    coverOddEstimada: number;
    retencaoPct: number;
    lucroEstimado: number;
    /** true = fora do domínio do modelo (nenhuma casa cobre a esse preço). */
    foraDoDominio?: boolean;
  }>;
}

/**
 * Curva de retenção da freebet por odd, dada a margem do mercado de cobertura.
 * Serve para responder "vale pegar odd 7.75?" com número em vez de intuição.
 *
 * A margem pode vir medida (par odd promo × odd de cobertura REAL observada na casa)
 * — é o uso preferido — ou estimada (default 6%, típico de mercado 2-vias BR).
 */
export function curvaRetencaoFreebet(freebetStake: number, margem = 0.06, odds?: number[]): CurvaRetencao {
  const m = margem > 0 ? margem : 0.06;
  const grade = odds && odds.length ? odds : [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7.75, 10];
  const oddIdeal = oddIdealFreebet(m);
  const coverOddDe = (O: number) => O / ((O - 1) * (1 + m));
  // Domínio: acima de 1 + 1/m a "cobertura estimada" cai para ≤ 1,00 — não existe casa
  // pagando isso, e a retenção calculada fica negativa. Marcar é melhor que devolver
  // número sem sentido quando o usuário pede uma odd absurda (ex.: 30.00).
  const oddMaximaDoModelo = 1 + 1 / m;
  return {
    margemPct: r2(m * 100),
    oddIdeal: Math.round(oddIdeal * 100) / 100,
    retencaoIdealPct: r2(retencaoTeorica(oddIdeal, m) * 100),
    coverOddNoIdeal: Math.round(coverOddDe(oddIdeal) * 1000) / 1000,
    oddMaximaDoModelo: Math.round(oddMaximaDoModelo * 100) / 100,
    curva: grade
      .filter((o) => o > 1)
      .map((o) => {
        const ret = retencaoTeorica(o, m);
        const cover = coverOddDe(o);
        const fora = !(cover > 1.01) || ret <= 0;
        return {
          promoOdd: o,
          coverOddEstimada: Math.round(cover * 1000) / 1000,
          retencaoPct: r2(ret * 100),
          lucroEstimado: r2(ret * freebetStake),
          ...(fora ? { foraDoDominio: true } : {}),
        };
      }),
  };
}

// ─────────────────── múltipla qualificadora + cobertura sequencial ───────────────────

export interface PernaMultipla {
  descricao?: string;
  /** Odd da seleção no bilhete da promoção. */
  odd: number;
  /** Odd do mercado OPOSTO na casa de cobertura (se já conhecida). */
  oddCobertura?: number | null;
  /** Horário/momento de RESOLUÇÃO da perna (ex.: "30/07 19:30 (1º tempo)"). */
  resolveEm?: string | null;
}

export interface EntradaMultipla {
  stake: number;
  pernas: PernaMultipla[];
  /** Requisitos do regulamento da promoção. */
  oddTotalMinima?: number | null;
  oddMinimaPorPerna?: number | null;
  /** Perda que você aceita no pior caminho (0 = cobertura total). */
  perdaAceita?: number | null;
}

export interface ResultadoMultipla {
  stake: number;
  oddTotal: number;
  qualifica: boolean;
  problemas: string[];
  /** Odd sugerida por perna para bater a odd total mínima de forma equilibrada. */
  oddPorPernaEquilibrada: number | null;
  /** Retorno do bilhete se TODAS as pernas baterem. */
  retornoSeBater: number;
  cobertura: {
    possivel: boolean;
    /** Passo a passo: só aposte o passo k depois do green da perna k−1. */
    passos: Array<{
      perna: number;
      descricao: string;
      oddCobertura: number | null;
      aporte: number | null;
      gastoAcumulado: number;
      seRedRecebe: number | null;
      resultadoSeRed: number | null;
      resolveEm: string | null;
    }>;
    caixaPico: number;
    lucroSeTudoBater: number | null;
    avisos: string[];
  };
}

/**
 * Valida a múltipla contra o regulamento e monta a COBERTURA SEQUENCIAL.
 *
 * Fórmula por perna (doutrina cobertura-sequencial):
 *     x_k = (stake + Σ x_anteriores − perdaAceita) / (h_k − 1)
 * Se a perna k dá red, a cobertura k paga x_k·h_k e você recupera tudo que gastou
 * (menos a perda aceita) — a múltipla morre e as pernas seguintes não são cobertas.
 */
export function calcularMultiplaQualificadora(entrada: EntradaMultipla): ResultadoMultipla | null {
  const stake = num(entrada.stake);
  if (stake === null || stake <= 0) return null;
  const pernas = (entrada.pernas || []).filter((p) => num(p.odd) !== null && Number(p.odd) > 1);
  if (!pernas.length) return null;

  const oddTotal = pernas.reduce((acc, p) => acc * Number(p.odd), 1);
  const problemas: string[] = [];
  const tMin = num(entrada.oddTotalMinima);
  const pMin = num(entrada.oddMinimaPorPerna);

  if (tMin !== null && oddTotal < tMin) {
    const falta = tMin / oddTotal;
    problemas.push(
      `Odd total ${oddTotal.toFixed(2)} abaixo do mínimo ${tMin.toFixed(2)} da promoção — ` +
        `adicione uma seleção de odd ≥ ${falta.toFixed(2)} ou estique um mercado.`
    );
  }
  if (pMin !== null) {
    pernas.forEach((p, i) => {
      if (Number(p.odd) < pMin) {
        problemas.push(`Perna ${i + 1} (${p.descricao || 'sem descrição'}) com odd ${Number(p.odd).toFixed(2)} < mínimo ${pMin.toFixed(2)} por seleção.`);
      }
    });
  }

  const perdaAceita = Math.max(0, num(entrada.perdaAceita) ?? 0);
  const avisos: string[] = [];
  const passos: ResultadoMultipla['cobertura']['passos'] = [];
  let gasto = stake;
  let possivel = true;

  pernas.forEach((p, i) => {
    const h = num(p.oddCobertura);
    if (h === null || h <= 1 || !possivel) {
      // Perna sem odd de cobertura interrompe a CADEIA: os passos seguintes dependem do
      // gasto acumulado desta, então calculá-los ignorando o aporte que falta produz
      // número errado com cara de certo. Do ponto da falha em diante, tudo fica pendente.
      possivel = false;
      passos.push({
        perna: i + 1,
        descricao: p.descricao || `Perna ${i + 1}`,
        oddCobertura: h !== null && h > 1 ? h : null,
        aporte: null,
        gastoAcumulado: r2(gasto),
        seRedRecebe: null,
        resultadoSeRed: null,
        resolveEm: p.resolveEm || null,
      });
      return;
    }
    const aporte = (gasto - perdaAceita) / (h - 1);
    const gastoDepois = gasto + aporte;
    const recebe = aporte * h;
    passos.push({
      perna: i + 1,
      descricao: p.descricao || `Perna ${i + 1}`,
      oddCobertura: h,
      aporte: r2(aporte),
      gastoAcumulado: r2(gastoDepois),
      seRedRecebe: r2(recebe),
      resultadoSeRed: r2(recebe - gastoDepois),
      resolveEm: p.resolveEm || null,
    });
    gasto = gastoDepois;
  });

  const caixaPico = r2(gasto);
  const retornoSeBater = stake * oddTotal;
  const lucroSeTudoBater = possivel ? r2(retornoSeBater - caixaPico) : null;

  // O caminho ALL-GREEN é o único que a cobertura sequencial NÃO protege: cada cobertura
  // perdida é dinheiro gasto, e se a soma delas passar do retorno do bilhete o "risco
  // zero" vira prejuízo. Acontece de verdade — 4 pernas de 1,42 (total 4,07) cobertas a
  // 2,70 gastam R$ 318 para receber R$ 203. Isso PRECISA aparecer, não pode ficar só no
  // campo numérico.
  if (possivel && lucroSeTudoBater !== null && lucroSeTudoBater < 0) {
    avisos.push(
      `⚠️ ATENÇÃO: se TODAS as pernas baterem você PERDE R$ ${Math.abs(lucroSeTudoBater).toFixed(2)} ` +
        `(recebe R$ ${r2(retornoSeBater).toFixed(2)} do bilhete e gastou R$ ${caixaPico.toFixed(2)} com stake + coberturas). ` +
        'A cobertura sequencial protege TODO caminho de red, não o all-green — compare essa perda com o valor do bônus ' +
        'antes de executar, ou aceite uma perda parcial (perda_aceita > 0) para baratear as coberturas.'
    );
  } else if (possivel && lucroSeTudoBater !== null) {
    avisos.push(`Se todas as pernas baterem, o lucro é R$ ${lucroSeTudoBater.toFixed(2)} (retorno do bilhete − caixa de pico).`);
  }

  if (!possivel) {
    avisos.push(
      'Faltam odds de cobertura (oddCobertura) em pelo menos uma perna — a cadeia para na primeira perna sem odd, ' +
        'porque o aporte de cada passo depende do gasto acumulado do anterior. Consulte as odds do mercado oposto nas casas e recalcule.'
    );
  }
  const semHorario = pernas.filter((p) => !p.resolveEm).length;
  if (semHorario) {
    avisos.push(
      `${semHorario} perna(s) sem horário de RESOLUÇÃO. A cobertura sequencial só funciona se as pernas resolverem em momentos diferentes ` +
        '(dá para escalonar usando mercado de 1º tempo num jogo e de 2º tempo no outro).'
    );
  } else {
    const chaves = pernas.map((p) => (p.resolveEm || '').trim().toLowerCase());
    if (new Set(chaves).size < chaves.length) {
      avisos.push('Duas pernas resolvem no MESMO momento: a cobertura sequencial quebra aí — troque o mercado (1º/2º tempo) ou o jogo.');
    }
  }
  if (possivel) {
    avisos.push(`Caixa de pico R$ ${caixaPico.toFixed(2)} (stake + todas as coberturas do pior caminho) — confira se a banca aguenta antes de começar.`);
  }

  return {
    stake: r2(stake),
    oddTotal: Math.round(oddTotal * 1000) / 1000,
    qualifica: problemas.length === 0,
    problemas,
    oddPorPernaEquilibrada: tMin !== null && tMin > 1 ? Math.round(Math.pow(tMin, 1 / pernas.length) * 1000) / 1000 : null,
    retornoSeBater: r2(retornoSeBater),
    cobertura: { possivel, passos, caixaPico, lucroSeTudoBater, avisos },
  };
}
