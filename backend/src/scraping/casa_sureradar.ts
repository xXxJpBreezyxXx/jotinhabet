import { ArbitrageOpportunity } from '../arbitrage/engine';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export class SureRadarScraper {
  // Caminho dos cookies configurável por env (Docker/Linux). Default: sureradar.json na raiz do processo.
  private cookiesPath = process.env.SURERADAR_COOKIES_PATH || path.resolve(process.cwd(), 'sureradar.json');

  async extrairOportunidades(): Promise<ArbitrageOpportunity[]> {
    console.log(`🤖 [SureRadar] Iniciando extração de oportunidades via cookies...`);
    
    if (!fs.existsSync(this.cookiesPath)) {
      console.warn(`⚠️ [SureRadar] Arquivo de cookies não encontrado em ${this.cookiesPath}`);
      return [];
    }

    // --no-sandbox / --disable-dev-shm-usage: obrigatórios pra rodar Chromium como root em Docker.
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1400, height: 900 }
    });

    const opportunities: ArbitrageOpportunity[] = [];

    try {
      const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
      await context.addCookies(cookies);
      
      const page = await context.newPage();
      console.log(`   [SureRadar] Acessando painel: https://sureradar.site/app...`);
      await page.goto('https://sureradar.site/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      console.log(`   [SureRadar] Aguardando renderização do app (8s)...`);
      await page.waitForTimeout(8000);

      const cards = await page.evaluate(() => {
        const divs = Array.from(document.querySelectorAll('div.op'));
        return divs.map(el => {
          const sport = el.querySelector('.op-league span:last-child')?.textContent?.trim() || 'Futebol';
          const time = el.querySelector('.op-time')?.textContent?.trim() || 'Hoje';
          const evento = el.querySelector('.op-event')?.textContent?.trim() || 'Evento';
          const mercado = el.querySelector('.op-market')?.textContent?.trim() || 'Resultado Final';
          
          const boxes = Array.from(el.querySelectorAll('.op-box'));
          const oddsInfo = boxes.map(b => {
             return {
               label: b.querySelector('.op-box-label')?.textContent?.trim() || '',
               book: b.querySelector('.op-box-book span')?.textContent?.trim() || '',
               odd: parseFloat(b.querySelector('.op-box-odd')?.textContent?.trim() || '0')
             };
          });

          const roiText = el.querySelector('.op-return')?.textContent?.trim() || '0%';
          const roiMatch = roiText.match(/(\d+(?:\.\d+)?)%/);
          const roi = roiMatch ? parseFloat(roiMatch[1]) : 0;

          return { sport, time, evento, mercado, oddsInfo, roi };
        });
      });

      console.log(`   [SureRadar] Encontrados ${cards.length} cards na interface.`);

      for (const card of cards) {
        if (card.oddsInfo.length >= 2) {
          const boxA = card.oddsInfo[0];
          const boxB = card.oddsInfo[1];

          // Validação própria de break-even (regra.md) + sanidade de dados: o SureRadar
          // é fonte terceira, então não confiamos cegamente no ROI exibido. Descarta
          // odds inválidas (NaN/<=1) e pares que não formam surebet (soma de probabilidades >= 1).
          const oddsValidas =
            Number.isFinite(boxA.odd) && Number.isFinite(boxB.odd) && boxA.odd > 1 && boxB.odd > 1;
          const totalPerc = (1 / boxA.odd) + (1 / boxB.odd);
          if (!oddsValidas || totalPerc >= 1) {
            console.warn(
              `⚠️ [SureRadar] Card ignorado (falha no break-even): ${card.evento} | odds ${boxA.odd} / ${boxB.odd}`
            );
            continue;
          }

          const opp: ArbitrageOpportunity = {
            evento: `${card.evento} (${card.time})`,
            mercado: card.mercado,
            opcaoA: boxA.label,
            opcaoB: boxB.label,
            oddA: boxA.odd,
            oddB: boxB.odd,
            casaA: boxA.book,
            casaB: boxB.book,
            lucroGarantidoPerc: card.roi,
            oddCombinadaA: (1 / boxA.odd) / totalPerc,
            oddCombinadaB: (1 / boxB.odd) / totalPerc,
            totalPerc: parseFloat(totalPerc.toFixed(4)),
            esporte: card.sport,
            url: 'https://sureradar.site/app',
            analiseIA: `🟢 Oportunidade de Surebet importada diretamente do SureRadar com ROI garantido de ${card.roi}%.`
          };

          opportunities.push(opp);
        }
      }

    } catch (err: any) {
      console.error(`❌ [SureRadar] Erro no scraper:`, err.message);
    } finally {
      await browser.close();
    }

    return opportunities;
  }
}
