import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function testSureRadar() {
  console.log('🤖 Testando acesso a SureRadar com cookies...');
  
  const cookiesPath = 'c:/Users/João Silva/jotinhabet/sureradar.json';
  if (!fs.existsSync(cookiesPath)) {
    console.error('❌ Arquivo de cookies sureradar.json não encontrado!');
    return;
  }
  
  const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
  const browser = await chromium.launch({ headless: true });
  
  // Cria contexto com os cookies injetados
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 }
  });
  
  await context.addCookies(cookies);
  const page = await context.newPage();
  
  try {
    console.log('🤖 Acessando https://sureradar.site/app ...');
    await page.goto('https://sureradar.site/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('🤖 Aguardando 10 segundos para renderização dos dados...');
    await page.waitForTimeout(10000);
    
    // Tira um screenshot para verificar se o login funcionou e ver o layout
    const screenshotPath = path.resolve(__dirname, 'sureradar_dashboard.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`✅ Screenshot salvo em: ${screenshotPath}`);
    
    // Extrai textos interessantes da página e a estrutura HTML dos cards de surebet
    const cardsHtml = await page.evaluate(() => {
      // Procura elementos que contêm o texto "% RETORNO CERTO"
      const divs = Array.from(document.querySelectorAll('div, section, article'));
      const surebetCards = divs.filter(el => {
        const text = el.textContent || '';
        return text.includes('RETORNO CERTO') && el.children.length > 2 && el.children.length < 15;
      });
      
      return surebetCards.slice(0, 3).map(el => ({
        tagName: el.tagName,
        className: el.className,
        id: el.id,
        innerHTML: el.innerHTML,
        innerText: el.textContent?.trim()
      }));
    });
    
    console.log('📦 Cards HTML extraídos:');
    console.log(JSON.stringify(cardsHtml, null, 2));
    
  } catch (err: any) {
    console.error('❌ Erro no acesso:', err.message);
  } finally {
    await browser.close();
  }
}

testSureRadar();
