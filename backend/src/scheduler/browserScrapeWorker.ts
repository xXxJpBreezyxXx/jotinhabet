import { OddsScraper } from '../scraping/scraper_base';
import { BetanoScraper } from '../scraping/casa_a';
import { BlazeScraper } from '../scraping/casa_blaze';
import { OneXBetScraper } from '../scraping/casa_1xbet';
import { setBrowserOdds } from '../scraping/browserOddsCache';

/**
 * Worker das casas de BROWSER (Betano/Blaze/1xBet). Roda os scrapers Playwright numa
 * cadência PRÓPRIA (mais lenta que o scan de API), SEQUENCIALMENTE (um chromium por vez —
 * pesado na VPS 1-core), e grava as odds no browserOddsCache. A varredura de API lê esse
 * cache, então essas casas entram no scan automático SEM Playwright inline no ciclo de 5min.
 *
 * DESLIGADO por padrão: só sobe se BROWSER_WORKER_ENABLED=true. Habilitar mexe no perfil
 * de carga da VPS (motivo de essas casas estarem fora do ciclo automático hoje) — ligar
 * observando o `load`. A revalidação pré-alerta cobre a defasagem do cache.
 */
export class BrowserScrapeWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private rodando = false;
  private scrapers: OddsScraper[] = [new BetanoScraper(), new BlazeScraper(), new OneXBetScraper()];
  // Betano/Blaze/1xBet cobrem estes (ver ROTAS_* nos scrapers); os que a casa não conhece são ignorados.
  private esportes = ['Futebol', 'Basquete', 'Tenis', 'Esports'];

  start(intervalMinutes = 20): void {
    if (this.intervalId) {
      console.log('ℹ️ [BrowserWorker] Já está rodando.');
      return;
    }
    console.log(
      `🌐 [BrowserWorker] Iniciando (cada ${intervalMinutes}min, sequencial): ${this.scrapers.map((s) => s.getNome()).join(', ')}`
    );
    void this.ciclo(); // primeira coleta imediata
    this.intervalId = setInterval(() => void this.ciclo(), intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 [BrowserWorker] Parado.');
    }
  }

  private async ciclo(): Promise<void> {
    if (this.rodando) {
      console.log('⚠️ [BrowserWorker] Ciclo anterior ainda ativo — pulando.');
      return;
    }
    this.rodando = true;
    try {
      for (const s of this.scrapers) {
        try {
          const odds = await s.executarCrawler(this.esportes, ['Hoje'], true);
          setBrowserOdds(s.getNome(), odds);
          console.log(`🌐 [BrowserWorker] ${s.getNome()}: ${odds.length} odds no cache.`);
        } catch (e: any) {
          console.error(`❌ [BrowserWorker] ${s.getNome()}: ${e?.message || e}`);
        }
      }
    } finally {
      this.rodando = false;
    }
  }
}
