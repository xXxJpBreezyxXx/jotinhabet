/**
 * SKILLS DE CÁLCULO — surebet, cobertura de promoção (freebet SNR/qualificativa),
 * otimização da odd de freebet e múltipla qualificadora com cobertura sequencial.
 *
 * Por que ferramenta e não "o modelo calcula": LLM erra aritmética de centavo e o
 * usuário digita o aporte na casa. Aqui a matemática é a MESMA de core/calculator.ts e
 * core/promocoes.ts (testada em vitest) — o modelo só interpreta o resultado.
 */

import { Skill } from '../tipos';
import { calcularArbitragem } from '../../../core/calculator';
import {
  calcularPromocao,
  calcularMultiplaQualificadora,
  curvaRetencaoFreebet,
  margemImplicita,
  oddIdealFreebet,
  TipoPromocao,
} from '../../../core/promocoes';
import { bancaParaAlertas } from '../../../core/bancaAtiva';
import { canonizarCasa } from '../../../signals/casasAliases';

const r2 = (v: number) => Math.round(v * 100) / 100;

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
      casa1: { type: 'string', description: 'Nome da casa da perna 1 (resolve comissão de exchange).' },
      casa2: { type: 'string' },
      investimento_total: { type: 'number', description: 'Total a investir. Vazio = usa a banca ativa do painel.' },
      arredondar_para: { type: 'number', description: 'Passo de arredondamento do aporte (ex.: 1 = reais inteiros; default 0.01).' },
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

export const skillCalcularPromocao: Skill = {
  nome: 'calcular_cobertura_promocao',
  resumo:
    'Cobertura de freebet SNR ou qualificativa (com cashback opcional): aporte exato, lucro nos dois cenários, lucro garantido, ROI e retenção.',
  grupo: 'calculo',
  descricao:
    'Calcula a cobertura de uma aposta de PROMOÇÃO: freebet SNR (a ficha não volta) ou qualificativa ' +
    '(dinheiro real), com cashback opcional. Devolve o aporte exato da cobertura, o lucro nos dois cenários, ' +
    'o lucro garantido, ROI e a RETENÇÃO da freebet. Use sempre que o usuário falar de freebet, aposta extra, ' +
    'bônus, aposta qualificadora ou "quanto cubro".',
  parametros: {
    type: 'object',
    properties: {
      tipo: { type: 'string', description: 'FREEBET_SNR (ficha não retorna) ou QUALIFICATIVA (dinheiro real).' },
      valor_promocao: { type: 'number', description: 'Valor da freebet ou stake real da qualificadora.' },
      odd_promocao: { type: 'number', description: 'Odd da perna promocional.' },
      odd_cobertura: { type: 'number', description: 'Odd do mercado OPOSTO na casa de cobertura.' },
      aporte_cobertura: { type: 'number', description: 'Aporte já feito/planejado. Vazio = calcula o que EQUALIZA os cenários.' },
      cashback: { type: 'number', description: 'Cashback em reais que a casa devolve (ex.: 10).' },
      cashback_so_se_perder: { type: 'boolean', description: 'true (default) = cashback só se a perna promocional perder.' },
      casa_promocao: { type: 'string' },
      casa_cobertura: { type: 'string', description: 'Usada para descontar comissão de exchange.' },
    },
    required: ['valor_promocao', 'odd_promocao', 'odd_cobertura'],
    additionalProperties: false,
  },
  async executar(args: any) {
    const tipo: TipoPromocao = /QUALIF/i.test(`${args?.tipo}`) ? 'QUALIFICATIVA' : 'FREEBET_SNR';
    const res = calcularPromocao({
      tipo,
      promoStake: Number(args?.valor_promocao),
      promoOdd: Number(args?.odd_promocao),
      coverOdd: Number(args?.odd_cobertura),
      coverStake: args?.aporte_cobertura,
      cashback: args?.cashback,
      cashbackSoSePerder: args?.cashback_so_se_perder,
      casaPromo: args?.casa_promocao ? canonizarCasa(args.casa_promocao) : null,
      casaCobertura: args?.casa_cobertura ? canonizarCasa(args.casa_cobertura) : null,
    });
    if (!res) return { erro: 'entrada inválida: valor > 0 e odds > 1 são obrigatórios' };

    const m = margemImplicita(Number(args?.odd_promocao), Number(args?.odd_cobertura));
    return {
      ...res,
      margem_implicita_da_cobertura_pct: r2(m * 100),
      odd_de_freebet_ideal_para_essa_margem: m > 0 ? r2(oddIdealFreebet(m)) : null,
      como_executar:
        tipo === 'FREEBET_SNR'
          ? `Aposte a freebet de R$ ${res.promoStake.toFixed(2)} @${res.promoOdd} e cubra com R$ ${res.coverStake.toFixed(2)} @${res.coverOdd} no mercado oposto, em OUTRA casa. Confirme a odd na tela antes de digitar o aporte.`
          : `Aposte R$ ${res.promoStake.toFixed(2)} @${res.promoOdd} (qualificadora) e cubra com R$ ${res.coverStake.toFixed(2)} @${res.coverOdd} no mercado oposto, em OUTRA casa.`,
    };
  },
};

export const skillOtimizarFreebet: Skill = {
  nome: 'otimizar_odd_freebet',
  resumo:
    'Curva de retenção da freebet por odd e a odd ótima. Mede a margem real se você passar a odd da promo e a de cobertura observadas.',
  grupo: 'calculo',
  descricao:
    'Mostra em que odd a freebet rende mais: curva de retenção por odd, odd ótima √(1+1/m) e lucro estimado. ' +
    'Aceita a margem do mercado OU (melhor) uma odd de promoção + a odd de cobertura observada na casa, de onde ' +
    'ele MEDE a margem real. Use quando o usuário perguntar "vale pegar odd alta?" ou antes de escolher o jogo da freebet.',
  parametros: {
    type: 'object',
    properties: {
      valor_freebet: { type: 'number', description: 'Valor da freebet em reais (default 10).' },
      odd_promocao_observada: { type: 'number', description: 'Odd que ele viu na casa da promoção (para medir a margem).' },
      odd_cobertura_observada: { type: 'number', description: 'Odd do mercado oposto na casa de cobertura (para medir a margem).' },
      margem_pct: { type: 'number', description: 'Margem do mercado de cobertura em % (default 6, usado se não medir).' },
      odds: { type: 'array', items: { type: 'number' }, description: 'Odds específicas a avaliar.' },
    },
    additionalProperties: false,
  },
  async executar(args: any) {
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
    const curva = curvaRetencaoFreebet(valor, margem, Array.isArray(args?.odds) ? args.odds.map(Number) : undefined);
    return {
      valor_freebet: valor,
      margem_usada_pct: curva.margemPct,
      origem_da_margem: origemMargem,
      odd_ideal: curva.oddIdeal,
      retencao_no_ideal_pct: curva.retencaoIdealPct,
      cobertura_esperada_no_ideal: curva.coverOddNoIdeal,
      lucro_no_ideal: r2((curva.retencaoIdealPct / 100) * valor),
      curva: curva.curva,
      doutrina:
        'Retenção R(O) = (O−1)·(1 − m·(O−1))/O tem PICO em O* = √(1+1/m) e CAI em odds esticadas — ' +
        'odd alta com cobertura em 1.06/1.07 rende ~40%, não 80%.',
    };
  },
};

export const skillMultiplaQualificadora: Skill = {
  nome: 'calcular_multipla_qualificadora',
  resumo:
    'Valida a múltipla contra o regulamento e monta a cobertura SEQUENCIAL: aporte por perna, gasto acumulado, caixa de pico e lucro se tudo bater.',
  grupo: 'calculo',
  descricao:
    'Valida uma múltipla de qualificação contra o regulamento (odd total mínima, odd mínima por seleção) e monta ' +
    'a COBERTURA SEQUENCIAL: aporte de cada perna, gasto acumulado, resultado se der red em cada etapa, caixa de ' +
    'pico e lucro se todas baterem. Use para promoções "aposte e ganhe" com múltipla.',
  parametros: {
    type: 'object',
    properties: {
      stake: { type: 'number', description: 'Valor do bilhete (ex.: 50).' },
      pernas: {
        type: 'array',
        description: 'Seleções do bilhete, na ORDEM de resolução.',
        items: {
          type: 'object',
          properties: {
            descricao: { type: 'string', description: 'Ex.: "Grêmio vence (19:30)".' },
            odd: { type: 'number', description: 'Odd da seleção no bilhete.' },
            oddCobertura: { type: 'number', description: 'Odd do mercado OPOSTO na casa de cobertura.' },
            resolveEm: { type: 'string', description: 'Quando essa perna RESOLVE (ex.: "30/07 20:15 (1ºT)").' },
          },
          required: ['odd'],
        },
      },
      odd_total_minima: { type: 'number', description: 'Exigência da promoção (ex.: 4.00).' },
      odd_minima_por_perna: { type: 'number', description: 'Exigência da promoção (ex.: 1.20).' },
      perda_aceita: { type: 'number', description: 'Perda que ele aceita no pior caminho (default 0 = cobertura total).' },
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

export const SKILLS_CALCULO: Skill[] = [
  skillCalcularSurebet,
  skillCalcularPromocao,
  skillOtimizarFreebet,
  skillMultiplaQualificadora,
];
