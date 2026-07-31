/**
 * SKILLS DE BANCA E HISTÓRICO — banca ativa, saldos por casa, entradas lançadas e
 * histórico de promoções (matched betting).
 *
 * O CONTEXTO_APP já traz o retrato agregado; aqui o agente CONSULTA com filtro
 * (período, esporte, casa) e chega no detalhe que o retrato corta.
 */

import { Skill } from '../tipos';
import { supabase } from '../../../db/client';
import { bancaParaAlertas } from '../../../core/bancaAtiva';
import { normalizarCasa } from '../../riskAnalyzer';
import { canonizarCasa } from '../../../signals/casasAliases';

const r2 = (v: any) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/**
 * Data ISO a partir dos formatos que o modelo realmente manda. Aceita "DD/MM/AAAA",
 * "AAAA-MM-DD", "AAAA-MM" (mês inteiro) e "DD/MM" (ano corrente); `fim=true` completa
 * o mês para o último dia. Antes, "2026-07" virava null e o filtro de período
 * simplesmente NÃO era aplicado — a skill respondia o histórico inteiro como se fosse
 * o do mês pedido.
 */
function dataIso(v: any, fim = false): string | null {
  const s = (v || '').toString().trim();
  if (!s) return null;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mes = s.match(/^(\d{4})-(\d{2})$/);
  if (mes) return fim ? `${mes[1]}-${mes[2]}-${new Date(Number(mes[1]), Number(mes[2]), 0).getDate()}` : `${mes[1]}-${mes[2]}-01`;
  const brSemAno = s.match(/^(\d{2})\/(\d{2})$/);
  if (brSemAno) return `${new Date().getFullYear()}-${brSemAno[2]}-${brSemAno[1]}`;
  return null;
}

export const skillBancaSaldos: Skill = {
  nome: 'banca_e_saldos',
  resumo:
    'Banca ativa do painel e saldo declarado por casa. Use antes de sugerir aporte.',
  grupo: 'banca',
  descricao:
    'Banca ATIVA do painel (a que dimensiona os stakes dos alertas) e o saldo declarado em cada casa. ' +
    'Use antes de sugerir aporte: se o saldo da casa não cobre o stake, avise o usuário.',
  parametros: { type: 'object', properties: {}, additionalProperties: false },
  async executar() {
    const saida: any = {};
    try {
      saida.banca_ativa_reais = r2(await bancaParaAlertas());
    } catch (e: any) {
      saida.banca_ativa_reais = null;
      saida.banca_erro = `${e?.message || e}`.slice(0, 140);
    }
    try {
      const { data } = await supabase.from('app_config').select('valor').eq('chave', 'saldos_casas').maybeSingle();
      const saldos = data?.valor ? JSON.parse(data.valor) : [];
      const lista = (Array.isArray(saldos) ? saldos : [])
        .map((s: any) => ({ casa: s.casa || s.nome, valor: r2(s.valor) }))
        .filter((s: any) => s.casa && s.valor !== null);
      saida.saldos_por_casa = lista;
      saida.saldo_total_declarado = r2(lista.reduce((acc: number, s: any) => acc + (s.valor || 0), 0));
      saida.casas_com_saldo = lista.filter((s: any) => (s.valor || 0) > 0).map((s: any) => s.casa);
    } catch (e: any) {
      saida.saldos_erro = `${e?.message || e}`.slice(0, 140);
    }
    return saida;
  },
};

export const skillHistoricoEntradas: Skill = {
  nome: 'historico_entradas',
  resumo:
    'Entradas já lançadas na banca com filtro (de, ate, esporte, casa) e agregados de lucro/ROI.',
  grupo: 'banca',
  descricao:
    'Entradas já lançadas na banca (operações), com filtro por período, esporte e casa, mais os agregados ' +
    '(quantidade, lucro total, ROI médio). Use para "quanto lucrei", "como foi julho", "minhas entradas de tênis".',
  parametros: {
    type: 'object',
    properties: {
      de: { type: 'string', description: 'Data inicial (DD/MM/AAAA ou AAAA-MM-DD).' },
      ate: { type: 'string', description: 'Data final (DD/MM/AAAA ou AAAA-MM-DD).' },
      esporte: { type: 'string', description: 'Filtro por esporte.' },
      casa: { type: 'string', description: 'Filtro por casa envolvida.' },
      limite: { type: 'number', description: 'Máximo de entradas detalhadas (default 20, teto 60).' },
    },
    additionalProperties: false,
  },
  async executar(args: any) {
    const limite = Math.max(1, Math.min(60, Number(args?.limite) || 20));
    const de = dataIso(args?.de);
    const ate = dataIso(args?.ate, true);
    // Data que não deu para interpretar precisa APARECER na resposta: um filtro que não
    // foi aplicado em silêncio faz o modelo apresentar o histórico inteiro como recorte.
    const datasIgnoradas = [
      args?.de && !de ? `de="${args.de}"` : null,
      args?.ate && !ate ? `ate="${args.ate}"` : null,
    ].filter(Boolean) as string[];

    let q = supabase
      .from('operacoes')
      .select('id, confirmado_em, stake_real_1, stake_real_2, lucro_real, resultado')
      .order('confirmado_em', { ascending: false })
      .limit(500);
    if (de) q = q.gte('confirmado_em', `${de}T00:00:00`);
    if (ate) q = q.lte('confirmado_em', `${ate}T23:59:59`);

    const { data, error } = await q;
    if (error) return { erro: `falha ao consultar operações: ${error.message}` };

    const alvoCasa = args?.casa ? normalizarCasa(canonizarCasa(args.casa)) : null;
    const alvoEsporte = (args?.esporte || '').toString().toLowerCase();

    const ops = (data || [])
      .map((op: any) => {
        let d: any = {};
        try {
          if (typeof op.resultado === 'string' && op.resultado.startsWith('{')) d = JSON.parse(op.resultado);
        } catch {
          /* segue com o que tem */
        }
        return {
          id: op.id,
          data: (op.confirmado_em || '').slice(0, 16),
          evento: d.evento || null,
          esporte: d.esporte || null,
          mercado: d.mercado || null,
          casas: [d.casaA, d.casaB].filter(Boolean),
          odds: [d.oddA, d.oddB].filter(Boolean),
          investido: r2((Number(op.stake_real_1) || 0) + (Number(op.stake_real_2) || 0)),
          lucro: r2(op.lucro_real),
          roi_pct: r2(d.roi),
          manual: !!d.manual,
        };
      })
      .filter((o) => {
        if (alvoEsporte && !(o.esporte || '').toLowerCase().includes(alvoEsporte)) return false;
        if (alvoCasa && !o.casas.some((c: string) => normalizarCasa(canonizarCasa(c)) === alvoCasa)) return false;
        return true;
      });

    const lucroTotal = ops.reduce((s, o) => s + (o.lucro || 0), 0);
    const investidoTotal = ops.reduce((s, o) => s + (o.investido || 0), 0);
    const rois = ops.map((o) => o.roi_pct).filter((v): v is number => v !== null);

    return {
      filtros: { de: de || null, ate: ate || null, esporte: args?.esporte || null, casa: args?.casa || null },
      ...(datasIgnoradas.length
        ? {
            aviso: `NÃO entendi ${datasIgnoradas.join(' e ')} — o filtro de período NÃO foi aplicado e os números abaixo são de TODO o histórico. Use DD/MM/AAAA ou AAAA-MM-DD.`,
          }
        : {}),
      agregado: {
        total_entradas: ops.length,
        lucro_total: r2(lucroTotal),
        investido_total: r2(investidoTotal),
        roi_medio_pct: rois.length ? r2(rois.reduce((a, b) => a + b, 0) / rois.length) : null,
        roi_sobre_investido_pct: investidoTotal > 0 ? r2((lucroTotal / investidoTotal) * 100) : null,
      },
      entradas: ops.slice(0, limite),
    };
  },
};

export const skillHistoricoPromocoes: Skill = {
  nome: 'historico_promocoes',
  resumo:
    'Histórico de apostas de promoção (freebets/qualificativas) com lucro, ROI e retenção média.',
  grupo: 'banca',
  descricao:
    'Histórico das apostas de PROMOÇÃO já registradas (freebets SNR e qualificativas): casa, valor do bônus, ' +
    'odds das duas pernas, lucro e ROI. Use para "quanto já tirei de freebet", "quais promoções eu fiz" ou para ' +
    'medir a retenção média que o usuário vem conseguindo.',
  parametros: {
    type: 'object',
    properties: {
      limite: { type: 'number', description: 'Máximo de registros (default 20, teto 60).' },
      tipo: { type: 'string', description: 'FREEBET_SNR | QUALIFYING (vazio = todos).' },
    },
    additionalProperties: false,
  },
  async executar(args: any) {
    const limite = Math.max(1, Math.min(60, Number(args?.limite) || 20));
    try {
      const { data, error } = await supabase
        .from('promo_surebets')
        .select('*')
        .order('criado_em', { ascending: false })
        .limit(200);
      if (error) throw error;
      // O vocabulário exposto ao modelo nas outras skills é QUALIFICATIVA, mas a coluna
      // do banco guarda QUALIFYING — sem este mapeamento o filtro devolvia zero calado.
      const bruto = (args?.tipo || '').toString().toUpperCase();
      const tipo = /QUALIF/.test(bruto) ? 'QUALIFYING' : /FREEBET|SNR/.test(bruto) ? 'FREEBET_SNR' : '';
      const linhas = (data || [])
        .filter((p: any) => !tipo || (p.promo_type || 'FREEBET_SNR') === tipo)
        .map((p: any) => ({
          id: p.id,
          tipo: p.promo_type || 'FREEBET_SNR',
          data: (p.criado_em || '').slice(0, 16),
          evento: p.evento,
          mercado: p.mercado,
          casa_promocao: p.casa_promocao,
          valor_promocao: r2(p.valor_promocao),
          odd_promocao: r2(p.odd_promocao),
          casa_cobertura: p.casa_cobertura,
          valor_cobertura: r2(p.valor_cobertura),
          odd_cobertura: r2(p.odd_cobertura),
          lucro: r2(p.lucro),
          roi_pct: r2(p.roi_pct),
          retencao_pct:
            (p.promo_type || 'FREEBET_SNR') === 'FREEBET_SNR' && Number(p.valor_promocao) > 0
              ? r2((Number(p.lucro) / Number(p.valor_promocao)) * 100)
              : null,
        }));
      const freebets = linhas.filter((l) => l.tipo === 'FREEBET_SNR' && l.retencao_pct !== null);
      return {
        total: linhas.length,
        lucro_total: r2(linhas.reduce((s, l) => s + (l.lucro || 0), 0)),
        retencao_media_freebets_pct: freebets.length
          ? r2(freebets.reduce((s, l) => s + (l.retencao_pct || 0), 0) / freebets.length)
          : null,
        promocoes: linhas.slice(0, limite),
      };
    } catch (e: any) {
      const msg = `${e?.message || e}`;
      if (/promo_surebets|does not exist|PGRST205/i.test(msg)) {
        return { total: 0, promocoes: [], nota: 'Tabela promo_surebets ausente (migration 018 não aplicada).' };
      }
      return { erro: msg.slice(0, 200) };
    }
  },
};

export const SKILLS_BANCA: Skill[] = [skillBancaSaldos, skillHistoricoEntradas, skillHistoricoPromocoes];
