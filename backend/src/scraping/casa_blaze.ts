import { ScraperBase, ScrapedOdd } from './scraper_base';
import { chromium, Page } from 'playwright';
import { areEventsSame } from '../arbitrage/matcher';
import * as path from 'path';

// Rotas do Blaze por esporte. Compartilhado pela varredura e pela busca dirigida
// da revalidação. Esporte fora do mapa (coberto só pelos scrapers de API) → pula.
const ROTAS_BLAZE: Record<string, string> = {
  Futebol: 'futebol',
  Basquete: 'basquete',
  Tenis: 'tenis',
  Esports: 'esports',
};

export class BlazeScraper extends ScraperBase {
  private urlBase = 'https://blaze.bet.br/pt/sports';
  private apiOdds: ScrapedOdd[] = [];
  private listenerInstalado = false;

  constructor() {
    super('Blaze');
  }

  protected async inicializarNavegador(headless: boolean): Promise<void> {
    this.listenerInstalado = false; // contexto novo = página nova → re-instala o interceptador
    const userDir = path.resolve(__dirname, '../../tests/chrome-profile-blaze');
    const opts: any = {
      headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      permissions: ['geolocation'],
      geolocation: { latitude: -23.55052, longitude: -46.633308 },
      locale: 'pt-BR'
    };
    // Prod (container) só tem o chromium bundled (sem Google Chrome/channel) — tenta o
    // channel e cai no bundled; sem isso o launch lança e a casa fica inerte.
    try {
      this.context = await chromium.launchPersistentContext(userDir, { ...opts, channel: 'chrome' });
    } catch {
      this.context = await chromium.launchPersistentContext(userDir, opts);
    }

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  /**
   * Instala (uma vez por contexto) o interceptador das respostas da API Altenar
   * (sptpub) — preenche this.apiOdds com o mercado principal (Resultado Final) de cada
   * evento. Reusado pela varredura (extrairLinksDaLista) e pela revalidação (oddsDoEvento).
   */
  private instalarCapturaApi(page: Page): void {
    if (this.listenerInstalado) return;
    this.listenerInstalado = true;
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('sptpub.com') && (url.includes('/prematch/') || url.includes('/live/'))) {
            try {
                const json = await response.json();
                if (json.events) {
                    for (const eventId of Object.keys(json.events)) {
                        const ev = json.events[eventId];
                        const desc = ev.desc;
                        if (!desc || !desc.competitors || desc.competitors.length !== 2) continue;

                        const timeA = desc.competitors[0].name.trim();
                        const timeB = desc.competitors[1].name.trim();
                        const evento = `${timeA} vs ${timeB}`;

                        const sportId = desc.sportId || 1;
                        let esporteDetectado = 'Futebol';
                        if (sportId === 2) esporteDetectado = 'Basquete';
                        else if (sportId === 3) esporteDetectado = 'Tenis';
                        else if (sportId === 5) esporteDetectado = 'Esports';

                        const markets = ev.markets;
                        if (!markets) continue;

                        // Resultado Final (1X2 ou Vencedor do Jogo)
                        // Em Altenar, "1" éResultado Final / Match Winner
                        const m1 = markets["1"] || markets["15"];
                        if (m1 && m1[""]) {
                            const oddsOutcomes = m1[""];
                            const oddA = parseFloat(oddsOutcomes["1"]?.k);
                            const oddX = parseFloat(oddsOutcomes["2"]?.k);
                            const oddB = parseFloat(oddsOutcomes["3"]?.k);

                            const eventUrl = `blaze-event://${eventId}`;

                            if (oddA && oddB && oddX) {
                                // 3-way (Futebol com Empate)
                                // Vitória A vs (X2)
                                this.apiOdds.push({
                                    esporte: esporteDetectado,
                                    evento,
                                    dataHora: 'Hoje',
                                    url: eventUrl,
                                    mercado: 'Resultado Final',
                                    opcaoA: `Vitória ${timeA}`,
                                    opcaoB: `${timeB} ou Empate`,
                                    oddA,
                                    oddB: 1 / (1/oddX + 1/oddB)
                                });
                                // Vitória B vs (X1)
                                this.apiOdds.push({
                                    esporte: esporteDetectado,
                                    evento,
                                    dataHora: 'Hoje',
                                    url: eventUrl,
                                    mercado: 'Resultado Final',
                                    opcaoA: `Vitória ${timeB}`,
                                    opcaoB: `${timeA} ou Empate`,
                                    oddA: oddB,
                                    oddB: 1 / (1/oddX + 1/oddA)
                                });
                            } else if (oddA && oddX) {
                                // 2-way (Basquete/Tenis) - oddX é a cotação do Time B (Away)
                                this.apiOdds.push({
                                    esporte: esporteDetectado,
                                    evento,
                                    dataHora: 'Hoje',
                                    url: eventUrl,
                                    mercado: 'Resultado Final',
                                    opcaoA: timeA,
                                    opcaoB: timeB,
                                    oddA,
                                    oddB: oddX
                                });
                            }
                        }
                    }
                }
            } catch (_) {}
        }
    });
  }

  /** Navega para a lista de um esporte e aguarda a API Altenar preencher this.apiOdds. */
  private async carregarEsporte(page: Page, rota: string): Promise<void> {
    this.apiOdds = [];
    await page.goto(`${this.urlBase}/${rota}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(4000);

    // Cookies e idade
    try {
        await page.locator('button:has-text("ACEITAR")').first().click();
    } catch (_) {}
    try {
        await page.locator('button:has-text("mais de 18")').first().click();
    } catch (_) {}

    console.log('   [Blaze] Aguardando dados da API Altenar (12s)...');
    await page.waitForTimeout(12000);
  }

  protected async extrairLinksDaLista(esporte: string, datas: string[]): Promise<string[]> {
    if (!this.context) throw new Error("Contexto não inicializado.");
    const page = this.context.pages()[0] || await this.context.newPage();
    this.instalarCapturaApi(page);

    // Esporte sem rota mapeada (cobertos só pelos scrapers de API) → pula.
    const rota = ROTAS_BLAZE[esporte];
    if (!rota) return [];
    console.log(`   [Blaze] Acessando esportes na Blaze...`);
    await this.carregarEsporte(page, rota);

    // eventIds derivados das odds capturadas (dedupe por url), como antes limitado a 5.
    return [...new Set(this.apiOdds.map((o) => o.url!).filter(Boolean))].slice(0, 5);
  }

  protected async extrairMercadosDoEvento(url: string, esporte: string): Promise<ScrapedOdd[]> {
    // Retorna as odds já capturadas da API para este evento
    return this.apiOdds.filter(o => o.url === url);
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): re-abre o browser, navega o(s) esporte(s) e
   * filtra as odds capturadas da API (this.apiOdds) pelo confronto (areEventsSame). Todas
   * as odds do Blaze vêm da resposta da lista (não há página por evento), então basta
   * carregar a lista e filtrar. Custa uma abertura de browser; o memo de 60s do
   * RevalidationService dedup a.
   *
   * CONTRATO DE FALHA (igual à Betnacional): se o browser não abre ou o feed sptpub não
   * responde em NENHUM esporte (sempre há jogos prematch), LANÇA — o gate trata como
   * "falha ao re-buscar pernas" e re-gateia na próxima varredura, em vez de suprimir uma
   * arb válida. Só devolve [] quando o feed carregou mas o evento está genuinamente ausente.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const esportes = esporte && ROTAS_BLAZE[esporte] ? [esporte] : Object.keys(ROTAS_BLAZE);
    try {
      await this.inicializarNavegador(true);
      if (!this.context) throw new Error('Blaze: contexto não inicializado na revalidação');
      const page = this.context.pages()[0] || await this.context.newPage();
      this.instalarCapturaApi(page);
      let capturou = false;
      for (const esp of esportes) {
        const rota = ROTAS_BLAZE[esp];
        if (!rota) continue;
        try {
          await this.carregarEsporte(page, rota);
        } catch {
          continue; // falha só neste esporte; se todos falharem, cai no throw de infra
        }
        if (this.apiOdds.length) capturou = true;
        const doEvento = this.apiOdds.filter((o) => areEventsSame(o.evento, evento));
        if (doEvento.length) return doEvento;
      }
      if (!capturou) throw new Error('Blaze indisponível na revalidação (feed sptpub vazio — CF/cookies)');
      return []; // feed carregou; evento genuinamente ausente
    } finally {
      await this.fecharNavegador();
    }
  }
}
