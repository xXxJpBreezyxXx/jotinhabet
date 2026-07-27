import { supabase } from '../db/client';

/**
 * Banca usada nos ALERTAS (stakes/lucro sugeridos no WhatsApp).
 *
 * Fonte da verdade: app_config['banca_ativa'] — a banca que o usuário salva no
 * painel (POST /api/banca, migration 008). Fallback (tabela ausente ou banca
 * nunca salva): o cálculo legado 50.00 + Σ lucro_real das operações, que era o
 * único critério do scanner/pipeline e SUBESTIMAVA a banca real (ex.: usuário
 * com R$ 222 no painel recebendo alertas dimensionados para ~R$ 59).
 */
export async function bancaParaAlertas(): Promise<number> {
  try {
    // .limit(1) em vez de .maybeSingle(): mesmo resultado no banco real e
    // compatível com os mocks de teste do supabase (que não têm maybeSingle).
    const { data } = await supabase
      .from('app_config')
      .select('valor')
      .eq('chave', 'banca_ativa')
      .limit(1);
    const v = Number((data as any[] | null)?.[0]?.valor);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* app_config pode não existir — segue pro legado */ }

  let banca = 50.0;
  try {
    const { data: operations } = await supabase.from('operacoes').select('lucro_real');
    if (operations && operations.length > 0) {
      banca = 50.0 + operations.reduce((s: number, op: any) => s + (Number(op.lucro_real) || 0), 0);
    }
  } catch (err) {
    console.error('⚠️ [Banca] Erro ao obter lucro acumulado para a banca dos alertas:', err);
  }
  return banca < 1.0 ? 50.0 : banca;
}
