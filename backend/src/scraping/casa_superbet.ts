import { ScraperBase, ScrapedOdd } from './scraper_base';
import { chromium } from 'playwright';
import * as path from 'path';

export class SuperbetScraper extends ScraperBase {
  private urlBase = 'https://superbet.bet.br/';

  constructor() {
    super('Superbet');
  }

  protected async inicializarNavegador(headless: boolean): Promise<void> {
    const userDir = path.resolve(__dirname, '../../tests/chrome-profile-superbet');
    this.context = await chromium.launchPersistentContext(userDir, {
      headless,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  protected async extrairLinksDaLista(esporte: string, datas: string[]): Promise<string[]> {
    if (!this.context) throw new Error("Contexto não inicializado.");
    const page = this.context.pages()[0] || await this.context.newPage();
    
    const rotas: Record<string, string> = {
      'Futebol': 'apostas/futebol?day=hoje',
      'Basquete': 'apostas/basquete?day=hoje',
      'Tenis': 'apostas/tenis?day=hoje'
    };
    
    const rota = rotas[esporte] || 'apostas/futebol?day=hoje';
    const targetUrl = `${this.urlBase}${rota}`;
    
    console.log(`   [Superbet] Acessando lista de ${esporte}: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    
    const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a'));
        return anchors
            .map(a => a.href)
            .filter(href => href.includes('/odds/'));
    });
    
    const uniqueLinks = [...new Set(links)];
    return uniqueLinks.slice(0, 5);
  }

  protected async extrairMercadosDoEvento(url: string, esporte: string): Promise<ScrapedOdd[]> {
    if (!this.context) return [];
    
    console.log(`   [Superbet] Mergulhando no evento: ${url.split('/').pop()}`);
    const page = await this.context.newPage();
    const odds: ScrapedOdd[] = [];
    
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(4000);
      
      const result = await page.evaluate((esporteArg) => {
          const rawOdds: any[] = [];
          
          // Times no topo do evento
          const teamEls = Array.from(document.querySelectorAll('[class*="team-name"], [class*="competitor"], h1, h2')).map(el => el.textContent?.trim()).filter(Boolean);
          const timeA = teamEls[0] || "Time A";
          const timeB = teamEls[2] || teamEls[1] || "Time B";
          
          // Pegar botões de odds
          const oddBtns = Array.from(document.querySelectorAll('button')).filter(b => {
              const txt = b.textContent?.trim() || '';
              // Pode ser no formato "1.33" ou "X3.45" ou "25.55"
              const cleanTxt = txt.replace(/^[XCasaFora]/, '');
              return /^\d+\.\d{2}$/.test(cleanTxt) && parseFloat(cleanTxt) > 1.0;
          });
          
          if (oddBtns.length >= 3) {
              const valA = parseFloat(oddBtns[0].textContent?.trim().replace(/^[XCasaFora]/, '') || '0');
              const valB = parseFloat(oddBtns[1].textContent?.trim().replace(/^[XCasaFora]/, '') || '0');
              const valC = parseFloat(oddBtns[2].textContent?.trim().replace(/^[XCasaFora]/, '') || '0');
              
              rawOdds.push({
                  mercado: "Resultado Final",
                  opcaoA: timeA,
                  oddA: valA,
                  oddB: valB,
                  oddC: valC
              });
          }
          
          return { timeA, timeB, rawOdds };
      }, esporte);
      
      if (result.rawOdds.length > 0) {
          const evento = `${result.timeA} vs ${result.timeB}`;
          
          for (const raw of result.rawOdds) {
              if (raw.mercado === "Resultado Final") {
                  odds.push({
                      esporte, evento, dataHora: 'Hoje', url,
                      mercado: 'Resultado Final',
                      opcaoA: `Vitória ${result.timeA}`,
                      opcaoB: `${result.timeB} ou Empate`,
                      oddA: raw.oddA,
                      oddB: 1 / (1/raw.oddB + 1/raw.oddC)
                  });
                  odds.push({
                      esporte, evento, dataHora: 'Hoje', url,
                      mercado: 'Resultado Final',
                      opcaoA: `Vitória ${result.timeB}`,
                      opcaoB: `${result.timeA} ou Empate`,
                      oddA: raw.oddC,
                      oddB: 1 / (1/raw.oddB + 1/raw.oddA)
                  });
              }
          }
      }
      
    } catch (err) {
      // Ignora erro
    } finally {
      await page.close();
    }
    
    return odds;
  }
}
