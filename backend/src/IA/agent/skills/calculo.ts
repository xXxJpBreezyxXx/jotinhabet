/**
 * SKILLS DE CÁLCULO — surebet, cobertura de promoção nos 6 tipos do core (freebet SNR/SRR,
 * qualificativa, proteção, super odd, lucro extra), otimização da odd de freebet e múltipla
 * qualificadora com cobertura sequencial.
 *
 * Por que ferramenta e não "o modelo calcula": LLM erra aritmética de centavo e o
 * usuário digita o aporte na casa. Aqui a matemática é a MESMA de core/calculator.ts e
 * core/promocoes.ts (testada em vitest) — o modelo só interpreta o resultado.
 */

import { ContextoSkills, Skill } from '../tipos';
import { calcularArbitragem } from '../../../core/calculator';
import {
  calcularPromocao,
  calcularMultiplaQualificadora,
  cashbackParaZerar,
  curvaRetencaoFreebet,
  ehFreebetSemCusto,
  ehTipoComBoost,
  margemImplicita,
  oddIdealFreebet,
  ResultadoPromocao,
  TipoPromocao,
  tipoPromocaoDeTexto,
  TIPOS_PROMOCAO,
  VALOR_BONUS_PADRAO_PCT,
} from '../../../core/promocoes';
import { bancaParaAlertas } from '../../../core/bancaAtiva';
import { canonizarCasa } from '../../../signals/casasAliases';
import { acharCasa, catalogoCasas, CasaCatalogada } from '../catalogoCasas';
import { compararOfertas, FonteOdds } from '../comparadorOdds';
import { agruparPorJogo, JogoAgrupado, lerSituacao, normalizarEsporte } from '../varredura';
import { ScrapedOdd } from '../../../scraping/scraper_base';
import { comLimite } from '../../../utils/concorrencia';
import { normalizarMercado } from '../../../arbitrage/markets';
import { parseKickoff } from '../../../arbitrage/matcher';

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * null/''/NaN → undefined, para percentual OPCIONAL que segue para o core.
 *
 * Provedores de function calling mandam `null` em parâmetro opcional, e o núcleo lê
 * Number(null) como 0 — que é *entrada válida* em valorBonusPct ("esse bônus não vale
 * nada"). Sem esta limpeza, um null vira 0 e a devolução em bônus é contada como zero em
 * silêncio, quando o certo é cair no default de 70%.
 */
const pctOpcional = (v: any): number | undefined =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);

export const skillCalcularSurebet: Skill = {
  nome: 'calcular_surebet',
  resumo:
    'Distribui o stake entre duas pernas: aporte de cada lado, investimento, lucro e ROI garantido (já com comissão de exchange).',
  grupo: 'calculo',
  descricao:
    'Distribui o stake entre duas pernas: dado odd1/odd2 (e opcionalmente as casas e o investimento total), ' +
    'devolve aporte de cada lado, investimento, lucro e ROI no pior caso, já descontando comissão de exchange. ' +
    'Use sempre que o usuário pedir "quanto aposto em cada", inclusive para conferir um alerta.',
  parametros: {
    type: 'object',
    properties: {
      odd1: { type: 'number' },
      odd2: { type: 'number' },
      casa1: { type: 'string' },
      casa2: { type: 'string' },
      investimento_total: { type: 'number', description: 'Vazio = banca ativa do painel.' },
      arredondar_para: { type: 'number', description: 'default 0.01' },
    },
    required: ['odd1', 'odd2'],
    additionalProperties: false,
  },
  async executar(args: any) {
    const odd1 = Number(args?.odd1);
    const odd2 = Number(args?.odd2);
    if (!(odd1 > 1) || !(odd2 > 1)) return { erro: 'odd1 e odd2 devem ser > 1' };

    let total = Number(args?.investimento_total);
    let fonteBanca = 'informado pelo usuário';
    if (!Number.isFinite(total) || total <= 0) {
      try {
        total = await bancaParaAlertas();
        fonteBanca = 'banca ativa do painel';
      } catch {
        total = 1000;
        fonteBanca = 'default R$ 1.000 (banca indisponível)';
      }
    }
    const passo = Number(args?.arredondar_para) > 0 ? Number(args.arredondar_para) : 0.01;
    // calcularArbitragem trabalha com banca por casa + maxStakePct; para "investir o
    // total" basta dar a banca cheia dos dois lados com maxStakePct=1 e deixar a
    // proporção das odds decidir. Depois normalizamos para o total pedido.
    const bruto = calcularArbitragem({
      banca1: total,
      banca2: total,
      maxStakePct: 1,
      odd1,
      odd2,
      roundStep1: passo,
      roundStep2: passo,
      casa1: args?.casa1 ? canonizarCasa(args.casa1) : undefined,
      casa2: args?.casa2 ? canonizarCasa(args.casa2) : undefined,
    });
    if (!bruto) return { erro: 'entrada inválida para o cálculo (odds/banca)' };

    // Reescala para o investimento total pedido (o cálculo acima maximiza usando a banca).
    const fator = bruto.investimentoTotal > 0 ? total / bruto.investimentoTotal : 1;
    const escalado = calcularArbitragem({
      banca1: total * fator,
      banca2: total * fator,
      maxStakePct: 1,
      odd1,
      odd2,
      roundStep1: passo,
      roundStep2: passo,
      casa1: args?.casa1 ? canonizarCasa(args.casa1) : undefined,
      casa2: args?.casa2 ? canonizarCasa(args.casa2) : undefined,
    });
    const res = escalado || bruto;

    return {
      eh_surebet: res.isArbitrage,
      odd_minima_exigida_no_lado_2: res.oddMinimaExigida,
      margem_teorica_pct: res.margemTeoricaPct,
      investimento_total: res.investimentoTotal,
      base_do_investimento: fonteBanca,
      perna_1: { casa: args?.casa1 ? canonizarCasa(args.casa1) : null, odd: odd1, aporte: res.stake1, retorno: res.retornoCasa1, lucro: res.lucroCasa1 },
      perna_2: { casa: args?.casa2 ? canonizarCasa(args.casa2) : null, odd: odd2, aporte: res.stake2, retorno: res.retornoCasa2, lucro: res.lucroCasa2 },
      lucro_garantido: res.piorLucro,
      roi_garantido_pct: res.piorRoiPct,
      nota: res.isArbitrage
        ? 'Aposte primeiro a perna mais volátil e confira a odd na tela antes de confirmar a segunda.'
        : 'NÃO fecha arbitragem com essas odds (1/odd1 + 1/odd2 ≥ 1).',
    };
  },
};

/**
 * Instrução OPERACIONAL por tipo — o que o usuário faz na casa, na ordem.
 *
 * Era uma escada com `else`, e o `else` entregava o texto da QUALIFICATIVA para todo tipo
 * que não fosse SNR ou proteção: quem pedia super odd recebia "aposte e cubra" sem o
 * opt-in (sem ele a casa paga a odd normal e a conta inteira muda) e quem pedia SRR
 * recebia a doutrina errada de odd. O switch é exaustivo de propósito — tipo novo no core
 * quebra o TYPECHECK aqui em vez de se disfarçar de qualificativa na tela.
 */
function comoExecutarPromocao(tipo: TipoPromocao, res: ResultadoPromocao): string {
  // Sempre a stake ELEGÍVEL, nunca a digitada: com teto de stake ("super odd até R$ 30")
  // mandar apostar o valor cheio joga o excedente na odd normal da casa e desequaliza tudo.
  const promo = `R$ ${res.stakeElegivel.toFixed(2)} @${res.promoOdd}`;
  const cobrir = `cubra com R$ ${res.coverStake.toFixed(2)} @${res.coverOdd} no mercado oposto, em OUTRA casa`;
  const fecho = `Confirme as odds na tela antes de digitar os aportes; nos dois cenários o resultado é ~R$ ${res.lucroGarantido.toFixed(2)}.`;
  switch (tipo) {
    case 'FREEBET_SNR':
      return `Aposte a freebet de ${promo} (a ficha NÃO volta no green) e ${cobrir}. ${fecho}`;
    case 'FREEBET_SRR':
      return (
        `Aposte a freebet de ${promo} e ${cobrir} — o aporte é MAIOR que na SNR porque a ficha volta no green. ` +
        `Se ainda pode escolher o jogo, desça para a MENOR odd que o regulamento aceita: na SRR a retenção cai com a odd. ${fecho}`
      );
    case 'QUALIFICATIVA':
      return `Aposte ${promo} (qualificadora, dinheiro real do bolso) e ${cobrir}. ${fecho}`;
    case 'PROTECAO':
      return (
        `Ative a promoção ANTES de apostar. Aposte ${promo} na casa da proteção e ${cobrir}. ` +
        `Se a promo perder você recebe R$ ${res.cashbackNominal.toFixed(2)} de devolução` +
        `${res.cashbackEhBonus ? ' EM BÔNUS (ainda precisa converter)' : ''}. ${fecho}`
      );
    case 'SUPERODD':
      return (
        `Faça o OPT-IN da super odd ANTES da aposta (sem ele a casa paga a odd normal) e aposte ${promo}. Depois ${cobrir}` +
        `${
          res.extraEmBonus
            ? `. O excedente de R$ ${res.extraNominal.toFixed(2)} cai em BÔNUS, então no green o caixa do dia é R$ ${res.lucroEmCaixaSePromoGanha.toFixed(2)}`
            : ''
        }. ${fecho}`
      );
    case 'LUCRO_EXTRA':
      return (
        `Ative o lucro extra ANTES da aposta e aposte ${promo} (extra de R$ ${res.extraNominal.toFixed(2)} de face` +
        `${res.extraEmBonus ? `, valendo R$ ${res.extraEfetivo.toFixed(2)} em bônus` : ', em caixa'}). Depois ${cobrir}. ${fecho}`
      );
  }
  const naoPrevisto: never = tipo;
  return `Tipo de promoção sem instrução própria (${String(naoPrevisto)}) — leia o regulamento antes de executar.`;
}

export const skillCalcularPromocao: Skill = {
  nome: 'calcular_cobertura_promocao',
  resumo:
    'Cobertura de promoção nos 6 tipos (freebet SNR/SRR, qualificativa, proteção, super odd, lucro extra): aporte, lucro dos 2 cenários, garantido, ROI, retenção e piso do boost.',
  grupo: 'calculo',
  descricao:
    'Calcula a cobertura de uma aposta de PROMOÇÃO em qualquer um dos 6 tipos: freebet SNR (a ficha não volta), ' +
    'freebet SRR (a ficha volta no green), qualificativa (dinheiro real), PROTEÇÃO (a casa devolve X% se a aposta ' +
    'perder), SUPER ODD (odd turbinada acima do mercado) e LUCRO EXTRA (+X% de lucro por cima). Devolve o aporte ' +
    'exato da cobertura, o lucro nos dois cenários, o lucro garantido, ROI, a RETENÇÃO da freebet, a odd efetiva da ' +
    'perna promocional e o extra mínimo que faz o boost pagar a operação. Use sempre que o usuário falar de freebet, ' +
    'aposta extra, bônus, aposta qualificadora, "aposta perdida de volta"/cashback/seguro, odd turbinada/aumentada, ' +
    'lucro extra ou "quanto cubro".',
  parametros: {
    type: 'object',
    properties: {
      // enum em vez de lista em prosa: a lista dos 6 tipos passa de 70 caracteres e chegaria
      // TRUNCADA ao modelo (o último tipo simplesmente desapareceria do schema), além de
      // custar mais tokens. O enum ainda RESTRINGE a saída do provedor ao vocabulário do core.
      tipo: { type: 'string', enum: [...TIPOS_PROMOCAO] },
      valor_promocao: { type: 'number', description: 'Valor da freebet ou stake real.' },
      odd_promocao: { type: 'number' },
      odd_cobertura: { type: 'number', description: 'Do mercado OPOSTO.' },
      aporte_cobertura: { type: 'number', description: 'Vazio = o que EQUALIZA.' },
      cashback: { type: 'number', description: 'Devolução em reais.' },
      cashback_pct: { type: 'number', description: '% da stake, se perder (ex.: 50).' },
      cashback_teto: { type: 'number', description: 'Teto da devolução, em reais.' },
      // Um flag só para "o benefício vem em BÔNUS": é o MESMO fato do regulamento na
      // devolução e no extra do boost. valor_bonus_pct, valor_extra_pct, teto_extra,
      // teto_ganho, boost_sobre_stake e valor_ficha_pct existem no core mas ficam FORA do
      // schema: os defaults cobrem o caso normal e cada param pesa em TODA rodada (cota da Groq).
      cashback_eh_bonus: { type: 'boolean', description: `true = devolução/extra em bônus (~${VALOR_BONUS_PADRAO_PCT}%).` },
      cashback_so_se_perder: { type: 'boolean', description: 'true (default) = só se a promo perder.' },
      odd_padrao: { type: 'number', description: 'SUPERODD: a odd NORMAL, sem o boost.' },
      boost_pct: { type: 'number', description: 'LUCRO_EXTRA: % de lucro extra (ex.: 30).' },
      teto_stake: { type: 'number', description: 'Stake máxima que a promoção aceita.' },
      casa_promocao: { type: 'string' },
      casa_cobertura: { type: 'string' },
    },
    required: ['valor_promocao', 'odd_promocao', 'odd_cobertura'],
    additionalProperties: false,
  },
  async executar(args: any) {
    const tipo = tipoPromocaoDeTexto(args?.tipo);
    const comBoost = ehTipoComBoost(tipo);
    const ehFreebet = ehFreebetSemCusto(tipo);
    const emBonus = args?.cashback_eh_bonus === true;
    const res = calcularPromocao({
      tipo,
      promoStake: Number(args?.valor_promocao),
      promoOdd: Number(args?.odd_promocao),
      coverOdd: Number(args?.odd_cobertura),
      coverStake: args?.aporte_cobertura,
      cashback: args?.cashback,
      cashbackPct: args?.cashback_pct,
      cashbackTeto: args?.cashback_teto,
      cashbackEhBonus: emBonus,
      valorBonusPct: pctOpcional(args?.valor_bonus_pct),
      cashbackSoSePerder: args?.cashback_so_se_perder,
      oddPadrao: args?.odd_padrao,
      tetoStake: args?.teto_stake,
      boostPct: args?.boost_pct,
      // Fora dos tipos com boost o campo não significa nada: marcar extraEmBonus numa
      // proteção sujaria a resposta com um "extra em bônus" que não existe na operação.
      extraEmBonus: comBoost && emBonus,
      casaPromo: args?.casa_promocao ? canonizarCasa(args.casa_promocao) : null,
      casaCobertura: args?.casa_cobertura ? canonizarCasa(args.casa_cobertura) : null,
    });
    if (!res) return { erro: 'entrada inválida: valor > 0 e odds > 1 são obrigatórios' };

    const m = margemImplicita(Number(args?.odd_promocao), Number(args?.odd_cobertura));
    // Na proteção, a pergunta operacional é "esse cashback cobre o custo do par de odds?".
    // C₀ é o piso: devolução efetiva abaixo dele e a operação vira prejuízo garantido.
    // A base é a stake ELEGÍVEL (não a digitada): com teto de stake, o piso da parte que
    // realmente entra na promoção é menor, e usar o valor cheio exigiria devolução maior
    // do que a operação precisa.
    const c0 = cashbackParaZerar(res.stakeElegivel, res.promoOddEfetiva, res.coverOddEfetiva);
    // Odd ótima só existe na FREEBET — e a SRR NÃO tem pico: como a ficha volta, a retenção
    // cai com a odd e o ótimo é a MENOR odd elegível. Este campo imprimia o √(1+1/m) da SNR
    // para qualquer tipo, inclusive SRR (conselho ativamente errado) e proteção (onde a
    // pergunta "que odd de freebet pegar" não existe). vFicha=1 porque valorFichaPct está
    // fora do schema e o core assume ficha em dinheiro (100%).
    //
    // `temMargem` é separado de propósito: com margem medida ≤ 0 (par que já é surebet), a
    // função devolve Infinity/NaN e ler isso como "sem pico" rotularia uma SNR com a doutrina
    // da SRR ("desça a odd"). Sem margem não há o que otimizar — e é isso que a resposta diz.
    const temMargem = ehFreebet && m > 0;
    const oddOtima = temMargem ? oddIdealFreebet(m, tipo === 'FREEBET_SRR' ? 1 : 0) : NaN;
    return {
      ...res,
      margem_implicita_da_cobertura_pct: r2(m * 100),
      ...(ehFreebet
        ? temMargem
          ? {
              direcao_do_otimo: Number.isFinite(oddOtima) ? 'pico' : 'menor-odd',
              odd_de_freebet_ideal_para_essa_margem: Number.isFinite(oddOtima) ? r2(oddOtima) : null,
              ...(Number.isFinite(oddOtima)
                ? {}
                : {
                    nota_do_otimo:
                      'Freebet SRR não tem odd ótima interior: a ficha volta, a retenção cai com a odd — pegue a MENOR odd que o regulamento aceita.',
                  }),
            }
          : {
              odd_de_freebet_ideal_para_essa_margem: null,
              // Com m ≤ 0 a retenção da SNR é (O−1)/O, que CRESCE com a odd: o ótimo é a MAIOR
              // odd elegível. Dizer "não há odd a otimizar" mandava parar exatamente onde o
              // modelo manda esticar (o espelho do erro que este lote corrigiu na SRR).
              direcao_do_otimo: tipo === 'FREEBET_SRR' ? 'menor-odd' : 'maior-odd',
              nota_do_otimo:
                tipo === 'FREEBET_SRR'
                  ? 'Margem medida ≤ 0 (par justo ou já surebet) numa SRR: a ficha volta, então continue na MENOR odd elegível.'
                  : 'Margem medida ≤ 0 (par justo ou já surebet): a retenção cresce com a odd — pegue a MAIOR odd que o regulamento aceita.',
            }
        : {}),
      ...(tipo === 'PROTECAO'
        ? {
            devolucao_minima_para_zerar_reais: r2(Math.max(0, c0)),
            devolucao_minima_para_zerar_pct_da_stake: res.stakeElegivel > 0 ? r2(Math.max(0, c0 / res.stakeElegivel) * 100) : null,
            folga_da_devolucao_reais: r2(res.cashbackEfetivo - Math.max(0, c0)),
          }
        : {}),
      // Nos tipos com boost o piso é o EXTRA, não a devolução (extraParaZerar vem do core).
      // MAS só quando o extra é pago FORA da odd (lucro extra, ou super odd em bônus): na
      // super odd em DINHEIRO a odd turbinada já contém o excedente, então `extraEfetivo` não
      // é parcela a somar e a "folga" comparava grandezas diferentes — dava folga positiva em
      // operação perdedora. Lá o piso é a própria odd: H/(H−1).
      ...(comBoost && (tipo === 'LUCRO_EXTRA' || res.extraEmBonus)
        ? {
            extra_minimo_para_zerar_reais: res.extraParaZerar,
            folga_do_extra_reais: r2(res.extraEfetivo - (res.extraParaZerar ?? 0)),
          }
        : comBoost
          ? {
              odd_promo_minima_para_zerar: r2(res.coverOddEfetiva / (res.coverOddEfetiva - 1)),
              folga_de_odd: r2(res.promoOddEfetiva - res.coverOddEfetiva / (res.coverOddEfetiva - 1)),
            }
          : {}),
      como_executar: comoExecutarPromocao(tipo, res),
    };
  },
};

export const skillOtimizarFreebet: Skill = {
  nome: 'otimizar_odd_freebet',
  resumo:
    'Curva de retenção da freebet por odd: na SNR devolve a odd ÓTIMA (pico); na SRR (a ficha volta) o ótimo é a MENOR odd elegível. Mede a margem do par observado.',
  grupo: 'calculo',
  descricao:
    'Mostra em que odd a freebet rende mais: curva de retenção por odd e lucro estimado. Na SNR (a ficha não volta) ' +
    'existe um PICO em O* = √(1+1/m); na SRR (a ficha volta no green) a retenção é monótona decrescente e o ótimo é ' +
    'a MENOR odd que o regulamento aceita — são doutrinas OPOSTAS, então informe o tipo. Aceita a margem do mercado ' +
    'OU (melhor) uma odd de promoção + a odd de cobertura observada na casa, de onde ele MEDE a margem real. ' +
    'Use quando o usuário perguntar "vale pegar odd alta?" ou antes de escolher o jogo da freebet.',
  parametros: {
    type: 'object',
    properties: {
      // Sem o tipo, um usuário de SRR recebia a odd ótima da SNR ("estique a odd") e perdia
      // retenção de propósito — os dois ótimos são opostos.
      tipo: { type: 'string', enum: ['FREEBET_SNR', 'FREEBET_SRR'] },
      valor_freebet: { type: 'number', description: 'Em reais (default 10).' },
      odd_promocao_observada: { type: 'number', description: 'Mede a margem.' },
      odd_cobertura_observada: { type: 'number', description: 'Do lado OPOSTO; mede a margem.' },
      margem_pct: { type: 'number', description: 'Da cobertura, em % (default 6).' },
      odds: { type: 'array', items: { type: 'number' } },
    },
    additionalProperties: false,
  },
  async executar(args: any) {
    // Tradutor do core: "aposta grátis que devolve a ficha", "SRR", "stake return" caem em
    // FREEBET_SRR; qualquer outro texto (e o tipo ausente) cai em SNR, que é o default
    // histórico da skill. v=1 porque a ficha da SRR volta em DINHEIRO no caso normal.
    const tipo = tipoPromocaoDeTexto(args?.tipo) === 'FREEBET_SRR' ? 'FREEBET_SRR' : 'FREEBET_SNR';
    const vFicha = tipo === 'FREEBET_SRR' ? 1 : 0;
    const valor = Number(args?.valor_freebet) > 0 ? Number(args.valor_freebet) : 10;
    let margem = Number(args?.margem_pct) > 0 ? Number(args.margem_pct) / 100 : 0.06;
    let origemMargem = `estimada (${r2(margem * 100)}%)`;
    const oP = Number(args?.odd_promocao_observada);
    const oC = Number(args?.odd_cobertura_observada);
    if (oP > 1 && oC > 1) {
      const medida = margemImplicita(oP, oC);
      if (medida > 0) {
        margem = medida;
        origemMargem = `MEDIDA no par observado (${oP} × ${oC}) = ${r2(medida * 100)}%`;
      }
    }
    const curva = curvaRetencaoFreebet(valor, margem, Array.isArray(args?.odds) ? args.odds.map(Number) : undefined, vFicha);
    // Sem pico, o número de referência é a MENOR odd da grade avaliada — dizer qual foi
    // evita o modelo apresentar "retenção no ideal" como se houvesse uma odd ótima.
    const menorOddAvaliada = curva.curva.reduce((min, p) => Math.min(min, p.promoOdd), Infinity);
    return {
      tipo,
      valor_freebet: valor,
      margem_usada_pct: curva.margemPct,
      origem_da_margem: origemMargem,
      direcao_do_otimo: curva.direcaoDoOtimo,
      odd_ideal: curva.oddIdeal,
      resposta:
        curva.direcaoDoOtimo === 'pico'
          ? `Pegue odd ~${curva.oddIdeal} (retenção estimada ${curva.retencaoIdealPct}%).`
          : `Não existe odd ótima interior nesta SRR: pegue a MENOR odd que o regulamento aceita. Na grade avaliada a melhor foi ${
              Number.isFinite(menorOddAvaliada) ? menorOddAvaliada : '—'
            } (retenção ${curva.retencaoIdealPct}%), e ela ainda imobiliza menos caixa na cobertura.`,
      retencao_no_ideal_pct: curva.retencaoIdealPct,
      cobertura_esperada_no_ideal: curva.coverOddNoIdeal,
      lucro_no_ideal: r2((curva.retencaoIdealPct / 100) * valor),
      curva: curva.curva,
      doutrina:
        curva.direcaoDoOtimo === 'pico'
          ? 'SNR (a ficha NÃO volta): R(O) = (O−1)·(1 − m·(O−1))/O tem PICO em O* = √(1+1/m) e CAI em odds ' +
            'esticadas — odd alta com cobertura em 1.06/1.07 rende ~40%, não 80%.'
          : 'SRR (a ficha VOLTA): R(O) = (O−1+v)·(1 − m·(O−1))/O é decrescente — não há pico, o único vazamento é ' +
            'a margem paga no lay e ela cresce com a odd. Não aplique aqui a doutrina da SNR ("estique a odd").',
    };
  },
};

export const skillMultiplaQualificadora: Skill = {
  nome: 'calcular_multipla_qualificadora',
  resumo:
    'Valida uma múltipla JÁ ESCOLHIDA e monta a cobertura sequencial (aporte por perna, caixa de pico). Para ESCOLHER as pernas: montar_multipla_promocao.',
  grupo: 'calculo',
  descricao:
    'Valida uma múltipla de qualificação contra o regulamento (odd total mínima, odd mínima por seleção) e monta ' +
    'a COBERTURA SEQUENCIAL: aporte de cada perna, gasto acumulado, resultado se der red em cada etapa, caixa de ' +
    'pico e lucro se todas baterem. Use para promoções "aposte e ganhe" com múltipla.',
  parametros: {
    type: 'object',
    properties: {
      stake: { type: 'number', description: 'Valor do bilhete.' },
      pernas: {
        type: 'array',
        description: 'Seleções na ORDEM de resolução.',
        items: {
          type: 'object',
          properties: {
            descricao: { type: 'string' },
            odd: { type: 'number' },
            oddCobertura: { type: 'number', description: 'Do mercado OPOSTO.' },
            resolveEm: { type: 'string', description: 'Quando a perna RESOLVE.' },
          },
          required: ['odd'],
        },
      },
      odd_total_minima: { type: 'number' },
      odd_minima_por_perna: { type: 'number' },
      perda_aceita: { type: 'number', description: 'No pior caminho; default 0.' },
    },
    required: ['stake', 'pernas'],
    additionalProperties: false,
  },
  async executar(args: any) {
    const res = calcularMultiplaQualificadora({
      stake: Number(args?.stake),
      pernas: (Array.isArray(args?.pernas) ? args.pernas : []).map((p: any) => ({
        descricao: p?.descricao,
        odd: Number(p?.odd),
        oddCobertura: p?.oddCobertura ?? p?.odd_cobertura ?? null,
        resolveEm: p?.resolveEm ?? p?.resolve_em ?? null,
      })),
      oddTotalMinima: args?.odd_total_minima,
      oddMinimaPorPerna: args?.odd_minima_por_perna,
      perdaAceita: args?.perda_aceita,
    });
    if (!res) return { erro: 'informe stake > 0 e ao menos uma perna com odd > 1' };
    return {
      ...res,
      doutrina:
        'Cobertura SEQUENCIAL: só aposte o passo k depois do GREEN da perna k−1. Red em qualquer etapa devolve o ' +
        'gasto acumulado e encerra a operação. Pernas precisam RESOLVER em momentos diferentes (dá para escalonar ' +
        'usando 1º tempo num jogo e 2º tempo no outro).',
    };
  },
};


/** Perna candidata: um lado de um mercado de 2 vias JÁ com cobertura localizada. */
interface PernaCandidata {
  jogo: JogoAgrupado;
  /** Odd da seleção na casa da promoção. */
  valor: number;
  /** 1/odd + 1/oddCobertura — quanto menor, mais barato é o hedge desta perna. */
  custoHedge: number;
  descricao: string;
  oddCobertura: number;
  casaCobertura: string;
}

/**
 * Mercados que servem de perna de promoção: 2 vias, jogo completo e líquidos nas casas.
 * Fora ficam props e recortes de tempo ("Primeiro gol", "1º Tempo"), que a promoção
 * costuma não aceitar e a casa de cobertura raramente oferece — no primeiro probe eles
 * entraram e deixaram 3 de 5 pernas sem cobertura.
 */
const MERCADO_PROMO_OK = /^(DNB_FT|TOTAIS_[A-Z]+_FT|HANDICAP_[A-Z]+_FT|AMBAS_MARCAM_FT|RESULTADO_FINAL_FT)$/;

const odd2 = (n: number) => Math.round(n * 100) / 100;

export const skillMontarMultiplaPromocao: Skill = {
  nome: 'montar_multipla_promocao',
  resumo:
    'MONTA a múltipla de promoção com odds reais: escolhe as pernas do regulamento, acha a cobertura em outra casa e a sequencial. LENTA.',
  grupo: 'calculo',
  custosa: true,
  descricao:
    'Monta uma múltipla de promoção (qualificativa, "aposte e ganhe", múltipla mínima) usando odds REAIS: ' +
    'varre o feed da casa da promoção, escolhe as seleções que satisfazem o regulamento (odd mínima por perna e ' +
    'odd total mínima), busca a odd do mercado OPOSTO nas casas de cobertura e devolve a cobertura sequencial ' +
    '(aporte por perna, caixa de pico, pior caminho). As Diretrizes de surebet (mercado proibido, grupo de W.O.) ' +
    'NÃO se aplicam aqui — promoção não é arbitragem; o risco residual vem como aviso.',
  parametros: {
    type: 'object',
    properties: {
      casa: { type: 'string', description: 'Casa da PROMOÇÃO (onde o bilhete vai).' },
      stake: { type: 'number', description: 'Valor do bilhete.' },
      odd_total_minima: { type: 'number', description: 'Do regulamento.' },
      odd_minima_por_perna: { type: 'number', description: 'default 1.20' },
      max_pernas: { type: 'number', description: 'default 5, teto 8' },
      esporte: { type: 'string', description: 'Default Futebol.' },
      // enum: restringe a saída do provedor e custa menos que a lista em prosa. O default
      // (pre_jogo aqui) vive no código — repeti-lo no schema é token pago em toda rodada.
      situacao: { type: 'string', enum: ['pre_jogo', 'ao_vivo', 'todos'] },
      casas_cobertura: { type: 'array', items: { type: 'string' }, description: 'Onde cobrir (máx. 3).' },
      perda_aceita: { type: 'number', description: 'No pior caminho; default 0.' },
    },
    required: ['casa', 'stake', 'odd_total_minima'],
    additionalProperties: false,
  },
  async executar(args: any, ctx: ContextoSkills) {
    const casaPromo = acharCasa(args?.casa);
    if (!casaPromo) {
      return { erro: `Casa "${args?.casa}" não está integrada — não consigo ler as odds dela.`, dica: 'chame listar_casas' };
    }
    const stake = Number(args?.stake);
    const oddTotalMin = Number(args?.odd_total_minima);
    if (!(stake > 0) || !(oddTotalMin > 1)) {
      return { erro: 'informe stake (> 0) e odd_total_minima (> 1) — são as duas exigências do regulamento' };
    }
    const oddMinPerna = Number(args?.odd_minima_por_perna) > 1 ? Number(args.odd_minima_por_perna) : 1.2;
    const maxPernas = Math.max(2, Math.min(8, Number(args?.max_pernas) || 5));
    const esporte = normalizarEsporte(args?.esporte);
    const situacao = lerSituacao(args?.situacao ?? 'pre_jogo');
    const perdaAceita = Number(args?.perda_aceita) > 0 ? Number(args.perda_aceita) : 0;

    // 1) Casas de cobertura (a múltipla é feita na casa da promoção; a cobertura vai em
    //    OUTRA casa, apostando o lado oposto de cada perna).
    const todas = catalogoCasas();
    const pedidas: string[] = Array.isArray(args?.casas_cobertura)
      ? args.casas_cobertura.filter((c: any) => typeof c === 'string' && c.trim())
      : [];
    const cobertura: CasaCatalogada[] = (pedidas.length
      ? pedidas.map((n) => acharCasa(n)).filter((c): c is CasaCatalogada => !!c)
      : todas.filter((c) => (c.transporte === 'api' || c.transporte === 'ws') && c.fonte_scanner)
    )
      .filter((c) => c.chave !== casaPromo.chave)
      .slice(0, 3);

    // 2) Feeds: casa da promoção + casas de cobertura, em UMA passada (2 por vez: 1 core).
    const alvos = [casaPromo, ...cobertura];
    const coletas = await comLimite(alvos, 2, async (casa) => ({
      nome: casa.nome,
      odds: await ctx.revalidation.feedDaCasa(casa.nome, esporte, { aoVivo: situacao !== 'pre_jogo' }),
    }));
    const fontes: FonteOdds[] = [];
    const falhas: string[] = [];
    coletas.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.odds.length) fontes.push(r.value);
      else falhas.push(alvos[i].nome);
    });
    const oddsPromo = fontes.find((f) => f.nome === casaPromo.nome)?.odds || [];
    if (!oddsPromo.length) {
      return {
        erro: `não consegui ler as odds da ${casaPromo.nome} (${esporte}) agora`,
        casas_que_falharam: falhas,
        dica: 'tente outro esporte, ou situacao="todos"',
      };
    }

    // 3) Agrupa TUDO por jogo de uma vez: cada grupo já traz as odds da casa da promoção e
    //    das casas de cobertura, que é exatamente o que a escolha da perna precisa.
    const jogos = agruparPorJogo(fontes).filter((j) =>
      situacao === 'ao_vivo' ? j.aoVivo : situacao === 'pre_jogo' ? !j.aoVivo : true
    );

    // 4) Candidatas — a escolha é feita SOBRE OS CLUSTERS COMPARADOS, não sobre o feed cru.
    //    Motivo, medido no primeiro probe: escolhendo do feed cru, 3 das 5 pernas saíram sem
    //    cobertura possível (mercado que a casa de cobertura não oferece) e ainda vinham
    //    mercados exóticos ("Primeiro gol", "1º Tempo") que promoção nenhuma aceita bem.
    //    Trabalhando no cluster, a perna só é candidata se JÁ existe o lado oposto em outra
    //    casa — e o lado oposto sai alinhado pelo mesmo pareamento do motor.
    const candidatas: PernaCandidata[] = [];
    for (const jogo of jogos) {
      if (!jogo.porCasa.has(casaPromo.nome)) continue;
      const fontesDoJogo: FonteOdds[] = [...jogo.porCasa.entries()].map(([casa, odds]) => ({ nome: casa, odds }));
      let melhor: PernaCandidata | null = null;
      for (const m of compararOfertas(fontesDoJogo)) {
        if (m.umaCasaSo) continue;
        if (!MERCADO_PROMO_OK.test(normalizarMercado(m.mercado))) continue;
        const ofertaPromo = m.casas.find((c) => c.casa === casaPromo.nome);
        if (!ofertaPromo) continue;
        for (const lado of ['A', 'B'] as const) {
          const oddPromo = lado === 'A' ? ofertaPromo.oddA : ofertaPromo.oddB;
          if (!(oddPromo >= oddMinPerna)) continue;
          // Cobertura = melhor odd do lado OPOSTO em casa DIFERENTE da promoção.
          const oposto = lado === 'A' ? m.melhorB : m.melhorA;
          if (!oposto || oposto.casa === casaPromo.nome) continue;
          // Entre as opções do mesmo jogo, fica a de cobertura mais BARATA: menor
          // (1/oddPromo + 1/oddCobertura) é menos dinheiro parado no hedge.
          const custo = 1 / oddPromo + 1 / oposto.odd;
          if (!melhor || custo < melhor.custoHedge) {
            melhor = {
              jogo,
              valor: oddPromo,
              custoHedge: custo,
              descricao: `${jogo.evento} — ${m.mercado}${m.linha !== null ? ` ${m.linha}` : ''}: ${
                lado === 'A' ? m.opcaoA : m.opcaoB
              }`,
              oddCobertura: oposto.odd,
              casaCobertura: oposto.casa,
            };
          }
        }
      }
      if (melhor) candidatas.push(melhor);
    }
    if (!candidatas.length) {
      return {
        erro: `não achei seleção com odd >= ${oddMinPerna} na ${casaPromo.nome} que TAMBÉM tenha cobertura nas casas consultadas (${esporte}, ${situacao})`,
        jogos_no_feed: jogos.length,
        casas_de_cobertura: fontes.filter((f) => f.nome !== casaPromo.nome).map((f) => f.nome),
        dica: 'baixe odd_minima_por_perna, adicione casas_cobertura ou troque o esporte',
      };
    }

    // Seleção EQUILIBRADA, não "as maiores odds primeiro".
    //
    // Medido no probe: pegando as maiores primeiro, a múltipla fechou com UMA perna de odd
    // 6.34 — qualifica no papel, mas cobrir uma odd dessas custou R$ 500 para um bilhete de
    // R$ 50 e o caminho all-green dava prejuízo de R$ 233. Odd alta é hedge caro. O alvo é
    // a odd equilibrada por perna (raiz n-ésima da odd total exigida), com piso na odd
    // mínima do regulamento — que é a prática de matched betting: várias pernas de favorito.
    const alvoPorPerna = Math.max(oddMinPerna, Math.pow(oddTotalMin, 1 / maxPernas));
    const ordenadas = [...candidatas].sort(
      (a, b) => Math.abs(a.valor - alvoPorPerna) - Math.abs(b.valor - alvoPorPerna) || a.custoHedge - b.custoHedge
    );
    const escolhidas: PernaCandidata[] = ordenadas.slice(0, maxPernas);
    let oddTotal = escolhidas.reduce((acc, c) => acc * c.valor, 1);
    // Faltou odd total? Troca a perna de MENOR odd pela MENOR candidata que ainda faz o
    // total bater — não pela maior. Pegando a maior, o probe fechou com uma perna de odd
    // 6.34 e odd total 20.28 para uma exigência de 5.00: overshoot que só encarece o hedge
    // (cobrir 6.34 custou R$ 500 de um bilhete de R$ 50).
    const reserva = ordenadas.slice(maxPernas).sort((a, b) => a.valor - b.valor);
    while (oddTotal < oddTotalMin && reserva.length) {
      let iMenor = 0;
      escolhidas.forEach((c, i) => {
        if (c.valor < escolhidas[iMenor].valor) iMenor = i;
      });
      const necessaria = (oddTotalMin / oddTotal) * escolhidas[iMenor].valor;
      const idx = reserva.findIndex((c) => c.valor >= necessaria);
      const troca = (idx >= 0 ? reserva.splice(idx, 1)[0] : reserva.pop()) as PernaCandidata;
      if (troca.valor <= escolhidas[iMenor].valor) break; // reserva não ajuda mais
      oddTotal = (oddTotal / escolhidas[iMenor].valor) * troca.valor;
      escolhidas[iMenor] = troca;
    }
    // ORDEM DE RESOLUÇÃO: a cobertura é sequencial (cada aporte depende do gasto acumulado
    // das pernas já resolvidas), então as pernas vão na ordem dos horários.
    escolhidas.sort((a, b) => (parseKickoff(a.jogo.inicio || undefined) ?? 0) - (parseKickoff(b.jogo.inicio || undefined) ?? 0));

    const pernas = escolhidas.map((c) => ({
      descricao: c.descricao,
      odd: odd2(c.valor),
      oddCobertura: odd2(c.oddCobertura),
      casaCobertura: c.casaCobertura,
      resolveEm: c.jogo.inicio || null,
    }));

    // 4) Cobertura sequencial pela MESMA matemática do app (core/promocoes).
    const res = calcularMultiplaQualificadora({
      stake,
      pernas: pernas.map((p) => ({
        descricao: p.descricao,
        odd: p.odd,
        oddCobertura: p.oddCobertura,
        resolveEm: p.resolveEm || undefined,
      })),
      oddTotalMinima: oddTotalMin,
      oddMinimaPorPerna: oddMinPerna,
      perdaAceita,
    });

    const semCobertura = pernas.filter((p) => p.oddCobertura === null).map((p) => p.descricao);
    return {
      casa_da_promocao: casaPromo.nome,
      esporte,
      situacao,
      regulamento: { stake, odd_total_minima: oddTotalMin, odd_minima_por_perna: oddMinPerna, max_pernas: maxPernas },
      jogos_no_feed: jogos.length,
      candidatas_encontradas: candidatas.length,
      casas_de_cobertura_consultadas: fontes.filter((f) => f.nome !== casaPromo.nome).map((f) => f.nome),
      casas_que_falharam: falhas.length ? falhas : undefined,
      odd_total: odd2(oddTotal),
      qualifica: oddTotal >= oddTotalMin,
      odd_alvo_por_perna: odd2(alvoPorPerna),
      pernas: pernas.map(
        (p, i) =>
          `${i + 1}. ${p.descricao} @${p.odd}` +
          (p.oddCobertura ? ` | cobrir em ${p.casaCobertura} @${p.oddCobertura}` : ' | ⚠️ SEM cobertura encontrada')
      ),
      pernas_sem_cobertura: semCobertura.length ? semCobertura : undefined,
      cobertura: res
        ? {
            possivel: res.cobertura.possivel,
            caixa_pico: res.cobertura.caixaPico,
            passos: res.cobertura.passos,
            avisos: res.cobertura.avisos,
            lucro_se_tudo_bater: res.cobertura.lucroSeTudoBater,
            problemas_de_regulamento: res.problemas,
          }
        : null,
      nota:
        'Diretrizes de SUREBET (mercado proibido, grupo de W.O.) NÃO se aplicam a promoção — aqui vale o regulamento da casa. ' +
        'Odds mudam: confira cada perna na tela antes de montar o bilhete. A cobertura é SEQUENCIAL: só aporte a perna seguinte depois do green da anterior.',
    };
  },
};

export const SKILLS_CALCULO: Skill[] = [
  skillCalcularSurebet,
  skillCalcularPromocao,
  skillOtimizarFreebet,
  skillMultiplaQualificadora,
  skillMontarMultiplaPromocao,
];
