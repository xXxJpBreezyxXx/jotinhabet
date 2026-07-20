// cashoutRepo.ts
// Acesso ao banco (Supabase) para o Radar Cashout. Todas as funções são tolerantes a
// falha: logam e seguem (o worker de captura NÃO pode cair por um erro de I/O).

import { supabase } from '../db/client';
import { CashoutSelection } from './cashoutEngine';

export interface BookmakerRow {
  id: string;
  name: string;
  bookmaker_type: 'compass' | 'target';
  avg_update_latency_seconds: number | null;
}

export interface EventUpsert {
  event_key: string;
  sport: string;
  league?: string | null;
  home_team: string;
  away_team: string;
  market: string;
  starts_at?: string | null;
}

export interface SnapshotRow {
  event_id: string;
  bookmaker_id: string;
  selection: CashoutSelection;
  line: number | null;
  odd_value: number;
  captured_at: string;
}

export interface OpportunityRow {
  signature: string;
  event_id: string;
  selection: CashoutSelection;
  line: number | null;
  target_bookmaker_id: string;
  fair_probability: number;
  target_odd_value: number;
  target_implied_prob: number;
  gap_pct: number;
  slope: number | null;
  r_squared: number | null;
  confirming_sources: string[];
  ttl_estimated_seconds: number | null;
  expires_at: string;
  // desnormalizados p/ o frontend
  event_label: string;
  sport: string;
  market_label: string;
  selection_label: string;
  target_name: string;
  compass_fair_odd: number;
  starts_at?: string | null;
}

/** Garante as linhas de bookmakers (bússola/alvo) e devolve name → row. */
export async function ensureBookmakers(
  compass: string[],
  targets: string[]
): Promise<Map<string, BookmakerRow>> {
  const map = new Map<string, BookmakerRow>();
  const rows = [
    ...compass.map((name) => ({ name, bookmaker_type: 'compass' as const })),
    ...targets.map((name) => ({ name, bookmaker_type: 'target' as const })),
  ];
  try {
    const { error } = await supabase
      .from('cashout_bookmakers')
      .upsert(rows, { onConflict: 'name', ignoreDuplicates: true });
    if (error) console.warn('[cashout] upsert bookmakers:', error.message);

    const { data, error: e2 } = await supabase
      .from('cashout_bookmakers')
      .select('id, name, bookmaker_type, avg_update_latency_seconds');
    if (e2) console.warn('[cashout] select bookmakers:', e2.message);
    for (const r of data || []) map.set(r.name, r as BookmakerRow);
  } catch (err: any) {
    console.error('[cashout] ensureBookmakers falhou:', err.message);
  }
  return map;
}

/** Upsert do evento (na chave natural event_key) e retorna o id. */
export async function upsertEvent(row: EventUpsert): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('cashout_events')
      .upsert(row, { onConflict: 'event_key' })
      .select('id')
      .maybeSingle();
    if (error) {
      console.warn('[cashout] upsertEvent:', error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (err: any) {
    console.error('[cashout] upsertEvent falhou:', err.message);
    return null;
  }
}

/** Insere snapshots de odds em lote (implied_prob é coluna gerada — não enviar). */
export async function insertSnapshots(rows: SnapshotRow[]): Promise<void> {
  if (!rows.length) return;
  try {
    const { error } = await supabase.from('cashout_odds_snapshots').insert(rows);
    if (error) console.warn('[cashout] insertSnapshots:', error.message);
  } catch (err: any) {
    console.error('[cashout] insertSnapshots falhou:', err.message);
  }
}

/** Upsert das oportunidades ativas na assinatura (refresca expires_at e os campos). */
export async function upsertOpportunities(rows: OpportunityRow[]): Promise<void> {
  if (!rows.length) return;
  try {
    const payload = rows.map((r) => ({ ...r, status: 'active' }));
    const { error } = await supabase
      .from('cashout_opportunities')
      .upsert(payload, { onConflict: 'signature' });
    if (error) console.warn('[cashout] upsertOpportunities:', error.message);
  } catch (err: any) {
    console.error('[cashout] upsertOpportunities falhou:', err.message);
  }
}

/** Expira as oportunidades ativas cujo expires_at já passou (deixaram de ser detectadas). */
export async function expireOldOpportunities(nowIso: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('cashout_opportunities')
      .update({ status: 'expired' })
      .eq('status', 'active')
      .lt('expires_at', nowIso);
    if (error) console.warn('[cashout] expireOldOpportunities:', error.message);
  } catch (err: any) {
    console.error('[cashout] expireOldOpportunities falhou:', err.message);
  }
}

/** Oportunidades ativas e ainda válidas, mais "gordas" primeiro — p/ a API. */
export async function getActiveOpportunities(): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from('cashout_opportunities')
      .select(
        'id, event_label, sport, market_label, selection_label, target_name, ' +
          'compass_fair_odd, target_odd_value, gap_pct, confirming_sources, ' +
          'ttl_estimated_seconds, r_squared, detected_at, expires_at, starts_at'
      )
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('gap_pct', { ascending: false })
      .limit(100);
    if (error) {
      console.warn('[cashout] getActiveOpportunities:', error.message);
      return [];
    }
    return data || [];
  } catch (err: any) {
    console.error('[cashout] getActiveOpportunities falhou:', err.message);
    return [];
  }
}

/**
 * Oportunidades RECENTES (ativas + as que expiraram há pouco), p/ o frontend não
 * ficar vazio quando uma oportunidade transitória some. `ativa` = ainda vale agora.
 */
export async function getRecentOpportunities(janelaMin = 1440): Promise<any[]> {
  const agora = Date.now();
  const nowIso = new Date(agora).toISOString();
  const cutoff = new Date(agora - janelaMin * 60_000).toISOString();
  try {
    const { data, error } = await supabase
      .from('cashout_opportunities')
      .select(
        'id, event_label, sport, market_label, selection_label, target_name, ' +
          'compass_fair_odd, target_odd_value, gap_pct, confirming_sources, ' +
          'ttl_estimated_seconds, r_squared, status, detected_at, expires_at, starts_at'
      )
      .or(`detected_at.gt.${cutoff},and(status.eq.active,expires_at.gt.${nowIso})`)
      .order('detected_at', { ascending: false })
      .limit(80);
    if (error) {
      console.warn('[cashout] getRecentOpportunities:', error.message);
      return [];
    }
    return (data || []).map((o: any) => ({
      ...o,
      ativa: o.status === 'active' && new Date(o.expires_at).getTime() > agora,
    }));
  } catch (err: any) {
    console.error('[cashout] getRecentOpportunities falhou:', err.message);
    return [];
  }
}

/** Uma oportunidade pelo id (campos necessários p/ o "Verificar"). */
export async function getOpportunityById(id: string): Promise<any | null> {
  try {
    const { data, error } = await supabase
      .from('cashout_opportunities')
      .select('id, event_id, target_bookmaker_id, selection, line, target_odd_value, ' +
        'fair_probability, compass_fair_odd, event_label, sport, selection_label, market_label, target_name')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.warn('[cashout] getOpportunityById:', error.message);
      return null;
    }
    return data ?? null;
  } catch (err: any) {
    console.error('[cashout] getOpportunityById falhou:', err.message);
    return null;
  }
}

/** Odd MAIS RECENTE capturada de uma casa p/ uma seleção (usado no "Verificar"). */
export async function getLatestTargetOdd(
  eventId: string,
  bookmakerId: string,
  selection: string,
  line: number | null
): Promise<{ odd_value: number; captured_at: string } | null> {
  try {
    let q = supabase
      .from('cashout_odds_snapshots')
      .select('odd_value, captured_at')
      .eq('event_id', eventId)
      .eq('bookmaker_id', bookmakerId)
      .eq('selection', selection);
    q = line === null || line === undefined ? q.is('line', null) : q.eq('line', line);
    const { data, error } = await q.order('captured_at', { ascending: false }).limit(1).maybeSingle();
    if (error) {
      console.warn('[cashout] getLatestTargetOdd:', error.message);
      return null;
    }
    return data ?? null;
  } catch (err: any) {
    console.error('[cashout] getLatestTargetOdd falhou:', err.message);
    return null;
  }
}
