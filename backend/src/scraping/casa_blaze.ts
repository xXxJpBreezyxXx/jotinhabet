import { ScraperBase, ScrapedOdd } from './scraper_base';
import { chromium } from 'playwright';
import * as path from 'path';

export class BlazeScraper extends ScraperBase {
  private urlBase = 'https://blaze.bet.br/pt/sports';
  private apiOdds: ScrapedOdd[] = [];

  constructor() {
    super('Blaze');
  }

  protected async inicializarNavegador(headless: boolean): Promise<void> {
    const userDir = path.resolve(__dirname, '../../tests/chrome-profile-blaze');
    this.context = await chromium.launchPersistentContext(userDir, {
      headless,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      permissions: ['geolocation'],
      geolocation: { latitude: -23.55052, longitude: -46.633308 },
      locale: 'pt-BR'
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  protected async extrairLinksDaLista(esporte: string, datas: string[]): Promise<string[]> {
    if (!this.context) throw new Error("Contexto não inicializado.");
    const page = this.context.pages()[0] || await this.context.newPage();
    
    this.apiOdds = [];
    const eventIds: string[] = [];

    // Intercepta respostas da API Altenar
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
                            if (!eventIds.includes(eventUrl)) {
                                eventIds.push(eventUrl);
                            }
                            
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

    console.log(`   [Blaze] Acessando esportes na Blaze...`);
    const rotas: Record<string, string> = {
      'Futebol': 'futebol',
      'Basquete': 'basquete',
      'Tenis': 'tenis',
      'Esports': 'esports'
    };
    // Esporte sem rota mapeada (cobertos só pelos scrapers de API) → pula.
    const rota = rotas[esporte];
    if (!rota) return [];
    const targetUrl = `${this.urlBase}/${rota}`;
    
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
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
    
    return eventIds.slice(0, 5);
  }

  protected async extrairMercadosDoEvento(url: string, esporte: string): Promise<ScrapedOdd[]> {
    // Retorna as odds já capturadas da API para este evento
    return this.apiOdds.filter(o => o.url === url);
  }
}
