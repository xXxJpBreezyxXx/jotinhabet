import { ArbitrageScannerV2 } from '../core/scanner_v2';

export class SchedulerService {
  private scanner = new ArbitrageScannerV2();
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Inicia o agendamento de varreduras periódicas.
   * @param intervalMinutes Intervalo em minutos (padrão 5)
   */
  start(intervalMinutes = 5) {
    if (this.intervalId) {
      console.log('ℹ️ [Scheduler] O agendador já está rodando.');
      return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    console.log(`🚀 [Scheduler] Iniciando agendador automático. Intervalo: ${intervalMinutes} minutos.`);
    
    // Executa a primeira vez de imediato
    this.executarJob();

    this.intervalId = setInterval(() => {
      this.executarJob();
    }, intervalMs);
  }

  /**
   * Para o agendamento corrente.
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 [Scheduler] Agendador parado com sucesso.');
    }
  }

  private async executarJob() {
    if (this.isRunning) {
      console.log('⚠️ [Scheduler] Ignorando varredura: a execução anterior ainda está ativa.');
      return;
    }

    this.isRunning = true;
    try {
      // Varredura API: SureRadar + cruzamento entre casas de API (KTO, Superbet, ...) —
      // rápida e sem Playwright, então pode rodar a cada ciclo. Dispara alertas de
      // ambas as fontes (SureRadar e motor próprio de alta confiança).
      console.log('⏰ [Scheduler] Executando varredura agendada (API + SureRadar)...');
      await this.scanner.executarVarredura(undefined, false, false, true);
    } catch (err) {
      console.error('❌ [Scheduler] Erro crítico no job de varredura:', err);
    } finally {
      this.isRunning = false;
    }
  }
}
