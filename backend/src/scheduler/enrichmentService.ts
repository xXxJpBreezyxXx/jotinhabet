import { supabase } from '../db/client';
import { RiskAnalyzer, RiskVerdict } from '../IA/riskAnalyzer';

/**
 * EnrichmentService — worker de enriquecimento assíncrono de risco por IA.
 *
 * Tira a IA do hot path de detecção: o scanner apenas persiste a oportunidade
 * (que nasce com ia_status='pendente' via DEFAULT da migration 005). Este worker
 * varre os pendentes em background, roda o RiskAnalyzer e grava o veredito
 * estruturado. É idempotente (pendente → processando → concluido/erro) e usa um
 * pool de concorrência limitado para não estourar o rate limit dos provedores.
 */
export class EnrichmentService {
  private analyzer = new RiskAnalyzer();
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  /** Quantas análises rodam em paralelo por vez. */
  private poolSize = 2;
  /** Máximo de oportunidades processadas por ciclo. */
  private batchSize = 15;
  /** Cache em memória por assinatura (evento+mercado+casas) para deduplicar (B6). */
  private cache = new Map<string, RiskVerdict>();

  start(intervalSeconds = 30) {
    if (this.intervalId) {
      console.log('ℹ️ [Enrichment] O worker já está rodando.');
      return;
    }
    console.log(`🧠 [Enrichment] Worker de enriquecimento iniciado. Ciclo: ${intervalSeconds}s.`);
    // Recupera linhas órfãs em 'processando' (processo caiu/reiniciou no meio) antes do 1º ciclo.
    void this.recuperarProcessando().then(() => this.processarPendentes());
    this.intervalId = setInterval(() => this.processarPendentes(), intervalSeconds * 1000);
  }

  /** Reseta para 'pendente' oportunidades presas em 'processando' (recuperação de crash/restart). */
  private async recuperarProcessando(): Promise<void> {
    try {
      const { error } = await supabase
        .from('oportunidades')
        .update({ ia_status: 'pendente' })
        .eq('ia_status', 'processando');
      if (error && !/column|schema cache/i.test(error.message || '')) {
        console.warn('⚠️ [Enrichment] Erro ao recuperar linhas em processando:', error.message);
      }
    } catch {
      /* silencioso: colunas de IA podem não existir ainda */
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 [Enrichment] Worker parado.');
    }
  }

  private chave(row: any): string {
    return [row.evento, row.mercado, row.casa_a_nome, row.casa_b_nome]
      .map((x) => (x || '').toString().trim().toLowerCase())
      .join('|');
  }

  /** Varre e enriquece um lote de oportunidades pendentes. Guarda de reentrância. */
  async processarPendentes(): Promise<number> {
    if (this.isRunning) {
      return 0;
    }
    this.isRunning = true;
    let processadas = 0;
    try {
      const { data: pendentes, error } = await supabase
        .from('oportunidades')
        .select('*')
        .eq('ia_status', 'pendente')
        .limit(this.batchSize);

      if (error) {
        console.error('⚠️ [Enrichment] Erro ao buscar pendentes:', error.message);
        return 0;
      }
      if (!pendentes || pendentes.length === 0) return 0;

      console.log(`🧠 [Enrichment] Enriquecendo ${pendentes.length} oportunidade(s)...`);
      for (let i = 0; i < pendentes.length; i += this.poolSize) {
        const slice = pendentes.slice(i, i + this.poolSize);
        const resultados = await Promise.all(slice.map((row) => this.enriquecerUma(row)));
        processadas += resultados.filter(Boolean).length;
      }
      console.log(`✅ [Enrichment] Ciclo concluído. ${processadas} enriquecida(s).`);
      return processadas;
    } catch (err: any) {
      console.error('❌ [Enrichment] Erro no ciclo de enriquecimento:', err?.message || err);
      return processadas;
    } finally {
      this.isRunning = false;
    }
  }

  /** Enriquece uma única linha. Retorna o veredito em sucesso, ou null em falha. */
  async enriquecerUma(row: any): Promise<RiskVerdict | null> {
    // Marca como 'processando' para evitar reprocesso por ciclos concorrentes.
    await supabase.from('oportunidades').update({ ia_status: 'processando' }).eq('id', row.id);

    try {
      const chave = this.chave(row);
      let veredito = this.cache.get(chave);
      if (!veredito) {
        veredito = await this.analyzer.analisar({
          evento: row.evento,
          mercado: row.mercado || 'Resultado Final',
          esporte: row.esporte,
          oddA: Number(row.odd_casa_1),
          oddB: Number(row.odd_casa_2),
          casaA: row.casa_a_nome || 'Casa A',
          casaB: row.casa_b_nome || 'Casa B',
          lucroGarantidoPerc: Number(row.roi_pct) || 0,
        });
        this.cache.set(chave, veredito);
        if (this.cache.size > 500) this.cache.clear();
      }

      const { error } = await supabase
        .from('oportunidades')
        .update({
          ia_status: 'concluido',
          ia_risco: veredito.nivel_risco,
          ia_veredito: veredito,
          ia_enriquecido_em: new Date().toISOString(),
        })
        .eq('id', row.id);

      if (error) {
        console.error(`⚠️ [Enrichment] Erro ao gravar veredito (${row.id}):`, error.message);
        await this.marcarErro(row.id);
        return null;
      }
      return veredito;
    } catch (err: any) {
      console.error(`❌ [Enrichment] Falha ao enriquecer ${row.id}:`, err?.message || err);
      await this.marcarErro(row.id);
      return null;
    }
  }

  /** Reenriquece uma oportunidade específica sob demanda (rota /enrich). */
  async enriquecerPorId(id: string): Promise<RiskVerdict | null> {
    const { data, error } = await supabase.from('oportunidades').select('*').eq('id', id).single();
    if (error || !data) return null;
    return this.enriquecerUma(data);
  }

  private async marcarErro(id: string) {
    try {
      await supabase.from('oportunidades').update({ ia_status: 'erro' }).eq('id', id);
    } catch {
      /* silencioso */
    }
  }
}
