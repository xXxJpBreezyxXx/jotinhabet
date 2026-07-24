// calibracaoRepo.ts
// Registro e agregação da calibração do ALERTA de surebet (tabela alerta_log, migration
// 016). Tolerante a falha: logar NUNCA pode derrubar o caminho de alerta — todas as
// funções capturam internamente.

import { supabase } from '../db/client';

export interface AlertaLogInput {
  fonte: string;                 // 'sureradar' | 'motor'
  esporte?: string;
  evento: string;
  mercado?: string;
  casaA?: string;
  casaB?: string;
  opcaoA?: string;
  opcaoB?: string;
  roiScan?: number | null;
  roiRevalidado?: number | null;
  oddA?: number | null;
  oddB?: number | null;
  confianca?: number | null;
  envolvePinnacle?: boolean;
  resultado: 'enviado' | 'suprimido' | 'nao_verificado';
  motivo?: string | null;
  startsAt?: string | null;
}

/** Registra uma decisão de alerta (fire-and-forget; erro só loga). */
export async function logAlerta(a: AlertaLogInput): Promise<void> {
  try {
    const { error } = await supabase.from('alerta_log').insert({
      fonte: a.fonte,
      esporte: a.esporte ?? null,
      evento: a.evento,
      mercado: a.mercado ?? null,
      casa_a: a.casaA ?? null,
      casa_b: a.casaB ?? null,
      opcao_a: a.opcaoA ?? null,
      opcao_b: a.opcaoB ?? null,
      roi_scan: a.roiScan ?? null,
      roi_revalidado: a.roiRevalidado ?? null,
      odd_a: a.oddA ?? null,
      odd_b: a.oddB ?? null,
      confianca: a.confianca ?? null,
      envolve_pinnacle: a.envolvePinnacle ?? null,
      resultado: a.resultado,
      motivo: a.motivo ?? null,
      starts_at: a.startsAt ?? null,
    });
    if (error) console.warn('[calibracao] logAlerta:', error.message);
  } catch (err: any) {
    console.error('[calibracao] logAlerta falhou:', err?.message || err);
  }
}

interface Faixa {
  enviados: number;
  suprimidos: number;
  naoVerificados: number;
  taxaSobrevivencia: number | null; // enviados / (enviados+suprimidos); null se base 0
}

function novaFaixa(): Faixa {
  return { enviados: 0, suprimidos: 0, naoVerificados: 0, taxaSobrevivencia: null };
}
function acumular(f: Faixa, resultado: string): void {
  if (resultado === 'enviado') f.enviados++;
  else if (resultado === 'suprimido') f.suprimidos++;
  else f.naoVerificados++;
}
function fecharFaixa(f: Faixa): Faixa {
  const base = f.enviados + f.suprimidos; // não_verificado (infra) fica de fora da precisão
  f.taxaSobrevivencia = base > 0 ? Number(((f.enviados / base) * 100).toFixed(1)) : null;
  return f;
}

export interface ResumoCalibracao {
  dias: number;
  total: number;
  geral: Faixa;
  driftMedioPp: number | null;    // média de (roi_revalidado - roi_scan) nos ENVIADOS, em pontos %
  porFonte: Record<string, Faixa>;
  comPinnacle: Faixa;
  semPinnacle: Faixa;
  atualizadoEm: string;
}

/** Agrega a precisão do alerta nos últimos `dias`. Cálculo em TS (volume modesto). */
export async function getResumoCalibracao(dias = 30): Promise<ResumoCalibracao> {
  const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const geral = novaFaixa();
  const comPinnacle = novaFaixa();
  const semPinnacle = novaFaixa();
  const porFonte: Record<string, Faixa> = {};
  let driftSoma = 0;
  let driftN = 0;

  try {
    const { data, error } = await supabase
      .from('alerta_log')
      .select('fonte, resultado, roi_scan, roi_revalidado, envolve_pinnacle, created_at')
      .gt('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) console.warn('[calibracao] getResumo:', error.message);

    for (const r of (data || []) as any[]) {
      acumular(geral, r.resultado);
      (r.envolve_pinnacle ? acumular(comPinnacle, r.resultado) : acumular(semPinnacle, r.resultado));
      const fonte = r.fonte || 'desconhecida';
      porFonte[fonte] = porFonte[fonte] || novaFaixa();
      acumular(porFonte[fonte], r.resultado);
      if (r.resultado === 'enviado' && r.roi_scan != null && r.roi_revalidado != null) {
        driftSoma += Number(r.roi_revalidado) - Number(r.roi_scan);
        driftN++;
      }
    }
  } catch (err: any) {
    console.error('[calibracao] getResumo falhou:', err?.message || err);
  }

  fecharFaixa(geral);
  fecharFaixa(comPinnacle);
  fecharFaixa(semPinnacle);
  for (const k of Object.keys(porFonte)) fecharFaixa(porFonte[k]);

  return {
    dias,
    total: geral.enviados + geral.suprimidos + geral.naoVerificados,
    geral,
    driftMedioPp: driftN > 0 ? Number((driftSoma / driftN).toFixed(2)) : null,
    porFonte,
    comPinnacle,
    semPinnacle,
    atualizadoEm: new Date().toISOString(),
  };
}

/** Últimos alertas registrados (p/ a lista da aba de calibração). */
export async function getAlertasRecentes(limit = 100): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from('alerta_log')
      .select('id, fonte, esporte, evento, mercado, casa_a, casa_b, roi_scan, roi_revalidado, confianca, envolve_pinnacle, resultado, motivo, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('[calibracao] getAlertasRecentes:', error.message);
      return [];
    }
    return data || [];
  } catch (err: any) {
    console.error('[calibracao] getAlertasRecentes falhou:', err?.message || err);
    return [];
  }
}
