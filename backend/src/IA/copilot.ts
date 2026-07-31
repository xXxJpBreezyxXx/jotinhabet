// copilot.ts
// Contexto AO VIVO e ações do Copiloto de Arbitragem (aba "IA & Automação").
//
// Parte 1 — montarContextoApp(): retrato compacto do app (banca, saldos, histórico
// de entradas, surebets ativas, value bets, middles, calibração) injetado no system
// prompt de cada mensagem do chat. Todas as buscas são tolerantes a falha: fonte
// indisponível vira uma nota no próprio contexto, nunca derruba o chat.
//
// Parte 2 — ação criar_oportunidade: o modelo, quando o usuário pede explicitamente,
// emite um bloco JSON no fim da resposta; o backend valida os campos e roda o MESMO
// SignalPipeline dos sinais do Telegram (gates de risco + dedup + revalidação ao vivo
// antes de alertar). O Copiloto nunca aposta — só registra no radar.

import { supabase } from '../db/client';
import { bancaParaAlertas } from '../core/bancaAtiva';
import { getValorAtivas, getMiddlesAtivos } from '../core/valorRepo';
import { getResumoCalibracao } from '../core/calibracaoRepo';
import { SignalPipeline, ResultadoPipeline } from '../signals/signalPipeline';
import { SinalExtraido } from './extractors/telegramSignalExtractor';

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null);
const r2 = (v: any) => (num(v) === null ? null : Math.round(Number(v) * 100) / 100);

/** Retrato compacto do app para o system prompt do chat (JSON por seção). */
export async function montarContextoApp(): Promise<string> {
  const secoes: string[] = [];
  const agora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  secoes.push(`agora (America/Sao_Paulo): ${agora}`);

  // Banca ativa do painel
  try {
    const banca = await bancaParaAlertas();
    secoes.push(`banca_ativa_reais: ${banca.toFixed(2)}`);
  } catch { secoes.push('banca_ativa_reais: indisponível'); }

  // Saldos por casa (app_config.saldos_casas)
  try {
    const { data } = await supabase.from('app_config').select('valor').eq('chave', 'saldos_casas').maybeSingle();
    const saldos = data?.valor ? JSON.parse(data.valor) : [];
    const comSaldo = (Array.isArray(saldos) ? saldos : []).filter((s: any) => num(s.valor) && Number(s.valor) > 0);
    secoes.push(`saldos_por_casa: ${JSON.stringify(comSaldo)}`);
  } catch { secoes.push('saldos_por_casa: indisponível'); }

  // Histórico de entradas lançadas na banca (últimas 15 + agregados)
  try {
    const { data } = await supabase
      .from('operacoes')
      .select('confirmado_em, stake_real_1, stake_real_2, lucro_real, resultado')
      .order('confirmado_em', { ascending: false })
      .limit(200);
    const ops = (data || []).map((op: any) => {
      let d: any = {};
      try { if (op.resultado?.startsWith('{')) d = JSON.parse(op.resultado); } catch { /* segue */ }
      return {
        data: (op.confirmado_em || '').slice(0, 16),
        evento: d.evento, esporte: d.esporte, mercado: d.mercado,
        casas: [d.casaA, d.casaB].filter(Boolean).join(' × '),
        odds: [d.oddA, d.oddB].filter(Boolean).join(' / '),
        investido: r2((num(op.stake_real_1) || 0) + (num(op.stake_real_2) || 0)),
        lucro: r2(op.lucro_real),
        roi_pct: r2(d.roi),
        manual: d.manual || undefined,
      };
    });
    const lucroTotal = ops.reduce((s, o) => s + (o.lucro || 0), 0);
    const rois = ops.map((o) => o.roi_pct).filter((v): v is number => v !== null);
    const roiMedio = rois.length ? rois.reduce((a, b) => a + b, 0) / rois.length : null;
    secoes.push(
      `historico_entradas_agregado: ${JSON.stringify({ total_entradas: ops.length, lucro_total: r2(lucroTotal), roi_medio_pct: r2(roiMedio) })}\n` +
      `historico_entradas_ultimas_15: ${JSON.stringify(ops.slice(0, 15))}`
    );
  } catch { secoes.push('historico_entradas: indisponível'); }

  // Surebets ativas no radar (top ROI)
  try {
    const { data } = await supabase
      .from('oportunidades')
      .select('evento, esporte, mercado, casa_a_nome, casa_b_nome, opcao_a, opcao_b, odd_casa_1, odd_casa_2, roi_pct, fonte, detectada_em')
      .eq('status', 'detectada')
      .order('roi_pct', { ascending: false })
      .limit(12);
    const rows = (data || []).map((o: any) => ({
      evento: o.evento, esporte: o.esporte, mercado: o.mercado,
      A: `${o.casa_a_nome} ${o.opcao_a} @${r2(o.odd_casa_1)}`,
      B: `${o.casa_b_nome} ${o.opcao_b} @${r2(o.odd_casa_2)}`,
      roi_pct: r2(o.roi_pct), fonte: o.fonte || 'sureradar/motor',
      detectada_em: (o.detectada_em || '').slice(0, 16),
    }));
    secoes.push(`surebets_ativas_radar_top12: ${JSON.stringify(rows)}`);
  } catch { secoes.push('surebets_ativas_radar: indisponível'); }

  // Value bets (+EV) e middles ativos
  try {
    const vals = (await getValorAtivas(10)).map((o: any) => ({
      evento: o.evento, esporte: o.esporte, mercado: o.mercado, linha: o.linha,
      casa: o.casa, opcao: o.opcao, odd: r2(o.odd_casa), justa: r2(o.fair_odd),
      edge_pct: r2(o.edge_pct), inicio: (o.starts_at || '').slice(0, 16),
    }));
    secoes.push(`value_bets_ativas_top10: ${JSON.stringify(vals)}`);
  } catch { secoes.push('value_bets_ativas: indisponível'); }
  try {
    const mids = (await getMiddlesAtivos(6)).map((m: any) => ({
      evento: m.evento, mercado: m.mercado,
      over: `${m.over_casa} +${m.over_linha} @${r2(m.over_odd)}`,
      under: `${m.under_casa} -${m.under_linha} @${r2(m.under_odd)}`,
      pior_caso_roi_pct: r2(m.pior_caso_roi_pct),
    }));
    secoes.push(`middles_ativos_top6: ${JSON.stringify(mids)}`);
  } catch { secoes.push('middles_ativos: indisponível'); }

  // Calibração do alerta (30 dias)
  try {
    const c = await getResumoCalibracao(30);
    secoes.push(`calibracao_alerta_30d: ${JSON.stringify({
      taxa_sobrevivencia_pct: c.geral?.taxaSobrevivencia ?? null,
      drift_medio_pp: (c as any).driftMedioPp ?? null,
      enviados: c.geral?.enviados, suprimidos: c.geral?.suprimidos,
    })}`);
  } catch { secoes.push('calibracao_alerta: indisponível'); }

  return `===== CONTEXTO_APP (dados AO VIVO do JotinhaBet; use-os nas respostas) =====\n${secoes.join('\n')}\n===== FIM DO CONTEXTO_APP =====`;
}

/**
 * Retrato COMPACTO para o system prompt do AGENTE (IA/agent/agentLoop.ts).
 *
 * O CONTEXTO_APP completo custa ~2-3k tokens e é reenviado em TODA rodada do loop de
 * ferramentas — com o teto de tokens/minuto do free tier da Groq (8k-12k), ele sozinho
 * estourava o limite (HTTP 413). Aqui vão só os números que orientam a conversa
 * (banca, saldos, contagens, 3 melhores do radar); o detalhe o agente busca por skill
 * (surebets_no_radar, banca_e_saldos, historico_entradas, value_bets_e_middles).
 */
export async function montarContextoAgente(): Promise<string> {
  const partes: string[] = [];
  const agora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  partes.push(`agora: ${agora} (America/Sao_Paulo)`);

  try {
    partes.push(`banca_ativa: R$ ${(await bancaParaAlertas()).toFixed(2)}`);
  } catch { partes.push('banca_ativa: indisponível'); }

  try {
    const { data } = await supabase.from('app_config').select('valor').eq('chave', 'saldos_casas').maybeSingle();
    const saldos = data?.valor ? JSON.parse(data.valor) : [];
    const comSaldo = (Array.isArray(saldos) ? saldos : [])
      .filter((s: any) => num(s.valor) && Number(s.valor) > 0)
      .map((s: any) => `${s.casa || s.nome}:${r2(s.valor)}`);
    partes.push(`saldos_por_casa: ${comSaldo.length ? comSaldo.join(', ') : 'nenhum declarado'}`);
  } catch { partes.push('saldos_por_casa: indisponível'); }

  try {
    const { data } = await supabase
      .from('oportunidades')
      .select('evento, esporte, mercado, casa_a_nome, casa_b_nome, roi_pct')
      .eq('status', 'detectada')
      .order('roi_pct', { ascending: false })
      .limit(3);
    const top = (data || []).map((o: any) => `${o.evento} (${o.esporte}) ${o.casa_a_nome}×${o.casa_b_nome} ROI ${r2(o.roi_pct)}%`);
    partes.push(`radar_top3: ${top.length ? top.join(' | ') : 'vazio'}`);
  } catch { partes.push('radar_top3: indisponível'); }

  return `===== CONTEXTO (dados ao vivo; use skills para o detalhe) =====\n${partes.join('\n')}\n=====`;
}

/** Protocolo de ação anexado ao system prompt do chat. */
export const PROTOCOLO_ACAO_COPILOT = `
FERRAMENTA DISPONÍVEL — criar_oportunidade:
Quando (e SOMENTE quando) o usuário pedir EXPLICITAMENTE para lançar/criar/registrar uma oportunidade de surebet no radar, termine a resposta com um único bloco:
\`\`\`json
{"acao":"criar_oportunidade","evento":"Time A x Time B","esporte":"Futebol","mercado":"Resultado Final","linha":null,"opcaoA":"Casa vence","opcaoB":"Empate ou Fora","oddA":2.20,"oddB":1.95,"casaA":"Betano","casaB":"KTO","dataHora":"28/07/2026 21:00"}
\`\`\`
Regras da ferramenta:
- Use apenas odds ditas pelo usuário ou presentes no CONTEXTO_APP. NUNCA invente odd, casa ou evento.
- Campos obrigatórios: evento, esporte, mercado, opcaoA, opcaoB, oddA, oddB, casaA, casaB. linha e dataHora ("DD/MM/AAAA HH:MM", horário de Brasília) são opcionais (use null se desconhecidos). Se faltar obrigatório, PERGUNTE em vez de emitir o bloco.
- O par precisa ser arbitragem: 1/oddA + 1/oddB < 1. Se não fechar surebet, explique o cálculo e NÃO emita o bloco.
- Depois do bloco não escreva mais nada. O sistema aplica os gates de risco, dedup e revalidação ao vivo — informe ao usuário que o resultado da criação aparecerá em seguida.`;

export interface AcaoCriarOportunidade {
  evento: string; esporte: string; mercado: string;
  linha: number | null;
  opcaoA: string; opcaoB: string;
  oddA: number; oddB: number;
  casaA: string; casaB: string;
  dataHora: string | null;
}

/**
 * Procura o bloco de ação na resposta do modelo. Retorna null se não houver;
 * { erro } se houver bloco mas inválido (o chat devolve o erro ao usuário).
 */
export function extrairAcaoCopilot(reply: string): { dados?: AcaoCriarOportunidade; erro?: string; replySemBloco: string } | null {
  const m = reply.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return null;
  const replySemBloco = reply.replace(m[0], '').trim();
  let obj: any;
  try { obj = JSON.parse(m[1]); } catch { return { erro: 'bloco de ação com JSON inválido', replySemBloco }; }
  if (obj?.acao !== 'criar_oportunidade') return null;

  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const evento = str(obj.evento), esporte = str(obj.esporte), mercado = str(obj.mercado);
  const opcaoA = str(obj.opcaoA), opcaoB = str(obj.opcaoB), casaA = str(obj.casaA), casaB = str(obj.casaB);
  const oddA = Number(obj.oddA), oddB = Number(obj.oddB);
  const faltando = [
    !evento && 'evento', !esporte && 'esporte', !mercado && 'mercado',
    !opcaoA && 'opcaoA', !opcaoB && 'opcaoB', !casaA && 'casaA', !casaB && 'casaB',
    !(oddA > 1) && 'oddA', !(oddB > 1) && 'oddB',
  ].filter(Boolean);
  if (faltando.length) return { erro: `campos ausentes/inválidos: ${faltando.join(', ')}`, replySemBloco };

  const linha = obj.linha == null ? null : Number(obj.linha);
  if (linha !== null && !Number.isFinite(linha)) return { erro: 'linha inválida', replySemBloco };
  let dataHora: string | null = null;
  if (obj.dataHora != null && String(obj.dataHora).trim()) {
    const dh = String(obj.dataHora).trim();
    if (!/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}$/.test(dh)) return { erro: 'dataHora deve ser "DD/MM/AAAA HH:MM" ou null', replySemBloco };
    dataHora = dh;
  }

  return {
    dados: { evento: evento!, esporte: esporte!, mercado: mercado!, linha, opcaoA: opcaoA!, opcaoB: opcaoB!, oddA, oddB, casaA: casaA!, casaB: casaB!, dataHora },
    replySemBloco,
  };
}

/** Executa a criação via SignalPipeline (mesmos gates/dedup/revalidação do Telegram). */
export async function executarCriarOportunidade(dados: AcaoCriarOportunidade, pipeline: SignalPipeline): Promise<ResultadoPipeline> {
  const sinal: SinalExtraido = {
    eh_sinal: true,
    confianca: 100, // dados estruturados vindos do chat (não há incerteza de OCR)
    evento: dados.evento,
    esporte: dados.esporte,
    mercado: dados.mercado,
    linha: dados.linha,
    opcaoA: dados.opcaoA,
    opcaoB: dados.opcaoB,
    oddA: dados.oddA,
    oddB: dados.oddB,
    casaA: dados.casaA,
    casaB: dados.casaB,
    dataHora: dados.dataHora,
  };
  return pipeline.processarSinal(sinal, { fonte: 'copiloto' });
}

/** Texto amigável do desfecho da criação, anexado à resposta do chat. */
export function resumirResultadoCriacao(r: ResultadoPipeline): string {
  switch (r.acao) {
    case 'alertada':
      return '✅ Oportunidade criada no radar e ALERTA enviado no WhatsApp — as odds foram revalidadas ao vivo nas casas e a surebet segue de pé.';
    case 'alertada_nao_revalidada':
      return '✅ Oportunidade criada no radar e alerta enviado com tag ⚠️ (casa sem scraper — confira as odds manualmente antes de apostar).';
    case 'inserida_sem_alerta':
      return `✅ Oportunidade criada no radar (sem alerta no WhatsApp: ${r.motivo || 'gate de alerta não passou'}).`;
    case 'duplicada':
      return 'ℹ️ Essa oportunidade JÁ está ativa no radar — não criei duplicata.';
    case 'bloqueada_regras':
      return `🚫 Criação BLOQUEADA pelos gates de risco: ${r.motivo || 'regra do motor'}.`;
    case 'suprimida_revalidacao':
      return `🛡️ Criada, mas a revalidação ao vivo derrubou o alerta: ${r.motivo || 'odds mudaram'} — confira no radar antes de apostar.`;
    default:
      return `❌ Não consegui criar: ${r.motivo || 'erro'} (lembre: o par precisa fechar arbitragem, 1/oddA + 1/oddB < 1).`;
  }
}
