import { ArbitrageScannerV2 } from '../core/scanner_v2';
import { sureradarSync, SYNC_ALVO_APOS_SEG, SYNC_FASE_HABILITADA } from '../core/sureradarSync';

export class SchedulerService {
  private scanner = new ArbitrageScannerV2();
  private timeoutId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private intervalMs = 5 * 60 * 1000;
  /** Instante planejado da PRÓXIMA varredura (a linha do tempo, não "agora + intervalo"). */
  private proximaMs = 0;

  /**
   * Inicia o agendamento de varreduras periódicas, alinhado à fase do SureRadar.
   *
   * Era `setInterval` fixo. Virou `setTimeout` reagendado porque intervalo fixo fixa também a
   * FASE: se a varredura cai 30s antes do recálculo do painel deles, ela cai 30s antes PARA
   * SEMPRE, e toda surebet importada nasce com a vida esgotada. O intervalo médio continua o
   * mesmo — o que muda é o instante dentro do ciclo deles, deslocado no máximo
   * ±35% do intervalo por ciclo (core/sureradarSync.ts decide o quanto).
   *
   * O agendamento segue independente da DURAÇÃO do job (como no setInterval): o alvo é
   * calculado sobre a linha do tempo e a trava `isRunning` continua sendo o que evita
   * varreduras concorrentes.
   *
   * @param intervalMinutes Intervalo em minutos (padrão 5)
   */
  start(intervalMinutes = 5) {
    if (this.timeoutId) {
      console.log('ℹ️ [Scheduler] O agendador já está rodando.');
      return;
    }

    this.intervalMs = intervalMinutes * 60 * 1000;
    console.log(
      `🚀 [Scheduler] Iniciando agendador automático. Intervalo: ${intervalMinutes} minutos` +
        (SYNC_FASE_HABILITADA
          ? ` · alinhamento de fase ATIVO (alvo: varrer ${SYNC_ALVO_APOS_SEG}s depois do recálculo do SureRadar).`
          : ' · alinhamento de fase DESLIGADO (SURERADAR_SYNC_FASE=0).')
    );

    // Executa a primeira vez de imediato
    this.executarJob();
    this.agendarProximo();
  }

  /**
   * Para o agendamento corrente.
   */
  stop() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
      console.log('🛑 [Scheduler] Agendador parado com sucesso.');
    }
  }

  /**
   * Marca a próxima varredura: intervalo + ajuste de fase do monitor de sincronia.
   *
   * O ajuste é clampado no monitor; aqui só se garante que o timer não fique negativo nem
   * absurdamente longo — cadência corrompida não pode virar "varre daqui a 3 horas".
   */
  private agendarProximo() {
    const ajusteSeg = sureradarSync.ajusteDeFaseSeg(Date.now() + this.intervalMs, this.intervalMs / 1000);
    const bruto = this.intervalMs + ajusteSeg * 1000;
    const delay = Math.min(this.intervalMs * 1.5, Math.max(30_000, bruto));
    this.proximaMs = Date.now() + delay;
    sureradarSync.registrarAgendamento({
      proximaMs: this.proximaMs,
      intervaloSeg: this.intervalMs / 1000,
      ajusteSeg,
    });
    if (ajusteSeg !== 0) {
      console.log(
        `🎯 [Scheduler] Fase ajustada em ${ajusteSeg > 0 ? '+' : ''}${ajusteSeg}s para cair ~${SYNC_ALVO_APOS_SEG}s ` +
          `depois do recálculo do SureRadar (próxima varredura em ${Math.round(delay / 1000)}s).`
      );
    }

    this.timeoutId = setTimeout(() => {
      this.executarJob();
      this.agendarProximo();
    }, delay);
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
