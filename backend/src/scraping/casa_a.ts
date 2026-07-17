import { chromium } from 'playwright';
import { decrypt, encrypt } from '../auth/crypto';
import { supabase } from '../db/client';
import * as path from 'path';



import { ScraperBase, ScrapedOdd } from './scraper_base';

export class BetanoScraper extends ScraperBase {
  private urlBase = 'https://www.betano.bet.br';

  constructor() {
    super('Betano');
  }

  protected async inicializarNavegador(headless: boolean): Promise<void> {
    const userDir = path.resolve(__dirname, '../../tests/chrome-profile-betano-prod');
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

  private async resolverPopups(page: any): Promise<void> {
    try {
      await page.waitForSelector('button:has-text("SIM")', { state: 'visible', timeout: 5000 });
      const simButtons = page.locator('button:has-text("SIM")');
      const count = await simButtons.count();
      for (let i = 0; i < count; i++) {
        if (await simButtons.nth(i).isVisible()) {
          await simButtons.nth(i).click({ force: true });
          break;
        }
      }
      await page.waitForTimeout(1000);
    } catch (_) {}

    try {
      const cookieBtn = page.locator('button#onetrust-accept-btn-handler, button:has-text("SIM, EU ACEITO")');
      await cookieBtn.first().waitFor({ state: 'visible', timeout: 3000 });
      await cookieBtn.first().click({ force: true });
      await page.waitForTimeout(800);
    } catch (_) {}
  }

  protected async extrairLinksDaLista(esporte: string, datas: string[]): Promise<string[]> {
    if (!this.context) throw new Error("Contexto não inicializado.");
    const page = this.context.pages()[0] || await this.context.newPage();
    
    console.log(`   [Betano] Acessando esportes na Betano...`);
    const rotas: Record<string, string> = {
      'Futebol': 'sport/futebol/jogos-de-hoje/',
      'Esports': 'sport/esports/',
      'Basquete': 'sport/basquete/',
      'Tenis': 'sport/tenis/'
    };
    // Esporte sem rota mapeada (ex.: Volei/TenisDeMesa/Beisebol, cobertos só pelos
    // scrapers de API) → pula. O fallback antigo caía na rota de FUTEBOL e re-varria
    // futebol rotulado com o esporte errado.
    const rota = rotas[esporte];
    if (!rota) return [];

    await page.goto(`${this.urlBase}/${rota}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await this.resolverPopups(page);
    
    const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a'));
        return anchors
            .map(a => a.href)
            .filter(href => href.includes('/odds/')); // Links de jogos individuais
    });
    
    const uniqueLinks = [...new Set(links)];
    return uniqueLinks.slice(0, 5);
  }

  protected async extrairMercadosDoEvento(url: string, esporte: string): Promise<ScrapedOdd[]> {
    if (!this.context) return [];
    
    console.log(`   [Betano] Mergulhando no evento: ${url}`);
    const page = await this.context.newPage();
    const odds: ScrapedOdd[] = [];
    
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
      
      const result = await page.evaluate(({ esporteArg, urlArg }) => {
          const rawOdds: any[] = [];
          
          let timeA = "Time A";
          let timeB = "Time B";
          
          // ── Método 1: Parse da URL (mais confiável no Betano)
          // URL: /odds/argentina-suica/88703633/ ou /odds/operario-pr-gremio-novorizontino/88707489/
          try {
            const pathParts = urlArg.split('/');
            const slugIdx = pathParts.findIndex((p: string) => p === 'odds') + 1;
            const slug = pathParts[slugIdx] || '';
            const parts = slug.split('-').filter(Boolean);
            if (parts.length >= 2) {
              const mid = Math.ceil(parts.length / 2);
              const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
              timeA = parts.slice(0, mid).map(cap).join(' ');
              timeB = parts.slice(mid).map(cap).join(' ');
            }
          } catch (_) {}
          
          // ── Método 2: Seletores CSS (candidatos do Betano)
          if (timeA === "Time A" || timeB === "Time B") {
            const candidates = [
              '[class*="participant"]', '[class*="Participant"]',
              '[class*="team-name"]', '[class*="TeamName"]',
              '[class*="competitor"]', '[class*="Competitor"]',
              '[data-testid*="team"]'
            ];
            for (const sel of candidates) {
              const els = Array.from(document.querySelectorAll(sel)).filter(el => {
                const t = el.textContent?.trim() || '';
                return t.length > 2 && t.length < 40 && !/^\d/.test(t) && el.children.length === 0;
              });
              if (els.length >= 2) {
                timeA = els[0].textContent?.trim() || timeA;
                timeB = els[1].textContent?.trim() || timeB;
                break;
              }
            }
          }
          
          // ── Método 3: document.title (fallback com validação anti-promo)
          if (timeA === "Time A" || timeB === "Time B") {
            const pageTitle = document.title || '';
            const titleVsMatch = pageTitle.match(/^(.+?)\s+vs\.?\s+(.+?)\s*[\u2013|\-|]/);
            if (titleVsMatch && titleVsMatch[1] && titleVsMatch[2]) {
              const a = titleVsMatch[1].trim();
              const b = titleVsMatch[2].trim();
              // Rejeita nomes com letras totalmente maiúsculas (texto promocional)
              const isPromo = (s: string) => s === s.toUpperCase() && s.length > 5;
              if (!isPromo(a) && !isPromo(b) && a.length < 50 && b.length < 50) {
                timeA = a;
                timeB = b;
              }
            }
          }
          
          // ── Extração dos botões de odds (Betano usa button.selections__selection com .tw-font-bold dentro)
          const oddBtns = Array.from(document.querySelectorAll(
              'button.selections__selection, button[class*="selection"], button[class*="Selection"], [class*="selection-horizontal-button"]'
          )).filter(b => {
              const txt = b.querySelector('.tw-font-bold, [class*="font-bold"], [class*="odd-value"]')?.textContent?.trim()
                          || b.textContent?.trim().replace(/\s+/g, '') || '';
              return /^\d{1,3}[.,]\d{1,3}$/.test(txt);
          });
          
          const parseOdd = (el: Element): number => {
            const txt = el.querySelector('.tw-font-bold, [class*="font-bold"], [class*="odd-value"]')?.textContent?.trim()
                        || el.textContent?.trim().replace(/\s+/g, '') || '';
            const clean = txt.replace(',', '.');
            return parseFloat(clean.match(/^\d{1,3}\.\d{1,3}$/)?.[0] || '0');
          };
          
          if (oddBtns.length >= 3 && esporteArg !== 'Esports') {
              rawOdds.push({
                  mercado: "Resultado Final",
                  opcaoA: timeA,
                  oddA: parseOdd(oddBtns[0]),
                  oddB: parseOdd(oddBtns[1]),
                  oddC: parseOdd(oddBtns[2])
              });
          } else if (oddBtns.length >= 2) {
              rawOdds.push({
                  mercado: "Resultado Final",
                  opcaoA: timeA,
                  oddA: parseOdd(oddBtns[0]),
                  oddB: parseOdd(oddBtns[1]),
                  oddC: 0
              });
          }
          
          return { timeA, timeB, rawOdds };
      }, { esporteArg: esporte, urlArg: url });
      
      if (result.rawOdds.length > 0) {
          const evento = `${result.timeA} vs ${result.timeB}`;
          for (const raw of result.rawOdds) {
              if (raw.mercado === "Resultado Final") {
                  if (raw.oddC > 0) {
                    // Futebol 1X2 -> Result in double chance odds logic
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


export class SessionManager {
  private casaNome: string;
  private urlBase: string;

  constructor(casaNome: string = 'Betano', urlBase: string = 'https://br.betano.com') {
    this.casaNome = casaNome;
    this.urlBase = urlBase;
  }

  /**
   * Tenta validar se a sessão existente via cookies salvos ainda está ativa.
   */
  async validarSessao(cookiesCriptografados: string): Promise<boolean> {
    console.log(`🤖 [${this.casaNome}] Verificando validade da sessão existente...`);
    
    let cookiesRaw: any[];
    try {
      const decrypted = decrypt(cookiesCriptografados);
      cookiesRaw = JSON.parse(decrypted);
    } catch (err) {
      console.error(`❌ [${this.casaNome}] Falha ao descriptografar cookies:`, err);
      return false;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    
    try {
      await context.addCookies(cookiesRaw);
      const page = await context.newPage();
      await page.goto(this.urlBase, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      const logado = await Promise.race([
        page.waitForSelector('button:has-text("Depositar")', { timeout: 8000 }).then(() => true),
        page.waitForSelector('.user-balance', { timeout: 8000 }).then(() => true),
        page.waitForSelector('span:has-text("Minha Conta")', { timeout: 8000 }).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 9000))
      ]);

      await browser.close();
      return logado;
    } catch (error) {
      console.error(`❌ [${this.casaNome}] Erro durante validação de sessão:`, error);
      try { await browser.close(); } catch {}
      return false;
    }
  }

  /**
   * Executa o login automatizado.
   */
  async realizarLogin(contaId: string, loginCriptografado: string, senhaCriptografada: string, headless: boolean = false): Promise<boolean> {
    console.log(`🤖 [${this.casaNome}] Iniciando navegador para realizar login...`);
    
    let login = '';
    let senha = '';
    try {
      login = decrypt(loginCriptografado);
      senha = decrypt(senhaCriptografada);
    } catch (err) {
      console.error(`❌ [${this.casaNome}] Erro de criptografia nas credenciais:`, err);
      return false;
    }

    const browser = await chromium.launch({ 
      headless,
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    try {
      await page.goto(this.urlBase, { waitUntil: 'domcontentloaded', timeout: 45000 });
      console.log(`🤖 [${this.casaNome}] Página carregada. Tratando possíveis popups iniciais...`);

      await page.waitForTimeout(3000);

      // Tratamento rápido de modais iniciais
      try {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        
        // 1. Seletor de Idade
        const ageConfirmBtn = await page.$('div#age-verification-modal button, div#age-verification-modal [class*="btn"]');
        if (ageConfirmBtn) {
          await ageConfirmBtn.click({ force: true });
          await page.waitForTimeout(1000);
        }

        // 2. Cookies LGPD
        const acceptCookies = await page.$('button#onetrust-accept-btn-handler, button:has-text("Aceitar")');
        if (acceptCookies) {
          await acceptCookies.click({ force: true });
          await page.waitForTimeout(1000);
        }
      } catch (err) {}

      console.log(`🤖 [${this.casaNome}] Clicando no botão de login...`);

      try {
        const loginBtn = await page.waitForSelector('button:has-text("Iniciar sessão"), a:has-text("Iniciar sessão"), button:has-text("Entrar")', { timeout: 15000 });
        await loginBtn.click({ force: true });
        await page.waitForTimeout(2000);
      } catch (err) {
        console.log(`🤖 Botão de login não localizado de imediato, aguardando login manual...`);
      }

      console.log(`🤖 [${this.casaNome}] Tentando preencher credenciais se o formulário aparecer...`);
      
      try {
        const usernameInput = await page.waitForSelector('input[name="username"], input#username', { timeout: 6000 });
        await usernameInput.fill(login);
        
        const passwordInput = await page.waitForSelector('input[name="password"], input#password', { timeout: 6000 });
        await passwordInput.fill(senha);
        
        console.log(`🤖 [${this.casaNome}] Enviando formulário...`);
        const submitBtn = await page.waitForSelector('button[type="submit"], button:has-text("Entrar")', { timeout: 6000 });
        await submitBtn.click({ force: true });
      } catch (err) {
        console.log(`🤖 [${this.casaNome}] Campos de preenchimento automático ocultos ou não localizados.`);
        console.log(`🤖 Por favor, digite os dados e faça o login manualmente.`);
      }

      console.log(`\n🤖 [${this.casaNome}] Aguardando login ser concluído com sucesso...`);
      console.log(`🤖 IMPORTANTE: Faça o reconhecimento facial ou qualquer verificação de segurança no navegador.`);

      // Failsafe: Além de esperar pelos seletores, permitimos que o usuário pressione ENTER no terminal do processo
      const waitForEnter = new Promise<boolean>((resolve) => {
        console.log(`🤖  Pressione a tecla [ENTER] neste terminal quando estiver logado para salvar os cookies manualmente...`);
        process.stdin.once('data', () => {
          resolve(true);
        });
      });

      // Espera estar logado
      const loginSucesso = await Promise.race([
        page.waitForSelector('button:has-text("Depositar")', { timeout: 0 }).then(() => true),
        page.waitForSelector('.user-balance', { timeout: 0 }).then(() => true),
        page.waitForSelector('span:has-text("Minha Conta")', { timeout: 0 }).then(() => true),
        waitForEnter
      ]);

      console.log(`🤖 [${this.casaNome}] Login detectado com sucesso! Extraindo cookies...`);
      
      const cookies = await context.cookies();
      const cookiesStr = JSON.stringify(cookies);
      
      const cookiesCriptografados = encrypt(cookiesStr);

      const { error } = await supabase
        .from('contas')
        .update({
          cookies_criptografados: cookiesCriptografados,
          status: 'ativa',
          last_login_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', contaId);

      if (error) {
        console.error(`❌ [${this.casaNome}] Erro ao salvar cookies no Supabase:`, error);
        await browser.close();
        return false;
      }

      console.log(`🤖 [${this.casaNome}] Cookies de sessão salvos com sucesso!`);
      await page.waitForTimeout(3000);
      await browser.close();
      return true;

    } catch (error) {
      console.error(`❌ [${this.casaNome}] Erro no fluxo de login:`, error);
      try { await browser.close(); } catch {}
      return false;
    }
  }
}
