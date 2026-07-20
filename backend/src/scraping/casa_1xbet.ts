import { ScraperBase, ScrapedOdd } from './scraper_base';
import { chromium } from 'playwright';
import { areEventsSame } from '../arbitrage/matcher';
import * as path from 'path';

// Esporte interno → rota do 1xBet. Compartilhado pela varredura e pela busca dirigida
// da revalidação. Esporte fora do mapa → pula (não cai em football rotulado errado).
const ROTAS_1XBET: Record<string, string> = {
  Futebol: 'line/football',
  Basquete: 'line/basketball',
  Tenis: 'line/tennis',
};

export class OneXBetScraper extends ScraperBase {
  private urlBase = 'https://1xbet.bet.br/pt/';

  constructor() {
    super('1xBet');
  }

  protected async inicializarNavegador(headless: boolean): Promise<void> {
    const userDir = path.resolve(__dirname, '../../tests/chrome-profile-1xbet');
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

  protected async extrairLinksDaLista(esporte: string, datas: string[]): Promise<string[]> {
    if (!this.context) throw new Error("Contexto não inicializado.");
    const page = this.context.pages()[0] || await this.context.newPage();

    // Esporte sem rota mapeada → pula. O fallback antigo caía em football e emitia
    // odds de futebol ROTULADAS com o esporte errado (ex.: 'Volei').
    const rota = ROTAS_1XBET[esporte];
    if (!rota) return [];
    const targetUrl = `${this.urlBase}${rota}`;
    
    console.log(`   [1xBet] Acessando lista de ${esporte}: ${targetUrl}`);
    
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(8000);
      
      try {
          const cookieBtn = page.locator('text=Aceitar todos, text=ACEITAR TODOS').first();
          if (await cookieBtn.isVisible()) {
              await cookieBtn.click();
          }
      } catch (_) {}
      
      const links = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a')).map(a => a.href);
      });
      
      const uniqueLinks = [...new Set(links)];
      const sportNameSegment = rota.split('/')[1] || 'football';
      const filtered = uniqueLinks.filter(l => {
          const parts = l.split('/');
          return parts.length === 8 && l.includes(`/line/${sportNameSegment}/`) && /^\d+-/.test(parts[7]);
      });
      
      return filtered.slice(0, 5);
    } catch (err: any) {
      console.log(`   [1xBet] Falha ao acessar 1xBet:`, err.message);
      return [];
    }
  }

  protected async extrairMercadosDoEvento(url: string, esporte: string): Promise<ScrapedOdd[]> {
    if (!this.context) return [];
    
    console.log(`   [1xBet] Mergulhando no evento: ${url.split('/').pop()}`);
    const page = await this.context.newPage();
    const odds: ScrapedOdd[] = [];
    
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(6000);
      
      const result = await page.evaluate(({ esporteArg, urlArg }) => {
          const rawOdds: any[] = [];
          
          const headerEls = Array.from(document.querySelectorAll('h1, h2, h3, [class*="team"], [class*="competitor"]'))
              .map(h => h.textContent?.trim())
              .filter(Boolean);
          
          let timeA = "Time A";
          let timeB = "Time B";
          
          if (headerEls.length >= 3) {
              timeA = headerEls[1] || timeA;
              timeB = headerEls[2] || timeB;
          } else {
              const parts = urlArg.split('/');
              const lastPart = parts[parts.length - 1] || '';
              const match = lastPart.match(/^\d+-(.+)$/);
              if (match && match[1]) {
                  const teams = match[1].split('-');
                  if (teams.length >= 2) {
                      timeA = teams[0].charAt(0).toUpperCase() + teams[0].slice(1);
                      timeB = teams[1].charAt(0).toUpperCase() + teams[1].slice(1);
                  }
              }
          }
          
          const buttons = Array.from(document.querySelectorAll('button, .bet_type, [class*="bet-btn"], [class*="odd"]'))
              .map(b => b.textContent?.trim())
              .filter(Boolean);
          
          let valA = 0;
          let valX = 0;
          let valB = 0;
          
          for (const btnText of buttons) {
              if (/^V1\d+[\.,]\d+$/.test(btnText)) {
                  valA = parseFloat(btnText.replace('V1', '').replace(',', '.'));
              } else if (/^X\d+[\.,]\d+$/.test(btnText)) {
                  valX = parseFloat(btnText.replace('X', '').replace(',', '.'));
              } else if (/^V2\d+[\.,]\d+$/.test(btnText)) {
                  valB = parseFloat(btnText.replace('V2', '').replace(',', '.'));
              }
          }
          
          if (valA > 1.0 && valB > 1.0 && valX > 1.0) {
              rawOdds.push({
                  mercado: "Resultado Final",
                  opcaoA: timeA,
                  oddA: valA,
                  oddB: valX,
                  oddC: valB
              });
          }
          
          return { timeA, timeB, rawOdds };
      }, { esporteArg: esporte, urlArg: url }) as { timeA: string, timeB: string, rawOdds: any[] };
      
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

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): re-abre o browser, lista os jogos do(s)
   * esporte(s), pré-filtra candidatos pelo slug do link (`.../{id}-time-a-time-b`) e abre
   * só esses, confirmando o confronto com areEventsSame. Mesmo contrato de falha da
   * Betnacional: throw quando NENHUMA lista carrega (infra → gate remove a linha e
   * re-gateia) vs [] quando o evento está genuinamente ausente.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const esportes = esporte && ROTAS_1XBET[esporte] ? [esporte] : Object.keys(ROTAS_1XBET);
    try {
      await this.inicializarNavegador(true);
      if (!this.context) throw new Error('1xBet: contexto não inicializado na revalidação');
      const page = this.context.pages()[0] || await this.context.newPage();
      let listaCarregou = false;
      for (const esp of esportes) {
        const rota = ROTAS_1XBET[esp];
        if (!rota) continue;
        let links: string[] = [];
        try {
          await page.goto(`${this.urlBase}${rota}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
          await page.waitForTimeout(8000);
          try {
            const cookieBtn = page.locator('text=Aceitar todos, text=ACEITAR TODOS').first();
            if (await cookieBtn.isVisible()) await cookieBtn.click();
          } catch (_) {}
          const all = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map((a) => (a as HTMLAnchorElement).href)
          );
          const seg = rota.split('/')[1] || 'football';
          links = [...new Set(all)].filter((l) => {
            const parts = l.split('/');
            return parts.length === 8 && l.includes(`/line/${seg}/`) && /^\d+-/.test(parts[7]);
          });
        } catch {
          continue; // falha só neste esporte; se todos falharem, cai no throw de infra
        }
        if (links.length) listaCarregou = true;
        const candidatos = links.filter((u) => this.urlCasaComEvento(u, evento)).slice(0, 3);
        for (const url of candidatos) {
          const odds = await this.extrairMercadosDoEvento(url, esp);
          const confirmados = odds.filter((o) => areEventsSame(o.evento, evento));
          if (confirmados.length) return confirmados;
        }
      }
      if (!listaCarregou) throw new Error('1xBet indisponível na revalidação (nenhuma lista carregou)');
      return []; // lista carregou; evento genuinamente ausente
    } finally {
      await this.fecharNavegador();
    }
  }

  /**
   * Pré-filtro de candidato: os tokens dos dois times aparecem no slug do link
   * (`.../{id}-time-a-time-b`)? Comparação por CONJUNTO de tokens (≥3 chars, sem acento) —
   * independe da ordem; a confirmação final é do areEventsSame sobre o nome REAL extraído
   * da página do evento.
   */
  private urlCasaComEvento(url: string, evento: string): boolean {
    const seg = (url.split('/')[7] || '').replace(/^\d+-/, '');
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const slugTokens = new Set(norm(seg).split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
    const times = evento.split(/\s+vs\.?\s+/i);
    if (times.length !== 2) return false;
    const cobre = (time: string) => {
      const toks = norm(time).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
      if (!toks.length) return false;
      return toks.filter((t) => slugTokens.has(t)).length >= Math.ceil(toks.length / 2);
    };
    return cobre(times[0]) && cobre(times[1]);
  }
}
