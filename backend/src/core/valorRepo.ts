// valorRepo.ts
// Persistência das apostas de VALOR (+EV) — tabela valor_oportunidades (migration 014),
// ISOLADA das surebets. Todas as funções são tolerantes a falha (logam e seguem): o
// value bets é radar-only e NUNCA pode derrubar a varredura de arbitragem.

import { supabase } from '../db/client';
import { OportunidadeValor, Middle } from '../arbitrage/valor';
import { normalizarMercado } from '../arbitrage/markets';
import { parseKickoff } from '../arbitrage/matcher';

const norm = (s: any) =>
  (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
/** Rótulo do evento sem o sufixo de data "(DD/MM ...)" no fim. */
const eventoBase = (ev: string) => (ev || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

/** Assinatura estável (dedupe/refresh): evento base + mercado canônico + linha + casa + opção. */
export function assinaturaValor(o: OportunidadeValor): string {
  return [
    norm(eventoBase(o.evento)),
    normalizarMercado(o.mercado),
    o.linha ?? '∅',
    norm(o.casa),
    norm(o.opcao),
  ].join('||');
}

/** Mapeia a oportunidade de valor para a linha da tabela (colunas da migration 014). */
function paraRow(o: OportunidadeValor, agoraIso: string) {
  const t = parseKickoff(o.dataHora);
  return {
    signature: assinaturaValor(o),
    esporte: o.esporte ?? null,
    evento: o.evento,
    mercado: o.mercado,
    mercado_canon: normalizarMercado(o.mercado),
    linha: o.linha ?? null,
    casa: o.casa,
    opcao: o.opcao,
    odd_casa: o.oddCasa,
    fair_odd: o.fairOdd,
    prob_real: o.probReal,
    edge_pct: o.edgePct,
    referencia: o.referencia,
    odd_ref_a: o.oddRefA ?? null,
    odd_ref_b: o.oddRefB ?? null,
    confianca: o.confianca ?? null,
    starts_at: t === null ? null : new Date(t).toISOString(),
    status: 'ativa',
    visto_em: agoraIso,
    // detected_at NÃO vai no payload de propósito: no INSERT cai no default now(); no
    // UPDATE (conflito de signature) fica intocado — preserva a 1ª detecção.
  };
}

/**
 * Upsert das oportunidades de valor na assinatura (refresca visto_em e os campos).
 * Deduplica dentro do lote (o upsert do PostgREST rejeita 2 linhas com a mesma signature).
 */
export async function upsertValorOportunidades(ops: OportunidadeValor[], agoraIso: string): Promise<void> {
  if (!ops.length) return;
  const porAssinatura = new Map<string, OportunidadeValor>();
  for (const o of ops) {
    const k = assinaturaValor(o);
    const prev = porAssinatura.get(k);
    if (!prev || o.edgePct > prev.edgePct) porAssinatura.set(k, o); // mantém o maior edge
  }
  const payload = [...porAssinatura.values()].map((o) => paraRow(o, agoraIso));
  try {
    const { error } = await supabase
      .from('valor_oportunidades')
      .upsert(payload, { onConflict: 'signature' });
    if (error) console.warn('[valor] upsert:', error.message);
  } catch (err: any) {
    console.error('[valor] upsert falhou:', err.message);
  }
}

/**
 * Expira as oportunidades 'ativa' que NÃO foram re-detectadas nesta varredura (visto_em
 * anterior ao início do ciclo). O chamador só deve invocar quando a casa de referência
 * (Pinnacle) esteve presente — senão uma falha transitória dela expiraria tudo.
 */
export async function expirarValorAntigas(cutoffIso: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('valor_oportunidades')
      .update({ status: 'expirada' })
      .eq('status', 'ativa')
      .lt('visto_em', cutoffIso);
    if (error) console.warn('[valor] expirar:', error.message);
  } catch (err: any) {
    console.error('[valor] expirar falhou:', err.message);
  }
}

/** Oportunidades de valor ATIVAS, maior edge primeiro — p/ a API/radar. */
export async function getValorAtivas(limit = 100): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from('valor_oportunidades')
      .select(
        'id, esporte, evento, mercado, linha, casa, opcao, odd_casa, fair_odd, ' +
          'prob_real, edge_pct, referencia, confianca, starts_at, detected_at'
      )
      .eq('status', 'ativa')
      .order('edge_pct', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('[valor] getAtivas:', error.message);
      return [];
    }
    return data || [];
  } catch (err: any) {
    console.error('[valor] getAtivas falhou:', err.message);
    return [];
  }
}

/** Soft-delete (lixeira) de uma oportunidade de valor. */
export async function deleteValor(id: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('valor_oportunidades')
      .update({ status: 'deleted' })
      .eq('id', id);
    if (error) {
      console.warn('[valor] delete:', error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[valor] delete falhou:', err.message);
    return false;
  }
}

// ============================================================================
// MIDDLES — tabela middle_oportunidades (migration 015). Mesma disciplina do valor.
// ============================================================================

/** Assinatura estável de um middle: evento base + casa/linha de cada perna. */
export function assinaturaMiddle(m: Middle): string {
  return [
    norm(eventoBase(m.evento)),
    norm(m.overCasa),
    m.overLinha,
    norm(m.underCasa),
    m.underLinha,
  ].join('||');
}

function middleParaRow(m: Middle, agoraIso: string) {
  const t = parseKickoff(m.dataHora);
  return {
    signature: assinaturaMiddle(m),
    esporte: m.esporte ?? null,
    evento: m.evento,
    mercado: m.mercado,
    mercado_canon: normalizarMercado(m.mercado),
    over_casa: m.overCasa,
    over_odd: m.overOdd,
    over_linha: m.overLinha,
    under_casa: m.underCasa,
    under_odd: m.underOdd,
    under_linha: m.underLinha,
    largura: m.largura,
    pior_caso_roi_pct: m.piorCasoRoiPct,
    starts_at: t === null ? null : new Date(t).toISOString(),
    status: 'ativa',
    visto_em: agoraIso,
  };
}

/** Upsert dos middles na assinatura (refresca visto_em). Deduplica no lote. */
export async function upsertMiddles(ms: Middle[], agoraIso: string): Promise<void> {
  if (!ms.length) return;
  const porAssinatura = new Map<string, Middle>();
  for (const m of ms) {
    const k = assinaturaMiddle(m);
    const prev = porAssinatura.get(k);
    if (!prev || m.piorCasoRoiPct > prev.piorCasoRoiPct) porAssinatura.set(k, m);
  }
  const payload = [...porAssinatura.values()].map((m) => middleParaRow(m, agoraIso));
  try {
    const { error } = await supabase
      .from('middle_oportunidades')
      .upsert(payload, { onConflict: 'signature' });
    if (error) console.warn('[middle] upsert:', error.message);
  } catch (err: any) {
    console.error('[middle] upsert falhou:', err.message);
  }
}

/** Expira middles 'ativa' não re-detectados nesta varredura (visto_em < início do ciclo). */
export async function expirarMiddlesAntigos(cutoffIso: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('middle_oportunidades')
      .update({ status: 'expirada' })
      .eq('status', 'ativa')
      .lt('visto_em', cutoffIso);
    if (error) console.warn('[middle] expirar:', error.message);
  } catch (err: any) {
    console.error('[middle] expirar falhou:', err.message);
  }
}

/** Middles ATIVOS, melhor pior-caso primeiro — p/ a API/radar. */
export async function getMiddlesAtivos(limit = 100): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from('middle_oportunidades')
      .select(
        'id, esporte, evento, mercado, over_casa, over_odd, over_linha, ' +
          'under_casa, under_odd, under_linha, largura, pior_caso_roi_pct, starts_at, detected_at'
      )
      .eq('status', 'ativa')
      .order('pior_caso_roi_pct', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('[middle] getAtivos:', error.message);
      return [];
    }
    return data || [];
  } catch (err: any) {
    console.error('[middle] getAtivos falhou:', err.message);
    return [];
  }
}

/** Soft-delete (lixeira) de um middle. */
export async function deleteMiddle(id: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('middle_oportunidades')
      .update({ status: 'deleted' })
      .eq('id', id);
    if (error) {
      console.warn('[middle] delete:', error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[middle] delete falhou:', err.message);
    return false;
  }
}
