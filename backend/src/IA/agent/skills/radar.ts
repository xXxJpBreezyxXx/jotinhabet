/**
 * SKILLS DO RADAR — surebets ativas, value bets, middles, Radar Cashout e revalidação.
 *
 * O CONTEXTO_APP já injeta um retrato (top 12 surebets, top 10 value bets…). Estas
 * skills existem para o que o retrato não cobre: FILTRAR (por ROI, esporte, casa),
 * BUSCAR por evento e AGIR (revalidar uma oportunidade específica ao vivo).
 */

import { Skill, ContextoSkills } from '../tipos';
import { supabase } from '../../../db/client';
import { getValorAtivas, getMiddlesAtivos } from '../../../core/valorRepo';
import { getRecentOpportunities } from '../../../cashout/cashoutRepo';
import { normalizarCasa } from '../../riskAnalyzer';
import { canonizarCasa } from '../../../signals/casasAliases';

const r2 = (v: any) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

export const skillSurebetsRadar: Skill = {
  nome: 'surebets_no_radar',
  resumo:
    'Surebets ativas no radar do app com filtros (roi_min, esporte, casa, evento, so_salvas). Dá o id para revalidar.',
  grupo: 'radar',
  descricao:
    'Lista as surebets ATIVAS no radar do app, com filtros (ROI mínimo, esporte, casa, texto do evento, ' +
    'só salvas, fonte). Use quando o usuário perguntar "o que tem no radar", "tem alguma surebet de tênis", ' +
    '"mostra as acima de 5%" ou quiser o id de uma oportunidade para revalidar/lançar.',
  parametros: {
    type: 'object',
    properties: {
      roi_min: { type: 'number', description: 'em %' },
      esporte: { type: 'string', description: 'Futebol | Basquete | Tênis | E-sports.' },
      casa: { type: 'string' },
      evento: { type: 'string', description: 'Texto no nome do evento.' },
      // enum: o filtro é um `includes` sobre estes valores; em prosa o modelo inventava
      // fonte ("radar", "agente") e o filtro devolvia zero.
      fonte: { type: 'string', enum: ['sureradar', 'motor', 'telegram', 'copiloto'] },
      so_salvas: { type: 'boolean', description: 'true = só as que o usuário salvou.' },
      limite: { type: 'number', description: 'default 15, teto 40' },
    },
    additionalProperties: false,
  },
  async executar(args: any) {
    const limite = Math.max(1, Math.min(40, Number(args?.limite) || 15));
    let q = supabase
      .from('oportunidades')
      .select(
        'id, evento, esporte, mercado, linha, casa_a_nome, casa_b_nome, opcao_a, opcao_b, odd_casa_1, odd_casa_2, roi_pct, fonte, status, salva, detectada_em, data_hora_evento'
      )
      .eq('status', 'detectada')
      .order('roi_pct', { ascending: false })
      .limit(200);
    if (Number.isFinite(Number(args?.roi_min))) q = q.gte('roi_pct', Number(args.roi_min));
    if (args?.so_salvas === true) q = q.eq('salva', true);

    const { data, error } = await q;
    if (error) return { erro: `falha ao consultar o radar: ${error.message}` };

    const alvoCasa = args?.casa ? normalizarCasa(canonizarCasa(args.casa)) : null;
    const alvoEsporte = (args?.esporte || '').toString().toLowerCase();
    const alvoEvento = (args?.evento || '').toString().toLowerCase();
    const alvoFonte = (args?.fonte || '').toString().toLowerCase();

    const linhas = (data || [])
      .filter((o: any) => {
        if (alvoEsporte && !(o.esporte || '').toLowerCase().includes(alvoEsporte)) return false;
        if (alvoEvento && !(o.evento || '').toLowerCase().includes(alvoEvento)) return false;
        if (alvoFonte && !(o.fonte || '').toLowerCase().includes(alvoFonte)) return false;
        if (alvoCasa) {
          const a = normalizarCasa(canonizarCasa(o.casa_a_nome || ''));
          const b = normalizarCasa(canonizarCasa(o.casa_b_nome || ''));
          if (a !== alvoCasa && b !== alvoCasa) return false;
        }
        return true;
      })
      .slice(0, limite)
      .map((o: any) => ({
        id: o.id,
        evento: o.evento,
        esporte: o.esporte,
        mercado: o.mercado,
        linha: o.linha ?? null,
        A: `${o.casa_a_nome} · ${o.opcao_a} @${r2(o.odd_casa_1)}`,
        B: `${o.casa_b_nome} · ${o.opcao_b} @${r2(o.odd_casa_2)}`,
        roi_pct: r2(o.roi_pct),
        fonte: o.fonte || 'motor',
        salva: !!o.salva,
        inicio: o.data_hora_evento || null,
        detectada_em: (o.detectada_em || '').slice(0, 16),
      }));

    return {
      total: linhas.length,
      filtros_aplicados: { roi_min: args?.roi_min ?? null, esporte: args?.esporte ?? null, casa: args?.casa ?? null, evento: args?.evento ?? null, fonte: args?.fonte ?? null, so_salvas: !!args?.so_salvas },
      surebets: linhas,
      nota: 'Odds do momento da detecção. Antes de apostar, use revalidar_surebet (id) ou comparar_odds_casas.',
    };
  },
};

export const skillRevalidarSurebet: Skill = {
  nome: 'revalidar_surebet',
  resumo:
    'Reconsulta ao vivo as duas pernas de uma oportunidade (por id) e diz se a surebet segue de pé, encolheu ou sumiu. LENTA.',
  grupo: 'radar',
  custosa: true,
  descricao:
    'Reconsulta AO VIVO as duas pernas de uma oportunidade do radar (por id) e recalcula o ROI atual, ' +
    'dizendo se a surebet segue de pé, encolheu, melhorou ou sumiu. Use antes de o usuário apostar, ' +
    'ou quando ele perguntar "essa ainda está valendo?". Pegue o id em surebets_no_radar.',
  parametros: {
    type: 'object',
    properties: { id: { type: 'string', description: 'uuid da oportunidade no radar.' } },
    required: ['id'],
    additionalProperties: false,
  },
  async executar(args: any, ctx: ContextoSkills) {
    const id = (args?.id || '').toString().trim();
    if (!id) return { erro: 'informe o id da oportunidade' };
    try {
      const r = await ctx.revalidation.revalidar(id);
      return {
        id,
        ...r,
        leitura:
          r.status === 'ok'
            ? 'Segue de pé com as odds atuais.'
            : r.status === 'reduzida'
            ? 'Ainda fecha, mas com ROI menor que o detectado.'
            : r.status === 'melhorou'
            ? 'ROI atual MAIOR que o detectado.'
            : r.status === 'expirada'
            ? 'Não fecha mais arbitragem com as odds atuais.'
            : r.status === 'nao_encontrada'
            ? 'As pernas não foram encontradas agora (mercado fechado/nome mudou).'
            : r.status === 'nao_suportado'
            ? 'Alguma casa não tem scraper — confira manualmente.'
            : 'Erro na revalidação.',
      };
    } catch (e: any) {
      return { erro: `${e?.message || e}`.slice(0, 200) };
    }
  },
};

export const skillValueBets: Skill = {
  nome: 'value_bets_e_middles',
  resumo:
    'Value bets (+EV vs linha afiada da Pinnacle) e middles ativos, com edge e ROI de pior caso.',
  grupo: 'radar',
  descricao:
    'Lista as value bets (+EV contra a linha afiada da Pinnacle) e os middles ativos, com edge/ROI de pior caso. ' +
    'Use quando o usuário perguntar sobre valor esperado, "onde tem edge", ou middles.',
  parametros: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['value', 'middle', 'ambos'] },
      edge_min: { type: 'number', description: 'em % (value bets)' },
      limite: { type: 'number', description: 'por tipo; default 10, teto 30' },
    },
    additionalProperties: false,
  },
  async executar(args: any) {
    const limite = Math.max(1, Math.min(30, Number(args?.limite) || 10));
    const tipo = (args?.tipo || 'ambos').toString().toLowerCase();
    const saida: any = {};
    if (tipo !== 'middle') {
      try {
        const vals = await getValorAtivas(50);
        saida.value_bets = vals
          .filter((o: any) => !Number.isFinite(Number(args?.edge_min)) || Number(o.edge_pct) >= Number(args.edge_min))
          .slice(0, limite)
          .map((o: any) => ({
            id: o.id,
            evento: o.evento,
            esporte: o.esporte,
            mercado: o.mercado,
            linha: o.linha ?? null,
            casa: o.casa,
            opcao: o.opcao,
            odd: r2(o.odd_casa),
            odd_justa: r2(o.fair_odd),
            edge_pct: r2(o.edge_pct),
            inicio: (o.starts_at || '').slice(0, 16),
          }));
      } catch (e: any) {
        saida.value_bets_erro = `${e?.message || e}`.slice(0, 160);
      }
    }
    if (tipo !== 'value') {
      try {
        const mids = await getMiddlesAtivos(30);
        saida.middles = mids.slice(0, limite).map((m: any) => ({
          id: m.id,
          evento: m.evento,
          mercado: m.mercado,
          over: `${m.over_casa} +${m.over_linha} @${r2(m.over_odd)}`,
          under: `${m.under_casa} -${m.under_linha} @${r2(m.under_odd)}`,
          pior_caso_roi_pct: r2(m.pior_caso_roi_pct),
        }));
      } catch (e: any) {
        saida.middles_erro = `${e?.message || e}`.slice(0, 160);
      }
    }
    saida.nota = 'Value bet NÃO é surebet: tem variância. O app trata value bet como radar, sem alerta automático.';
    return saida;
  },
};

export const skillRadarCashout: Skill = {
  nome: 'radar_cashout',
  resumo:
    'Oportunidades recentes do Radar Cashout (dropping odds: a odd afiada caiu e a casa-alvo não acompanhou).',
  grupo: 'radar',
  descricao:
    'Lista as oportunidades recentes do Radar Cashout (modelo dropping odds: a odd afiada caiu e a casa-alvo ' +
    'ainda não acompanhou). Use quando o usuário perguntar do cashout/dropping odds ou de uma aposta que ele monitora.',
  parametros: {
    type: 'object',
    properties: {
      janela_min: { type: 'number', description: 'minutos; default 1440, teto 4320' },
      limite: { type: 'number', description: 'default 10, teto 30' },
    },
    additionalProperties: false,
  },
  async executar(args: any) {
    const janela = Math.max(15, Math.min(4320, Number(args?.janela_min) || 1440));
    const limite = Math.max(1, Math.min(30, Number(args?.limite) || 10));
    try {
      const ops = await getRecentOpportunities(janela);
      return {
        janela_min: janela,
        total: ops.length,
        oportunidades: ops.slice(0, limite).map((o: any) => ({
          id: o.id,
          evento: o.evento || o.event_name,
          mercado: o.market_label,
          casa: o.target_bookmaker || o.casa,
          odd_casa: r2(o.target_odd),
          odd_justa: r2(o.fair_odd),
          valor_pct: r2(o.value_pct ?? o.edge_pct),
          detectada_em: (o.created_at || o.detected_at || '').slice(0, 16),
        })),
      };
    } catch (e: any) {
      return { erro: `${e?.message || e}`.slice(0, 200) };
    }
  },
};

export const SKILLS_RADAR: Skill[] = [skillSurebetsRadar, skillRevalidarSurebet, skillValueBets, skillRadarCashout];
