import { chromium, Browser, BrowserContext } from 'playwright';
import { USER_AGENT_CHROME, GEO_SAO_PAULO, aplicarStealth } from '../browser_options';
import { fetchTextoComRetry } from '../../utils/http';
import {
  CasaAlvo,
  ReconReport,
  FeedCandidate,
  NivelAuth,
  Transporte,
} from './tipos';
import {
  CHAVES_DE_ODDS,
  classificarPlataforma,
  detectarBotProtection,
} from './platform_signatures';

interface CandidatoBruto {
  url: string;
  host: string;
  path: string;
  transporte: Transporte;
  status?: number;
  contentType?: string;
  method?: string;
  temAuthHeader: boolean;
  temCookieHeader: boolean;
  maxTamanho: number;
  ocorrencias: number;
  densidade: number;
  sample?: unknown;
}

/**
 * Sonda UMA casa: carrega a home de esportes num contexto stealth efêmero, captura
 * o tráfego JSON/WS, identifica o feed de odds, detecta anti-bot e testa o nível de
 * autenticação. Read-only — nunca faz login nem aposta.
 */
export class ReconProbe {
  private readonly esperaFeedMs = 12000;

  async probe(casa: CasaAlvo): Promise<ReconReport> {
    const timestamp = new Date().toISOString();
    const pesoCobertura = casa.pesoCobertura ?? 1;
    const base: ReconReport = {
      casa: casa.nome,
      dominio: casa.dominio,
      timestamp,
      ok: false,
      feedPrincipal: null,
      auth: 'desconhecido',
      botProtection: ['nenhum'],
      plataformaProvavel: 'desconhecida',
      confianca: 0,
      facilidadeScore: 0,
      pesoCobertura,
      scoreFinal: 0,
      websockets: [],
      candidatos: [],
      amostraJson: null,
    };

    let browser: Browser | null = null;
    try {
      browser = await this.lancarBrowser();
      const context = await browser.newContext({
        userAgent: USER_AGENT_CHROME,
        viewport: { width: 1280, height: 800 },
        permissions: ['geolocation'],
        geolocation: GEO_SAO_PAULO,
        locale: 'pt-BR',
      });
      await aplicarStealth(context);

      const page = await context.newPage();

      const candidatos = new Map<string, CandidatoBruto>();
      const websockets: string[] = [];
      const urlsJson: string[] = [];
      let docHeaders: Record<string, string> = {};

      // --- Handlers ANTES do goto (crítico) ---
      page.on('response', async (response) => {
        try {
          const req = response.request();
          const resourceType = req.resourceType();
          const url = response.url();
          const u = new URL(url);
          const contentType = response.headers()['content-type'] || '';

          if (resourceType === 'document') {
            docHeaders = response.headers();
          }

          const ehJson = contentType.includes('json') || /\.json(\?|$)/.test(u.pathname);
          if (!(resourceType === 'xhr' || resourceType === 'fetch') || !ehJson) return;

          let body = '';
          try {
            body = await response.text();
          } catch {
            return; // vários corpos não são recuperáveis (igual ao catch da Blaze)
          }

          urlsJson.push(url);
          const bodyLower = body.slice(0, 200000).toLowerCase();
          const densidade = CHAVES_DE_ODDS.filter((k) => bodyLower.includes('"' + k)).length;
          const key = `${u.host}${u.pathname.replace(/\/\d+/g, '/:id')}`;
          const reqHeaders = req.headers();

          const prev = candidatos.get(key);
          if (prev) {
            prev.ocorrencias += 1;
            if (body.length > prev.maxTamanho) {
              prev.maxTamanho = body.length;
              prev.densidade = densidade;
              prev.sample = this.parseSeguro(body);
            }
          } else {
            candidatos.set(key, {
              url,
              host: u.host,
              path: u.pathname,
              transporte: 'xhr',
              status: response.status(),
              contentType,
              method: req.method(),
              temAuthHeader: !!(reqHeaders['authorization'] || reqHeaders['x-api-key']),
              temCookieHeader: !!reqHeaders['cookie'],
              maxTamanho: body.length,
              ocorrencias: 1,
              densidade,
              sample: this.parseSeguro(body),
            });
          }
        } catch {
          /* ignora respostas problemáticas */
        }
      });

      page.on('websocket', (ws) => {
        const url = ws.url();
        if (url.startsWith('wss://') && !websockets.includes(url)) websockets.push(url);
      });

      page.on('requestfailed', (req) => {
        const f = req.failure();
        if (!f) return;
        const url = req.url();
        // Ignora ruído (analytics/ads/imagens/telemetria) — não é feed de odds.
        if (/google|doubleclick|analytics|gtm|\/collect|generate_204|\.(png|svg|jpe?g|gif|css|woff)|adform|contentexchange|facebook|hotjar|snippet\./i.test(url)) {
          return;
        }
        // Só reporta falha se parecer um feed (ajuda a diagnosticar bloqueio de API).
        if (/api|sport|feed|odds|prematch|\/live|graphql|offering|event/i.test(url)) {
          console.log(`   [recon:${casa.nome}] possível feed bloqueado: ${url.slice(0, 110)} (${f.errorText})`);
        }
      });

      // --- Navegar ---
      const alvo = casa.dominio + (casa.pathsPrematch[0] || '');
      console.log(`🔎 [recon:${casa.nome}] Acessando ${alvo} ...`);
      await page.goto(alvo, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch((e) => {
        console.log(`   [recon:${casa.nome}] goto aviso: ${e.message}`);
      });

      await this.aceitarPopups(page);
      console.log(`   [recon:${casa.nome}] Aguardando feed (${this.esperaFeedMs / 1000}s)...`);
      await page.waitForTimeout(this.esperaFeedMs);

      // --- Coleta de sinais anti-bot ---
      const cookies = (await context.cookies()).map((c) => c.name);
      let scripts: string[] = [];
      try {
        scripts = await page.$$eval('script[src]', (els) =>
          els.map((e) => e.getAttribute('src') || '')
        );
      } catch {
        /* página pode ter fechado */
      }
      const headerNames = Object.keys(docHeaders).map((h) => `${h}:${docHeaders[h]}`);

      // --- Ranquear candidatos ---
      const rankeados = Array.from(candidatos.values())
        .map((c) => ({ ...c, score: this.scoreCandidato(c) }))
        .sort((a, b) => b.score - a.score);

      const top = rankeados[0];
      const botProtection = detectarBotProtection(cookies, headerNames, scripts);
      const plat = classificarPlataforma([...urlsJson, ...websockets]);

      // --- Teste de auth (sem browser) no candidato top ---
      let auth: NivelAuth = 'desconhecido';
      if (top) {
        auth = await this.testarAuth(top, casa.dominio, context);
      } else if (websockets.length > 0) {
        auth = 'so_browser'; // feed empurrado por WS, sem XHR pollável
      }

      const facilidadeScore = this.facilidade(auth, top?.transporte || 'desconhecido', botProtection);

      base.ok = true;
      base.feedPrincipal = top
        ? { host: top.host, pathExemplo: top.path, transporte: top.transporte, tamanho: top.maxTamanho }
        : null;
      base.auth = auth;
      base.botProtection = botProtection;
      base.plataformaProvavel = plat.plataforma;
      base.confianca = plat.confianca;
      base.facilidadeScore = facilidadeScore;
      base.scoreFinal = facilidadeScore * pesoCobertura; // runner adiciona bônus de plataforma
      base.websockets = websockets;
      base.candidatos = rankeados.slice(0, 5).map((c) => this.toFeedCandidate(c));
      base.amostraJson = top ? this.resumirJson(top.sample) : null;

      await context.close();
      return base;
    } catch (err: any) {
      base.erro = err?.message || String(err);
      console.error(`❌ [recon:${casa.nome}] Falhou: ${base.erro}`);
      return base;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /** Tenta o canal Chrome (igual à produção); cai para o Chromium empacotado se não houver Chrome. */
  private async lancarBrowser(): Promise<Browser> {
    try {
      return await chromium.launch({
        headless: true,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch {
      return await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
      });
    }
  }

  private async aceitarPopups(page: import('playwright').Page): Promise<void> {
    const textos = ['ACEITAR', 'Aceitar', 'mais de 18', 'Concordo', 'Entendi', 'OK'];
    for (const t of textos) {
      try {
        await page.locator(`button:has-text("${t}")`).first().click({ timeout: 1500 });
      } catch {
        /* sem esse botão */
      }
    }
  }

  /** Re-executa o feed via fetch puro para classificar o nível de auth. */
  private async testarAuth(
    top: CandidatoBruto,
    dominio: string,
    context: BrowserContext
  ): Promise<NivelAuth> {
    if (top.transporte === 'ws') return 'so_browser';

    const headersBase = {
      'User-Agent': USER_AGENT_CHROME,
      Accept: 'application/json',
      Referer: dominio,
      Origin: dominio,
    };

    // Variante 1: SEM cookie
    try {
      const semCookie = await fetchTextoComRetry(top.url, { headers: headersBase }, 2, `recon-auth`);
      if (semCookie.status === 200 && semCookie.contentType.includes('json')) return 'publico';
    } catch {
      /* segue para a variante com cookie */
    }

    // Variante 2: COM cookie do contexto
    try {
      const cookieHeader = (await context.cookies())
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      const comCookie = await fetchTextoComRetry(
        top.url,
        { headers: { ...headersBase, Cookie: cookieHeader } },
        2,
        `recon-auth`
      );
      if (comCookie.status === 200 && comCookie.contentType.includes('json')) return 'precisa_cookie';
      if (comCookie.status === 401 || comCookie.status === 403) return 'precisa_token';
    } catch {
      /* cai para so_browser */
    }

    return 'so_browser';
  }

  private scoreCandidato(c: CandidatoBruto): number {
    const kb = c.maxTamanho / 1024;
    return kb * (1 + c.ocorrencias) * (1 + c.densidade);
  }

  private facilidade(auth: NivelAuth, transporte: Transporte, bot: string[]): number {
    let s = 0;
    s += auth === 'publico' ? 4 : auth === 'precisa_cookie' ? 3 : auth === 'precisa_token' ? 2 : auth === 'so_browser' ? 1 : 0;
    s += transporte === 'xhr' ? 2 : 0;
    s += bot.length === 1 && bot[0] === 'nenhum' ? 2 : -2;
    return s;
  }

  private parseSeguro(body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  /** Reduz o JSON a top-level keys + primeiro evento, para desenhar o parser depois. */
  private resumirJson(obj: unknown): unknown {
    if (!obj || typeof obj !== 'object') return obj;
    const o = obj as Record<string, unknown>;
    const resumo: Record<string, unknown> = { __topLevelKeys: Object.keys(o) };
    if (o.events && typeof o.events === 'object') {
      const primeiraKey = Object.keys(o.events as object)[0];
      if (primeiraKey) resumo.primeiroEvento = (o.events as Record<string, unknown>)[primeiraKey];
    } else {
      // Pega o primeiro filho array/objeto como amostra
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (Array.isArray(v) && v.length) {
          resumo.primeiroItem = { campo: k, valor: v[0] };
          break;
        }
      }
    }
    return resumo;
  }

  private toFeedCandidate(c: CandidatoBruto & { score: number }): FeedCandidate {
    return {
      host: c.host,
      path: c.path,
      url: c.url,
      transporte: c.transporte,
      status: c.status,
      contentType: c.contentType,
      method: c.method,
      temAuthHeader: c.temAuthHeader,
      temCookieHeader: c.temCookieHeader,
      tamanho: c.maxTamanho,
      ocorrencias: c.ocorrencias,
      densidade: c.densidade,
      score: c.score,
    };
  }
}
