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

export type TipoPromocao =
  | 'FREEBET_SNR'
  | 'FREEBET_SRR'
  | 'QUALIFICATIVA'
  | 'PROTECAO'
  | 'SUPERODD'
  | 'LUCRO_EXTRA';

export const TIPOS_PROMOCAO: TipoPromocao[] = [
  'FREEBET_SNR',
  'FREEBET_SRR',
  'QUALIFICATIVA',
  'PROTECAO',
  'SUPERODD',
  'LUCRO_EXTRA',
];

/**
 * A ficha da perna promocional é GRÁTIS (nenhum real sai do bolso).
 *
 * Existe separado de "qual é o retorno bruto" de propósito: juntar as duas perguntas numa
 * variável `ehFreebet` fazia a SRR herdar o retorno da SNR (S·(O−1) em vez de S·O), isto é
 * matemática de SNR sob o rótulo SRR — sub-hedge de metade do aporte em odd 2,00.
 */
export const ehFreebetSemCusto = (tipo: TipoPromocao): boolean =>
  tipo === 'FREEBET_SNR' || tipo === 'FREEBET_SRR';

/** O retorno da perna promocional é turbinado (odd acima do mercado ou lucro extra). */
export const ehTipoComBoost = (tipo: TipoPromocao): boolean =>
  tipo === 'SUPERODD' || tipo === 'LUCRO_EXTRA';

/** Quanto vale, na prática, R$ 1 de bônus/freebet (retenção típica de conversão). */
export const VALOR_BONUS_PADRAO_PCT = 70;

const r2 = (v: number): number => Math.round(v * 100) / 100;
/**
 * null/undefined/'' são AUSENTE; só número finito é valor.
 *
 * O teste `Number.isFinite(Number(v))` sozinho não serve: `Number(null)` é 0 e passa. Isso
 * fazia campo ausente enviado como `null` (o endpoint manda explicitamente) virar ZERO — e
 * zero tem significado nos campos novos: `valorFichaPct: null` virava "a ficha não vale
 * nada", ou seja SRR calculada como SNR (aporte pela metade em odd 2,00), e
 * `valorBonusPct: null` virava bônus valendo 0% em vez do default de 70%.
 */
const num = (v: any): number | null =>
  v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/**
 * Fração de valorização de um bônus. `null`/ausente cai no default; **0 é entrada válida**
 * (bônus que não dá para converter: validade curta, odd mínima alta). O teste `> 0` que
 * existia antes transformava "esse bônus não vale nada" em 70% em silêncio.
 */
const fatorDeBonus = (pct: number | null, ehBonus: boolean): number =>
  ehBonus ? clamp01((pct === null ? VALOR_BONUS_PADRAO_PCT : pct) / 100) : 1;

export interface EntradaPromocao {
  tipo: TipoPromocao;
  /** Valor da freebet (SNR/SRR) ou stake real (qualificativa/proteção/boost). */
  promoStake: number;
  /** Odd da perna promocional. */
  promoOdd: number;
  /** Odd do mercado OPOSTO na casa de cobertura. */
  coverOdd: number;
  /** Aporte da cobertura. Ausente/0 → calculado para EQUALIZAR os dois cenários. */
  coverStake?: number | null;
  /** Cashback/devolução em reais já garantido/prometido pela casa da promo. */
  cashback?: number | null;
  /** % da stake devolvida na PROTEÇÃO (ex.: 50 = "50% da aposta perdida de volta"). */
  cashbackPct?: number | null;
  /** Teto da devolução em reais ("50% até R$ 50"). Corta o valor calculado pelo %. */
  cashbackTeto?: number | null;
  /** true = a devolução cai como BÔNUS/freebet (não é dinheiro sacável). */
  cashbackEhBonus?: boolean;
  /** Quanto vale R$ 1 desse bônus, em % (default VALOR_BONUS_PADRAO_PCT). */
  valorBonusPct?: number | null;
  /** true (default) = cashback só entra se a perna promocional PERDER. */
  cashbackSoSePerder?: boolean;

  // ─── FREEBET_SRR ───
  /**
   * Quanto vale a ficha devolvida no green, em % (default 100 = dinheiro sacável;
   * 70 = a ficha volta como bônus). FONTE ÚNICA do `v` da fórmula R = S·(O−1+v):
   * SNR usa v=0, SRR usa este campo. 0 é válido (aí a SRR degenera em SNR).
   */
  valorFichaPct?: number | null;

  // ─── SUPERODD / LUCRO_EXTRA ───
  /** SUPERODD: odd NORMAL do mesmo mercado (sem o boost). Mede o excedente e a margem real. */
  oddPadrao?: number | null;
  /** Stake máxima elegível pela promoção ("super odd até R$ 30"). */
  tetoStake?: number | null;
  /** LUCRO_EXTRA: % de lucro extra (ex.: 30). */
  boostPct?: number | null;
  /** true = o regulamento aplica o % sobre o VALOR APOSTADO, não sobre o lucro. */
  boostSobreStake?: boolean;
  /** Teto do extra em reais ("+30% até R$ 50"). Corta a FACE, ANTES da valorização. */
  tetoExtra?: number | null;
  /** true = o excedente/extra é pago em BÔNUS/freebet, não em caixa. */
  extraEmBonus?: boolean;
  /** Quanto vale R$ 1 desse bônus, em % (default 70). 0 é válido: extra sem valor. */
  valorExtraPct?: number | null;

  // ─── regulamento (qualquer tipo) ───
  /** Teto de ganho/retorno do regulamento, em reais. */
  tetoGanho?: number | null;
  /** 'GANHO' (default) = teto sobre o lucro; 'RETORNO' = teto sobre o pagamento TOTAL. */
  tetoIncideSobre?: 'GANHO' | 'RETORNO';

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
  /** Dinheiro real que sai do bolso (freebet não conta a ficha). */
  investimentoReal: number;
  /** Caixa necessário na casa de cobertura. */
  caixaCobertura: number;
  /** Stake que a promoção realmente aceita: min(promoStake, tetoStake). */
  stakeElegivel: number;
  /** Retorno BRUTO da perna promocional quando ela bate (já com boost, tetos e bônus valorizado). */
  retornoBrutoPromo: number;
  /**
   * Odd que o retorno bruto implica (retornoBrutoPromo / stakeElegivel), já com boost e
   * tetos. É a FONTE ÚNICA para UI e skills: sem ela cada camada recalcula o boost do seu
   * jeito e o preview passa a divergir do que é gravado.
   */
  oddEfetivaPromo: number;
  /** Face do excedente/extra do boost (antes de valorizar bônus). */
  extraNominal: number;
  /**
   * Excedente/extra já valorizado. Entra no retorno bruto SÓ quando é pago separado da odd
   * (extra em bônus, ou lucro extra): na super odd paga em dinheiro a odd turbinada já
   * contém o excedente, e aí este número é medida do boost, não uma parcela a somar.
   */
  extraEfetivo: number;
  extraEmBonus: boolean;
  /** Bônus (valor efetivo) em cada cenário: é a parte do lucro que NÃO é caixa hoje. */
  bonusSePromoGanha: number;
  bonusSePromoPerde: number;
  /** Devolução prometida pela casa, de face (do % com teto aplicado, ou informada em reais). */
  cashbackNominal: number;
  /** Devolução já descontada a valorização do bônus — é ESTE valor que entra na conta. */
  cashbackEfetivo: number;
  cashbackEhBonus: boolean;
  lucroSePromoGanha: number;
  lucroSeCoberturaGanha: number;
  /**
   * Dinheiro REAL na mão em cada cenário, ANTES de converter bônus. Os dois campos vivem
   * em ramos OPOSTOS: na proteção o bônus cai quando a promo perde; na SRR com ficha em
   * bônus e no boost pago em bônus ele cai quando a promo GANHA.
   */
  lucroEmCaixaSePromoGanha: number;
  lucroEmCaixaSeCoberturaGanha: number;
  lucroGarantido: number;
  /** ROI sobre o dinheiro real investido (null quando não há dinheiro real). */
  roiPct: number | null;
  /** Só para freebet (SNR e SRR): lucro garantido / valor da ficha. Pode passar de 100% na SRR. */
  retencaoPct: number | null;
  /**
   * Extra EFETIVO (em reais) que zeraria a operação nos tipos com boost — abaixo dele o
   * boost não paga o par de odds. null nos outros tipos.
   */
  extraParaZerar: number | null;
  equalizado: boolean;
  avisos: string[];
}

/**
 * Cobertura de uma perna promocional. Todo tipo é uma definição diferente de RETORNO BRUTO
 * (R) e de CUSTO REAL; o resto da conta é comum:
 *
 *   FREEBET SNR   R = S·(O−1)            custo 0   (a ficha não volta)
 *   FREEBET SRR   R = S·(O−1+v)          custo 0   (v = valor da ficha devolvida; v=1 → S·O)
 *   QUALIFICATIVA R = S·O                custo S
 *   PROTEÇÃO      R = S·O                custo S   + devolução D se a promo PERDER
 *   SUPERODD      R = S·O_padrao + v·S·(O−O_padrao)   custo S   (v=1 se o boost é em caixa)
 *   LUCRO_EXTRA   R = S·O + v·min(b·S·(O−1), teto)    custo S
 *
 * Equalização (mesmo lucro nos dois cenários), com o cashback CONDICIONAL da proteção:
 *     coverStake = (R − cashbackDiferencial) / coverOdd
 *
 * O extra do boost NÃO entra como cashback: ele cai no cenário do GREEN e o cashback do
 * core cai no RED. Passar um pelo outro produz aporte errado com `equalizado: true` — o
 * pior tipo de bug aqui, porque tem cara de acerto.
 */
export function calcularPromocao(entrada: EntradaPromocao): ResultadoPromocao | null {
  // Whitelist explícita: coagir tipo desconhecido para FREEBET_SNR em silêncio (o que este
  // ponto fazia) devolvia matemática de SNR sob outro rótulo, sem erro e sem aviso.
  const tipoConhecido = TIPOS_PROMOCAO.includes(entrada.tipo);
  const tipo: TipoPromocao = tipoConhecido ? entrada.tipo : 'FREEBET_SNR';
  const promoStake = num(entrada.promoStake);
  const promoOdd = num(entrada.promoOdd);
  const coverOdd = num(entrada.coverOdd);
  if (promoStake === null || promoOdd === null || coverOdd === null) return null;
  if (promoStake <= 0 || promoOdd <= 1 || coverOdd <= 1) return null;

  const avisos: string[] = [];
  if (!tipoConhecido) {
    avisos.push(
      `Tipo de promoção desconhecido ("${entrada.tipo}") — a conta rodou como FREEBET_SNR. ` +
        `Tipos válidos: ${TIPOS_PROMOCAO.join(', ')}.`
    );
  }
  const promoOddEf = entrada.casaPromo ? oddEfetiva(entrada.casaPromo, promoOdd) : promoOdd;
  const coverOddEf = entrada.casaCobertura ? oddEfetiva(entrada.casaCobertura, coverOdd) : coverOdd;

  // Devolução de FACE: em reais quando informada, senão derivada do % da stake. O teto
  // corta os dois casos ("50% até R$ 50" com stake R$ 200 devolve R$ 50, não R$ 100).
  const cashbackPct = num(entrada.cashbackPct);
  const cashbackTeto = num(entrada.cashbackTeto);
  let cashbackNominal = Math.max(0, num(entrada.cashback) ?? 0);
  if (cashbackNominal === 0 && cashbackPct !== null && cashbackPct > 0) {
    cashbackNominal = promoStake * (cashbackPct / 100);
  }
  const bateuNoTeto = cashbackTeto !== null && cashbackTeto > 0 && cashbackNominal > cashbackTeto;
  if (bateuNoTeto) cashbackNominal = cashbackTeto!;

  // Bônus não é dinheiro: R$ 50 de freebet valem o que dá para extrair dela. A matemática
  // roda no valor EFETIVO — equalizar pela face inflaria o cenário de perda e o "lucro
  // garantido" só existiria depois de converter o bônus (que pode nem converter).
  const cashbackEhBonus = entrada.cashbackEhBonus === true;
  const fatorBonus = fatorDeBonus(num(entrada.valorBonusPct), cashbackEhBonus);
  const cashback = cashbackNominal * fatorBonus;

  const soSePerder = entrada.cashbackSoSePerder !== false;
  const cashbackSePromoGanha = soSePerder ? 0 : cashback;
  const cashbackSePromoPerde = cashback;

  // ── Stake elegível: a promoção só vale até o teto do regulamento. O excedente não é
  // promocional (entraria na odd normal), então a conta é feita na parte elegível e o
  // aviso manda apostar só ela — escrever as fórmulas em promoStake com teto no custo
  // inflava o aporte (~3,3× no caso "R$ 100 numa super odd de teto R$ 30") e virava
  // prejuízo travado nos DOIS cenários.
  const tetoStake = num(entrada.tetoStake);
  const stakeElegivel = tetoStake !== null && tetoStake > 0 ? Math.min(promoStake, tetoStake) : promoStake;
  const passouDoTetoStake = stakeElegivel < promoStake;

  const semCusto = ehFreebetSemCusto(tipo);
  const comBoost = ehTipoComBoost(tipo);
  const custoRealPromo = semCusto ? 0 : stakeElegivel;

  // ── Valor da ficha devolvida (só freebet). SNR: v=0. SRR: default 100% (dinheiro),
  // menos que isso = a ficha volta como bônus e vale o que dá para converter.
  const valorFichaPct = num(entrada.valorFichaPct);
  const vFicha = tipo === 'FREEBET_SRR' ? clamp01((valorFichaPct === null ? 100 : valorFichaPct) / 100) : 0;
  const fichaVoltaEmBonus = tipo === 'FREEBET_SRR' && vFicha > 0 && vFicha < 1;

  // ── Excedente/extra do boost. O teto corta a FACE; só depois vem a valorização do bônus
  // (invertendo a ordem, min(v·extra, teto) devolve mais que o correto sempre que o teto morde).
  const extraEmBonus = entrada.extraEmBonus === true;
  const fatorExtra = fatorDeBonus(num(entrada.valorExtraPct), extraEmBonus);
  const tetoExtra = num(entrada.tetoExtra);
  const oddPadrao = num(entrada.oddPadrao);
  const oddPadraoEf =
    oddPadrao !== null && oddPadrao > 1
      ? entrada.casaPromo
        ? oddEfetiva(entrada.casaPromo, oddPadrao)
        : oddPadrao
      : null;
  const boostPct = num(entrada.boostPct);
  const boostSobreStake = entrada.boostSobreStake === true;

  // `oddBaseEf` = a odd cujo retorno a casa paga em CAIXA independentemente do boost. É a
  // referência do piso (extraParaZerar) e da margem real do mercado de cobertura.
  let oddBaseEf = promoOddEf;
  let extraNominal = 0;
  // `extraForaDaOdd` = o extra é pago SEPARADO do retorno da odd base, então soma no R.
  // Na super odd paga em dinheiro ele NÃO soma: a odd turbinada já contém o excedente, e
  // somar de novo inflava o retorno (R$ 72 em vez de R$ 60 num caso de S=30 @2,00) e com
  // ele o aporte da cobertura — dupla contagem que aparece como "lucro" inexistente.
  let extraForaDaOdd = false;
  if (tipo === 'SUPERODD') {
    if (oddPadraoEf !== null && promoOddEf > oddPadraoEf) {
      extraNominal = stakeElegivel * (promoOddEf - oddPadraoEf);
      if (extraEmBonus) {
        oddBaseEf = oddPadraoEf; // a casa paga a odd padrão em caixa...
        extraForaDaOdd = true; // ...e credita o excedente como bônus
      }
    }
  } else if (tipo === 'LUCRO_EXTRA' && boostPct !== null && boostPct > 0) {
    extraForaDaOdd = true; // o extra vem por cima do retorno normal da odd
    // Base do % : o LUCRO (regra comum) ou o VALOR APOSTADO (regulamento alternativo).
    const baseDoBoost = boostSobreStake ? stakeElegivel : stakeElegivel * (promoOddEf - 1);
    extraNominal = baseDoBoost * (boostPct / 100);
  }
  if (tetoExtra !== null && tetoExtra > 0 && extraNominal > tetoExtra) extraNominal = tetoExtra;
  const tetoExtraMordeu = tetoExtra !== null && tetoExtra > 0 && extraNominal >= tetoExtra;
  let extraEfetivo = extraNominal * fatorExtra;

  // ── Retorno bruto por tipo.
  const retornoSemExtra = semCusto ? stakeElegivel * (promoOddEf - 1 + vFicha) : stakeElegivel * oddBaseEf;
  let retornoBrutoPromo = retornoSemExtra + (extraForaDaOdd ? extraEfetivo : 0);

  // ── Teto de ganho/retorno do regulamento. As duas leituras NÃO são a mesma fórmula:
  // "ganhe até R$ T" corta só o ganho; "retorno máximo R$ T" corta o pagamento inteiro
  // (nesse caso, ler errado manda aportar mais do que a casa paga e o green fecha negativo).
  const tetoGanho = num(entrada.tetoGanho);
  const tetoSobreRetorno = entrada.tetoIncideSobre === 'RETORNO';
  let tetoGanhoMordeu = false;
  if (tetoGanho !== null && tetoGanho > 0) {
    const parteQueNaoEhGanho = semCusto ? vFicha * stakeElegivel : stakeElegivel;
    const limite = tetoSobreRetorno ? tetoGanho : parteQueNaoEhGanho + tetoGanho;
    if (retornoBrutoPromo > limite) {
      retornoBrutoPromo = limite;
      tetoGanhoMordeu = true;
      // O teto corta primeiro a parte turbinada (a casa paga a base e limita o prêmio).
      extraEfetivo = Math.max(0, retornoBrutoPromo - retornoSemExtra);
    }
  }
  const oddEfetivaPromo = stakeElegivel > 0 ? retornoBrutoPromo / stakeElegivel : 0;

  // Bônus por cenário: é a fatia do "lucro" que ainda não é dinheiro na conta.
  const bonusSePromoGanha =
    (fichaVoltaEmBonus ? vFicha * stakeElegivel : 0) + (extraForaDaOdd && extraEmBonus ? extraEfetivo : 0);
  const bonusSePromoPerde = cashbackEhBonus ? cashbackSePromoPerde : 0;

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
  // Dinheiro na mão em cada cenário: bônus (ficha devolvida, extra do boost, cashback)
  // ainda NÃO é caixa. Os dois ramos são independentes de propósito.
  const lucroEmCaixaSePromoGanha = lucroSePromoGanha - bonusSePromoGanha;
  const lucroEmCaixaSeCoberturaGanha = lucroSeCoberturaGanha - bonusSePromoPerde;
  const investimentoReal = custoRealPromo + coverStake;
  const roiPct = investimentoReal > 0 ? (lucroGarantido / investimentoReal) * 100 : null;
  // Retenção é a métrica de TODA freebet (SNR e SRR). Na SRR passa de 100% e isso é
  // correto: a ficha volta, então o lucro pode superar o valor dela.
  const retencaoPct = semCusto ? (lucroGarantido / stakeElegivel) * 100 : null;
  // Piso do boost: quanto de extra EFETIVO faria o green empatar com a cobertura. Vem da
  // fronteira O_ef ≥ H/(H−1), que não depende de estimar margem nenhuma.
  const extraParaZerar = comBoost
    ? Math.max(0, stakeElegivel * (coverOddEf / (coverOddEf - 1) - oddBaseEf))
    : null;

  if (tipo === 'FREEBET_SNR' && coverOdd < 1.1 && promoOdd >= 6) {
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
  // A SRR tem o ótimo INVERTIDO em relação à SNR: como a ficha volta, o único vazamento é
  // a margem paga no lay, e ela cresce com a odd — retenção ≈ 1 − m·(O−1). Sem este aviso
  // o usuário aplica a doutrina da SNR ("estique a odd") e perde retenção de propósito.
  if (tipo === 'FREEBET_SRR') {
    const m = margemImplicita(promoOdd, coverOdd);
    if (m > 0 && promoOdd >= 2) {
      avisos.push(
        `Na freebet SRR (a ficha volta) o ótimo é a MENOR odd elegível, não a mais alta: a retenção é ` +
          `~1 − m·(odd−1), aqui ${(retencaoPct ?? 0).toFixed(0)}% com margem medida de ${(m * 100).toFixed(1)}%. ` +
          `Descer para odd 1,50 renderia ~${((1 - m * 0.5) * 100).toFixed(0)}% e ainda imobilizaria menos caixa na cobertura ` +
          `(o aporte é proporcional a odd−1). Cuidado para não confundir com a SNR, cujo ótimo é odd alta.`
      );
    }
  }
  if (passouDoTetoStake) {
    avisos.push(
      `A promoção só aceita R$ ${r2(stakeElegivel).toFixed(2)} (teto de stake) — a conta é essa, não a de ` +
        `R$ ${r2(promoStake).toFixed(2)}. Aposte só o valor elegível nessa perna: o excedente entraria na odd NORMAL ` +
        'da casa, virando uma qualificativa com prejuízo colada na operação (e o aporte da cobertura mudaria).'
    );
  }
  if (tetoGanhoMordeu) {
    avisos.push(
      `Teto de ${tetoSobreRetorno ? 'RETORNO' : 'GANHO'} de R$ ${tetoGanho!.toFixed(2)} cortou o retorno bruto para ` +
        `R$ ${r2(retornoBrutoPromo).toFixed(2)} (odd efetiva ${oddEfetivaPromo.toFixed(3)}). Confira NO REGULAMENTO qual das duas ` +
        'cláusulas é a sua: "ganhe até R$ X" limita o lucro, "retorno máximo R$ X" limita o pagamento inteiro — ' +
        'ler errado faz o app mandar aportar mais do que a casa paga, e aí o green fecha negativo.'
    );
  }
  if (extraForaDaOdd && tetoExtraMordeu) {
    avisos.push(
      `Extra limitado ao teto de R$ ${r2(extraNominal).toFixed(2)}: a partir daí aumentar a stake não aumenta o prêmio, ` +
        'só o pedágio da cobertura — o ROI cai com stake maior.'
    );
  }
  if (comBoost && extraEmBonus && extraNominal > 0) {
    avisos.push(
      `Extra pago em BÔNUS: R$ ${r2(extraNominal).toFixed(2)} de face valendo R$ ${r2(extraEfetivo).toFixed(2)} ` +
        `(${r2(fatorExtra * 100).toFixed(0)}%). Ele cai no cenário em que a promo GANHA, então nesse ramo o caixa do dia é ` +
        `R$ ${r2(lucroEmCaixaSePromoGanha).toFixed(2)} — o resto só vira dinheiro depois de converter o bônus.`
    );
  }
  if (comBoost && extraEmBonus && fatorExtra === 0 && extraNominal > 0) {
    avisos.push(
      'Extra declarado SEM VALOR (0%): a conta virou uma qualificativa crua, que dá prejuízo garantido. ' +
        'Se o bônus vale algo, informe quanto; se não vale nada, essa promoção não paga a operação.'
    );
  }
  if (fichaVoltaEmBonus) {
    avisos.push(
      `A ficha da SRR volta como BÔNUS valendo ${r2(vFicha * 100).toFixed(0)}%: no green o caixa do dia é ` +
        `R$ ${r2(lucroEmCaixaSePromoGanha).toFixed(2)} e o resto depende de converter esse bônus. ` +
        'Se a ficha volta em DINHEIRO, deixe valorFichaPct em 100.'
    );
  }
  if (tipo === 'SUPERODD' && oddPadraoEf === null) {
    avisos.push(
      'Super odd sem a odd PADRÃO do mercado: sem ela não dá para medir o boost real nem a margem do mercado de ' +
        'cobertura (medir a margem com a odd turbinada dá negativo, clampa em zero e esconde o pedágio). ' +
        'Se o boost é pago em BÔNUS, a odd padrão é obrigatória — sem ela a conta trata tudo como caixa.'
    );
  }
  if (tipo === 'SUPERODD' && oddPadraoEf !== null && promoOddEf <= oddPadraoEf) {
    avisos.push(
      `A odd "turbinada" (${promoOdd.toFixed(2)}) não é melhor que a odd padrão informada (${oddPadrao!.toFixed(2)}): ` +
        'não há boost nenhum a extrair — confira se a promoção está ativa e se o opt-in foi feito ANTES da aposta.'
    );
  }
  if (tipo === 'LUCRO_EXTRA' && !(boostPct !== null && boostPct > 0)) {
    avisos.push(
      'LUCRO_EXTRA sem o percentual do boost: a conta caiu para uma qualificativa comum (prejuízo garantido). ' +
        'É o extra que paga a operação nesse tipo.'
    );
  }
  if (tipo === 'LUCRO_EXTRA' && boostSobreStake && boostPct !== null && boostPct > 0) {
    avisos.push(
      `Boost aplicado sobre o VALOR APOSTADO (não sobre o lucro), como você marcou: extra de ` +
        `R$ ${r2(extraNominal).toFixed(2)}. Confirme no regulamento — a leitura padrão é "+${boostPct.toFixed(0)}% de LUCRO extra", ` +
        'que em odd 2,00 vale metade disso.'
    );
  }
  const ehProtecao = tipo === 'PROTECAO';
  if (ehProtecao && cashbackNominal <= 0) {
    avisos.push(
      'PROTEÇÃO sem devolução informada (cashbackPct ou cashback em reais): a conta caiu para uma qualificativa ' +
        'comum, que dá prejuízo garantido. É o cashback que paga o lucro nesse tipo — confira o regulamento.'
    );
  }
  if (ehProtecao && !soSePerder && cashbackNominal > 0) {
    avisos.push(
      'Devolução marcada como incondicional (cai mesmo se a promo ganhar): isso não é proteção de aposta perdida. ' +
        'Ela não muda o aporte da cobertura, só soma no lucro dos dois cenários — confirme o regulamento.'
    );
  }
  if (bateuNoTeto) {
    const stakeQueUsaOTeto = cashbackPct !== null && cashbackPct > 0 ? (cashbackTeto! * 100) / cashbackPct : null;
    avisos.push(
      `Devolução limitada ao teto de R$ ${cashbackTeto!.toFixed(2)}` +
        (stakeQueUsaOTeto
          ? ` — a stake que aproveita ${cashbackPct!.toFixed(0)}% cheios é R$ ${r2(stakeQueUsaOTeto).toFixed(2)}; ` +
            'cada real acima disso entra na mesa SEM proteção e só afina o ROI.'
          : ' (o valor informado foi cortado).')
    );
  }
  if (cashbackEhBonus && cashbackNominal > 0) {
    avisos.push(
      `Devolução em BÔNUS: R$ ${r2(cashbackNominal).toFixed(2)} de face valendo R$ ${r2(cashback).toFixed(2)} ` +
        `(${r2(fatorBonus * 100).toFixed(0)}% — retenção estimada da conversão). Se a promo perder, o caixa real do dia é ` +
        `R$ ${r2(lucroEmCaixaSeCoberturaGanha).toFixed(2)}; o resto só vira dinheiro depois de extrair o bônus (cobrindo a freebet).`
    );
  }
  if (!semCusto && lucroGarantido < 0) {
    const perda = Math.abs(lucroGarantido).toFixed(2);
    if (comBoost) {
      // Aqui o alvo é o EXTRA, não a devolução: chamar cashbackParaZerar (piso do modelo de
      // devolução no red) imprimiria um número sem significado para este tipo.
      const falta = (extraParaZerar ?? 0) - extraEfetivo;
      const bMin =
        stakeElegivel > 0 && promoOddEf > 1 && fatorExtra > 0
          ? ((extraParaZerar ?? 0) / (fatorExtra * stakeElegivel * (boostSobreStake ? 1 : promoOddEf - 1))) * 100
          : null;
      avisos.push(
        `Boost insuficiente: custo garantido de R$ ${perda}. Com essas odds o extra efetivo precisaria ser ` +
          `R$ ${r2(extraParaZerar ?? 0).toFixed(2)}` +
          (bMin !== null && Number.isFinite(bMin) ? ` (boost de ~${r2(bMin).toFixed(1)}%)` : '') +
          `; o atual é R$ ${r2(extraEfetivo).toFixed(2)} (faltam R$ ${r2(Math.max(0, falta)).toFixed(2)}).` +
          (tetoExtraMordeu
            ? ' O teto do extra está mordendo, então aumentar a stake PIORA: reduza a stake até o extra voltar a ser proporcional.'
            : ' Busque cobertura com odd maior ou uma odd promocional mais curta.')
      );
    } else {
      const c0 = cashbackParaZerar(stakeElegivel, promoOddEf, coverOddEf);
      const alvo =
        c0 > 0
          ? ` Para zerar com esse par de odds a devolução efetiva precisaria ser R$ ${r2(c0).toFixed(2)} ` +
            `(${r2((c0 / stakeElegivel) * 100).toFixed(1)}% da stake); a atual é R$ ${r2(cashback).toFixed(2)}.`
          : '';
      avisos.push(
        ehProtecao
          ? `Proteção insuficiente: custo garantido de R$ ${perda}.${alvo} ` +
            'Busque cobertura com odd maior (soma 1/promo + 1/cobertura menor) antes de executar.'
          : `Qualificador com custo de R$ ${perda} — compare com o valor extraível do bônus ` +
            'antes de executar (doutrina: perda acima de ~35% do bônus pede outro par de casas).' + alvo
      );
    }
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
    stakeElegivel: r2(stakeElegivel),
    retornoBrutoPromo: r2(retornoBrutoPromo),
    oddEfetivaPromo: Math.round(oddEfetivaPromo * 1000) / 1000,
    extraNominal: r2(extraNominal),
    extraEfetivo: r2(extraEfetivo),
    extraEmBonus,
    bonusSePromoGanha: r2(bonusSePromoGanha),
    bonusSePromoPerde: r2(bonusSePromoPerde),
    cashbackNominal: r2(cashbackNominal),
    cashbackEfetivo: r2(cashback),
    cashbackEhBonus,
    lucroSePromoGanha: r2(lucroSePromoGanha),
    lucroSeCoberturaGanha: r2(lucroSeCoberturaGanha),
    lucroEmCaixaSePromoGanha: r2(lucroEmCaixaSePromoGanha),
    lucroEmCaixaSeCoberturaGanha: r2(lucroEmCaixaSeCoberturaGanha),
    lucroGarantido: r2(lucroGarantido),
    roiPct: roiPct === null ? null : r2(roiPct),
    retencaoPct: retencaoPct === null ? null : r2(retencaoPct),
    extraParaZerar: extraParaZerar === null ? null : r2(extraParaZerar),
    equalizado,
    avisos,
  };
}

/**
 * Vocabulário do BANCO (coluna promo_surebets.promo_type). Divergiu do core só por herança:
 * a qualificativa foi gravada como QUALIFYING antes de o core existir. Tipo novo usa o MESMO
 * nome nas duas pontas — a divergência já produziu filtro devolvendo zero em silêncio.
 */
export const PROMO_TYPES_BANCO = [
  'FREEBET_SNR',
  'FREEBET_SRR',
  'QUALIFYING',
  'PROTECAO',
  'SUPERODD',
  'LUCRO_EXTRA',
] as const;

/** promo_type do banco → tipo do core. Único tradutor nessa direção. */
export function tipoDoPromoType(promoType: any): TipoPromocao {
  const t = `${promoType ?? ''}`.toUpperCase();
  if (t === 'QUALIFYING' || t === 'QUALIFICATIVA') return 'QUALIFICATIVA';
  return TIPOS_PROMOCAO.includes(t as TipoPromocao) ? (t as TipoPromocao) : 'FREEBET_SNR';
}

/** tipo do core → promo_type do banco. Único tradutor nessa direção. */
export function promoTypeDoTipo(tipo: TipoPromocao): string {
  return tipo === 'QUALIFICATIVA' ? 'QUALIFYING' : tipo;
}

/**
 * Tipo a partir de texto livre — o Agente recebe "cashback", "super odd", "turbinada",
 * "aposta grátis que devolve a ficha" e escreve o tipo do seu jeito.
 *
 * A ordem dos testes importa: "freebet com lucro extra" tem de cair em LUCRO_EXTRA só se o
 * assunto for o boost, e SRR precisa ser testada antes de FREEBET genérico (senão toda SRR
 * vira SNR e a cobertura sai pela metade).
 */
export function tipoPromocaoDeTexto(bruto: any): TipoPromocao {
  const t = `${bruto ?? ''}`;
  if (/SUPER.?ODD|TURBIN|ODD.?AUMENT|ENHANCED|BOOST.?ODD/i.test(t)) return 'SUPERODD';
  if (/LUCRO.?EXTRA|PROFIT.?BOOST|GANHO.?EXTRA|LUCRO.?TURBIN|\+\s*\d+\s*%.*LUCRO/i.test(t)) return 'LUCRO_EXTRA';
  if (/SRR|STAKE.?RETURN|FICHA.?VOLTA|DEVOLVE.?A.?FICHA|COM.?RETORNO.?DA.?STAKE/i.test(t)) return 'FREEBET_SRR';
  if (/PROTE|CASHBACK|SEGURO|DEVOLU/i.test(t)) return 'PROTECAO';
  if (/QUALIF/i.test(t)) return 'QUALIFICATIVA';
  return 'FREEBET_SNR';
}

/**
 * Devolução (em reais, valor EFETIVO) que zera a operação de PROTEÇÃO com cobertura
 * equalizada. Sai de resolver S·(O−1) − (S·O − C)/H = 0:
 *
 *     C₀ = S·(O − H·(O − 1))
 *
 * Interpretação: C₀/S é a fatia da stake que a casa precisa devolver. Ela cai quando a
 * odd de cobertura sobe — em mercado apertado bastam poucos por cento, e um cashback de
 * 50% deixa MUITA folga. Se der ≤ 0, o par de odds já é surebet sem promoção nenhuma.
 */
export function cashbackParaZerar(promoStake: number, promoOdd: number, coverOdd: number): number {
  if (!(promoStake > 0) || !(promoOdd > 1) || !(coverOdd > 1)) return 0;
  return promoStake * (promoOdd - coverOdd * (promoOdd - 1));
}

/**
 * Margem implícita do mercado de cobertura, dado o par (odd da promo, odd oposta real).
 * A odd justa oposta de O é O/(O−1); se a casa oferece C, a margem é justa/C − 1.
 */
export function margemImplicita(promoOdd: number, coverOdd: number): number {
  return Math.max(0, margemImplicitaCrua(promoOdd, coverOdd));
}

/**
 * Mesma medida SEM o clamp em zero — margem negativa significa "a cobertura paga MELHOR que
 * o preço justo", ou seja o par já é surebet. Use esta versão em identidade algébrica: com o
 * clamp, a forma decomposta do lucro erra justamente nos pares bons (mede 3,60 onde o lucro
 * real é 9,60). O clamp fica só para texto de aviso ("margem de X%").
 */
export function margemImplicitaCrua(promoOdd: number, coverOdd: number): number {
  if (!(promoOdd > 1) || !(coverOdd > 1)) return 0;
  const justaOposta = promoOdd / (promoOdd - 1);
  return justaOposta / coverOdd - 1;
}

/**
 * Odd de freebet que MAXIMIZA a retenção, dada a margem m do mercado oposto e o valor `v` da
 * ficha devolvida (v=0 → SNR, v=1 → SRR):
 *
 *     O* = √(1 + (1 − v·(1+m))/m)      →  v=0 recai em √(1 + 1/m)
 *
 * Devolve **NaN quando não existe pico interior** (v ≥ 1/(1+m), o caso da SRR): aí a retenção
 * é monótona decrescente e o ótimo é a MENOR odd elegível pelo regulamento. Nunca passe o
 * radicando negativo para Math.sqrt — em float64 a SRR pura dá −8,9e−16 e imprimiria "NaN"
 * como se fosse uma odd.
 */
export function oddIdealFreebet(margem: number, vFicha = 0): number {
  if (!(margem > 0)) return Infinity;
  const radicando = 1 + (1 - vFicha * (1 + margem)) / margem;
  if (!(radicando > 1)) return NaN; // sem pico interior → desça para a odd mínima
  return Math.sqrt(radicando);
}

/**
 * Retenção teórica da freebet: R(O) = (O−1+v)·(1 − m·(O−1))/O (fração; pode passar de 1 na
 * SRR e ficar negativa em odd absurda). Com v=0 é a SNR: (O−1)(1−m(O−1))/O.
 */
export function retencaoTeorica(promoOdd: number, margem: number, vFicha = 0): number {
  if (!(promoOdd > 1)) return 0;
  const u = promoOdd - 1;
  return ((u + vFicha) * (1 - margem * u)) / promoOdd;
}

export interface CurvaRetencao {
  margemPct: number;
  /** null quando não há pico interior (SRR): o ótimo é a MENOR odd elegível. */
  oddIdeal: number | null;
  retencaoIdealPct: number;
  coverOddNoIdeal: number | null;
  /** Valor da ficha devolvida usado na curva (0 = SNR, 1 = SRR). */
  valorFicha: number;
  /** Direção do ótimo: 'pico' (SNR) ou 'menor-odd' (SRR). */
  direcaoDoOtimo: 'pico' | 'menor-odd';
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
export function curvaRetencaoFreebet(
  freebetStake: number,
  margem = 0.06,
  odds?: number[],
  vFicha = 0
): CurvaRetencao {
  const m = margem > 0 ? margem : 0.06;
  const v = clamp01(vFicha);
  const grade = odds && odds.length ? odds : [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7.75, 10];
  const oddIdealBruta = oddIdealFreebet(m, v);
  const temPico = Number.isFinite(oddIdealBruta);
  const coverOddDe = (O: number) => O / ((O - 1) * (1 + m));
  // Domínio: acima de 1 + 1/m a "cobertura estimada" cai para ≤ 1,00 — não existe casa
  // pagando isso, e a retenção calculada fica negativa. Marcar é melhor que devolver
  // número sem sentido quando o usuário pede uma odd absurda (ex.: 30.00).
  const oddMaximaDoModelo = 1 + 1 / m;
  const menorOddDaGrade = Math.min(...grade.filter((o) => o > 1));
  const oddDeReferencia = temPico ? oddIdealBruta : menorOddDaGrade;
  return {
    margemPct: r2(m * 100),
    valorFicha: v,
    direcaoDoOtimo: temPico ? 'pico' : 'menor-odd',
    oddIdeal: temPico ? Math.round(oddIdealBruta * 100) / 100 : null,
    retencaoIdealPct: r2(retencaoTeorica(oddDeReferencia, m, v) * 100),
    coverOddNoIdeal: temPico ? Math.round(coverOddDe(oddIdealBruta) * 1000) / 1000 : null,
    oddMaximaDoModelo: Math.round(oddMaximaDoModelo * 100) / 100,
    curva: grade
      .filter((o) => o > 1)
      .map((o) => {
        const ret = retencaoTeorica(o, m, v);
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
