import { ArbitrageScannerV2 } from '../core/scanner_v2';
import { sureradarSync } from '../core/sureradarSync';

/**
 * Leitura LEVE do SureRadar, mais rápida que a varredura completa.
 *
 * Por que existe (medido em produção em 05/08/2026, com o monitor de sincronia): o painel
 * deles NÃO recalcula a cada 10 min como se supunha — recalcula a cada **~4,4 min e de forma
 * irregular** (intervalos observados: 261 s, 262 s, 342 s, e um vão de 534 s). Ou seja, a
 * cadência da fonte é MAIS CURTA que o nosso ciclo de 5 min, e perder recálculo passa a ser
 * matemático, não azar: uma varredura fechou com o dado deles já com 337 s e uma atualização
 * inteira passou em branco.
 *
 * Amostrar mais rápido que a fonte resolve o que alinhar fase não resolve (não há fase estável
 * num grid irregular). E é barato: a leitura do SureRadar leva ~1,2 s, contra ~2,5 min da
 * varredura completa, que gasta o tempo coletando 15+ casas para o motor próprio.
 *
 * O trabalho é o MESMO caminho `sureradarOnly` que o botão "Escanear (só SureRadar)" usa —
 * nada de rota nova:
 *  - reconciliação do SureRadar (mata linha que sumiu do painel deles) roda mais vezes;
 *  - reconciliação do MOTOR fica de fora (o scanner só a roda quando o cruzamento rodou —
 *    sem essa guarda, um tick leve apagaria as oportunidades do motor a cada 2 min);
 *  - alerta de WhatsApp só dispara em linha REALMENTE nova (o gate vive no ramo do INSERT),
 *    então ler mais vezes não vira spam.
 *
 * Não roda em cima da varredura completa: a trava global do scanner recusaria de todo modo, e
 * aqui o pulo é contado/logado. Com ciclo de 5 min ocupado ~2,5 min pela varredura completa e
 * tick de 2 min, sobra uma amostragem efetiva de ~2,5–3 min — abaixo do menor intervalo já
 * observado no painel deles (261 s), que é a condição para não perder recálculo.
 */
export class SureRadarLeveWorker {
  private scanner = new ArbitrageScannerV2();
  private timeoutId: NodeJS.Timeout | null = null;
  private intervalMs = 2 * 60 * 1000;
  private proximaMs = 0;
  private leituras = 0;
  private pulos = 0;
  private rodando = false;

  /** @param intervalMinutes minutos entre ticks (0/negativo = não inicia). */
  start(intervalMinutes = 2) {
    if (this.timeoutId) {
      console.log('ℹ️ [SureRadar/leve] O worker já está rodando.');
      return;
    }
    if (!(intervalMinutes > 0)) {
      console.log('ℹ️ [SureRadar/leve] Desligado (SURERADAR_LEVE_MIN=0) — só a varredura completa lê o painel.');
      return;
    }
    this.intervalMs = intervalMinutes * 60 * 1000;
    console.log(
      `📡 [SureRadar/leve] Iniciando leitura leve a cada ${intervalMinutes} min ` +
        '(a fonte recalcula a cada ~4,4 min: amostrar mais rápido que ela é o que evita perder recálculo).'
    );
    this.agendarProximo();
  }

  stop() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
      console.log('🛑 [SureRadar/leve] Worker parado.');
    }
  }

  /**
   * Agenda pela LINHA DO TEMPO (alvo anterior + intervalo), não por "fim do job + intervalo":
   * a leitura leva ~1,2 s, mas quando ela cai junto de outra coisa e demora, encadear pelo fim
   * empurraria o tick para sempre e o intervalo real viraria maior que o configurado.
   */
  private agendarProximo() {
    const base = this.proximaMs || Date.now();
    let alvo = base + this.intervalMs;
    // Se o processo ficou preso (event loop travado, tick perdido), não dispara em rajada:
    // pula os alvos vencidos e volta ao ritmo.
    const agora = Date.now();
    if (alvo <= agora) alvo = agora + this.intervalMs;
    this.proximaMs = alvo;
    sureradarSync.registrarAgendamentoLeve({ proximaMs: alvo, intervaloSeg: this.intervalMs / 1000 });
    this.timeoutId = setTimeout(() => {
      this.tick();
      this.agendarProximo();
    }, Math.max(1000, alvo - agora));
  }

  private async tick() {
    if (this.rodando) {
      // A leitura anterior ainda não voltou (rede lenta): não empilha.
      this.pulos++;
      return;
    }
    if (ArbitrageScannerV2.varreduraAtiva) {
      this.pulos++;
      console.log(`⏭️ [SureRadar/leve] Tick pulado: varredura em andamento (pulos: ${this.pulos}).`);
      return;
    }
    this.rodando = true;
    const t0 = Date.now();
    try {
      // sureradarOnly = true, apenasApi = true → só o painel deles, sem Playwright e sem motor.
      const ops = await this.scanner.executarVarredura(undefined, false, true, true);
      this.leituras++;
      const s = sureradarSync.snapshot();
      console.log(
        `📡 [SureRadar/leve] Leitura #${this.leituras} em ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
          `(${ops.length} nova(s)) · dado deles com ${s.deles.idadeSeg ?? '?'}s · estado ${s.sincronia.estado}` +
          ` · perdidas até agora: ${s.sincronia.atualizacoesPerdidas}`
      );
    } catch (err: any) {
      console.error('❌ [SureRadar/leve] Erro na leitura (não-fatal, próximo tick tenta de novo):', err?.message || err);
    } finally {
      this.rodando = false;
    }
  }
}
