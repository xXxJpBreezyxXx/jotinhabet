import { ScraperBase, ScrapedOdd } from './scraper_base';
import { chromium } from 'playwright';
import * as path from 'path';

export class KtoScraper extends ScraperBase {
  private urlBase = 'https://www.kto.bet.br/esportes';

  constructor() {
    super('KTO');
  }

  protected async inicializarNavegador(headless: boolean): Promise<void> {
    const userDir = path.resolve(__dirname, '../../tests/chrome-profile-kto-prod');
    this.context = await chromium.launchPersistentContext(userDir, {
      headless,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'pt-BR'
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  protected async extrairLinksDaLista(esporte: string, datas: string[]): Promise<string[]> {
    if (!this.context) throw new Error("Contexto não inicializado.");
    const page = this.context.pages()[0] || await this.context.newPage();
    
    console.log(`   [KTO] Acessando esportes na KTO...`);
    
    // Na KTO, a URL base de esportes geralmente carrega os principais jogos do dia
    await page.goto(this.urlBase, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    
    try {
      const cookieBtn = page.locator('text=Aceitar').first();
      if (await cookieBtn.isVisible({ timeout: 2000 })) {
        await cookieBtn.click();
      }
    } catch (_) {}
    
    // Clica no esporte desejado se estiver na barra lateral
    try {
      const btnMap: Record<string, string> = {
        'Futebol': 'Futebol',
        'Basquete': 'Basquete',
        'Tenis': 'Tênis',
        'Esports': 'E-Sports'
      };
      const textToClick = btnMap[esporte] || esporte;
      const sportLink = page.locator(`a:has-text("${textToClick}"), span:has-text("${textToClick}")`).first();
      
      if (await sportLink.isVisible({ timeout: 4000 })) {
        await sportLink.click();
        await page.waitForTimeout(4000);
      }
    } catch (_) {}

    const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a'));
        return anchors
            .map(a => a.href)
            .filter(href => {
                if (!href.includes('/esportes/')) return false;
                if (href.includes('/participant/') || href.includes('/in-play/')) return false;
                // Require last path segment to be a pure integer event ID (not e.g. "copa-2026")
                const lastSegment = href.split('?')[0].split('/').filter(Boolean).pop() || '';
                return /^\d{5,}$/.test(lastSegment); // ≥5 digits = event ID
            });
    });
    
    const uniqueLinks = [...new Set(links)];
    return uniqueLinks.slice(0, 5);
  }

  protected async extrairMercadosDoEvento(url: string, esporte: string): Promise<ScrapedOdd[]> {
    if (!this.context) return [];
    
    console.log(`   [KTO] Mergulhando no evento: ${url}`);
    const page = await this.context.newPage();
    const odds: ScrapedOdd[] = [];
    
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(6000); // Aumentado para aguardar carregamento completo
      
      const result = await page.evaluate(({ esporteArg, urlArg }) => {
          const rawOdds: any[] = [];
          
          let timeA = "Time A";
          let timeB = "Time B";
          try {
             const pathParts = urlArg.split('/');
             const matchSegment = pathParts[pathParts.length - 2] || '';
             const cleanSegment = matchSegment.split('?')[0];
             const teamsSplit = cleanSegment.split(/---+|--+/);
             if (teamsSplit.length === 2) {
                const cap = (s: string) => s.replace(/-/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                timeA = cap(teamsSplit[0]);
                timeB = cap(teamsSplit[1]);
             }
          } catch (_) {}
          
          if (timeA === "Time A" || timeB === "Time B") {
              const timeEls = Array.from(document.querySelectorAll('span, div')).filter(el => {
                  const txt = el.textContent?.trim() || '';
                  const cls = el.className || '';
                  return el.children.length === 0 && txt.length > 2 && txt.length < 30 && 
                         /^[A-ZÀ-Ú]/.test(txt) && !/\d/.test(txt) &&
                         (typeof cls === 'string' && (cls.includes('Participant') || cls.includes('Team') || cls.includes('Name') || cls.includes('competitor')));
              });
              if (timeEls.length > 0) timeA = timeEls[0].textContent?.trim() || timeA;
              if (timeEls.length > 1) timeB = timeEls[1].textContent?.trim() || timeB;
          }
          
          // Odds — aceitar 1-3 casas decimais e vírgula como separador
          const parseOddText = (txt: string): number => {
            const clean = txt.trim().replace(',', '.').replace(/\s+/g, '');
            const m = clean.match(/^(\d{1,4}\.\d{1,3})$/);
            return m ? parseFloat(m[1]) : 0;
          };
          
          const oddBtns = Array.from(document.querySelectorAll('button')).filter(b => {
              const txt = b.textContent?.trim() || '';
              const val = parseOddText(txt);
              return val > 1.01 && val < 200;
          });
          
          
          if (oddBtns.length >= 3 && esporteArg !== 'Esports') {
              rawOdds.push({
                  mercado: "Resultado Final",
                  opcaoA: timeA,
                  oddA: parseOddText(oddBtns[0].textContent?.trim() || '0'),
                  oddB: parseOddText(oddBtns[1].textContent?.trim() || '0'), 
                  oddC: parseOddText(oddBtns[2].textContent?.trim() || '0')  
              });
          } else if (oddBtns.length >= 2) {
              rawOdds.push({
                  mercado: "Resultado Final",
                  opcaoA: timeA,
                  oddA: parseOddText(oddBtns[0].textContent?.trim() || '0'),
                  oddB: parseOddText(oddBtns[1].textContent?.trim() || '0'),
                  oddC: 0
              });
          }
          
          return { timeA, timeB, rawOdds };
      }, { esporteArg: esporte, urlArg: url }) as { timeA: string, timeB: string, rawOdds: any[] };
      
      if (result.rawOdds.length > 0) {
          const evento = `${result.timeA} vs ${result.timeB}`;
          for (const raw of result.rawOdds) {
              if (raw.mercado === "Resultado Final") {
                  if (raw.oddC > 0) {
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
                  } else {
                    odds.push({
                        esporte, evento, dataHora: 'Hoje', url,
                        mercado: 'Resultado Final',
                        opcaoA: result.timeA,
                        opcaoB: result.timeB,
                        oddA: raw.oddA,
                        oddB: raw.oddB
                    });
                  }
              }
          }
      }
      
    } catch (err) {
      // Ignora erro timeout
    } finally {
      await page.close();
    }
    
    return odds;
  }
}
