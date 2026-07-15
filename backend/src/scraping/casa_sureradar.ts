import { ArbitrageOpportunity } from '../arbitrage/engine';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fetchTextoComRetry } from '../utils/http';

// ---------------------------------------------------------------------------
// Tipos da API interna do SureRadar (descobertos via engenharia do painel /app)
// GET https://sureradar.site/api/surebets → { surebets: [...], locked: [...], status, plano }
//  - `surebets`: oportunidades liberadas para o plano da conta (com deep-link das casas)
//  - `locked`:   oportunidades "VIP" — o site esconde na interface, mas a API entrega
//                TODOS os dados (evento, odds, casas, stakes); apenas `link` vem null.
//                São justamente as de maior ROI (12%+), então importamos também.
// ---------------------------------------------------------------------------

interface SureRadarLeg {
  outcome: string;
  desc: string;
  odd: number;
  bookmaker: string;
  bookmaker_label: string;
  bookmaker_type: string;
  stake_pct: number;
  stake_brl: number;
  link: string | null;
}

interface SureRadarSurebet {
  id: string;
  event: string;
  sport: string;        // ex: "Football", "Tennis", "Basketball", "Hockey", "Volleyball"
  sport_label: string;  // ex: "Futebol", "Tênis", "Basquete", "Hóquei", "Vôlei"
  market: string;
  market_label: string;
  line: string | null;
  profit_pct: number;
  commence_utc: string; // "2026-07-19T11:00:00Z"
  commence_br: string;  // "19/07/2026 08:00" (horário de Brasília)
  updated_at: string;
  legs: SureRadarLeg[];
}

interface SureRadarApiResponse {
  surebets: SureRadarSurebet[];
  locked?: SureRadarSurebet[];
  status?: { total: number; ultima_atualizacao: string; conectado: boolean };
  plano?: string;
}

/** Erro de autenticação: cookies rejeitados/expirados. O fallback via browser usa os
 *  MESMOS cookies e cairia na tela de login — ou seja, seria Chromium garantidamente
 *  inútil a cada scan. Por isso este erro curto-circuita o fallback. */
class SessaoInvalidaError extends Error {}

const SURERADAR_APP_URL = 'https://sureradar.site/app';
const SURERADAR_API_URL = 'https://sureradar.site/api/surebets?min_profit=0&max_profit=0&sports=';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export class SureRadarScraper {
  // Caminho dos cookies configurável por env (Docker/Linux). Default: sureradar.json na raiz do processo.
  private cookiesPath = process.env.SURERADAR_COOKIES_PATH || path.resolve(process.cwd(), 'sureradar.json');

  /**
   * Fonte que produziu o último resultado de extrairOportunidades():
   *  - 'api':     resposta autoritativa da API (inclui as VIP/locked; lista vazia é estado válido).
   *  - 'browser': fallback via DOM — fidelidade MENOR (não enxerga as VIP). Consumidores não
   *               devem reconciliar/deletar dados do banco com base nela.
   *  - 'none':    extração falhou (cookies ausentes/sessão inválida/erro nos dois caminhos).
   */
  public ultimaFonte: 'api' | 'browser' | 'none' = 'none';

  async extrairOportunidades(): Promise<ArbitrageOpportunity[]> {
    console.log(`🤖 [SureRadar] Iniciando extração de oportunidades via cookies...`);
    this.ultimaFonte = 'none';

    const cookies = this.carregarCookies();
    if (!cookies) return [];

    this.avisarSeSessaoPertoDeExpirar(cookies);

    // 1ª via: API JSON interna (rápida, completa e sem Chromium).
    try {
      const ops = await this.extrairViaApi(cookies);
      this.ultimaFonte = 'api';
      if (ops.length === 0) {
        // 200 + JSON válido + arrays vazios = "zero surebets agora" (comum de madrugada).
        // É resposta autoritativa: NÃO aciona o fallback (o painel é alimentado pela mesma API).
        console.log('   [SureRadar/API] 0 oportunidades no momento (resposta válida — sem fallback).');
      }
      return ops;
    } catch (err: any) {
      if (err instanceof SessaoInvalidaError) {
        console.error(`❌ [SureRadar] ${err.message}`);
        return [];
      }
      console.error(`❌ [SureRadar] Falha na API (${err.message}) — tentando fallback via browser...`);
    }

    // 2ª via (fallback): renderiza o painel com Playwright e raspa o DOM.
    const ops = await this.extrairViaBrowser(cookies);
    if (ops.length > 0) this.ultimaFonte = 'browser';
    return ops;
  }

  // -------------------------------------------------------------------------
  // Estratégia principal: chamada direta à API com o cookie de sessão.
  // -------------------------------------------------------------------------
  private async extrairViaApi(cookies: any[]): Promise<ArbitrageOpportunity[]> {
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const { status, contentType, urlFinal, body } = await fetchTextoComRetry(
      SURERADAR_API_URL,
      {
        headers: {
          Cookie: cookieHeader,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          Referer: SURERADAR_APP_URL,
        },
      },
      3,
      'SureRadar/API'
    );

    // 401 = sempre sessão inválida. 403 só é sessão se a resposta parecer vir do app
    // (JSON ou marcadores de login) — um 403+HTML de challenge de WAF/Cloudflare com
    // cookies VÁLIDOS deve cair no erro genérico (o browser pode passar no challenge).
    const pareceRespostaDoApp =
      (contentType.includes('json') || /\/(login|entrar|signin)/i.test(urlFinal) || /type=["']password["']/i.test(body));
    if (status === 401 || (status === 403 && pareceRespostaDoApp)) {
      throw new SessaoInvalidaError(
        `Sessão rejeitada (HTTP ${status}) — os cookies do sureradar.json expiraram. Refaça o login no site, exporte novos cookies para ${this.cookiesPath} e (no Docker) recrie o serviço. Fallback via browser NÃO será tentado: usaria os mesmos cookies.`
      );
    }
    if (status !== 200) {
      throw new Error(`HTTP ${status}`);
    }

    if (!contentType.includes('json')) {
      // HTML no lugar de JSON: ou redirect pra tela de login (sessão inválida) ou
      // challenge de WAF/proxy (aí o browser pode se sair melhor — erro genérico).
      const pareceLogin = /\/(login|entrar|signin)/i.test(urlFinal) || /type=["']password["']/i.test(body);
      if (pareceLogin) {
        throw new SessaoInvalidaError(
          `Redirecionado para a tela de login — sessão expirada. Refaça o login no site e exporte novos cookies para ${this.cookiesPath}. Fallback via browser NÃO será tentado: usaria os mesmos cookies.`
        );
      }
      throw new Error('resposta não-JSON (challenge de WAF/proxy ou endpoint mudou)');
    }

    let data: SureRadarApiResponse;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error('JSON inválido/truncado na resposta da API');
    }
    if (!Array.isArray(data.surebets)) {
      // Distingue "lista legitimamente vazia" (surebets: []) de "o schema da API mudou".
      throw new Error('schema inesperado (campo "surebets" não é um array — a API pode ter mudado)');
    }

    const liberadas = data.surebets;
    const vip = Array.isArray(data.locked) ? data.locked : [];

    console.log(
      `   [SureRadar/API] Plano "${data.plano || '?'}": ${liberadas.length} liberadas + ${vip.length} VIP visíveis` +
        (data.status?.total ? ` (sistema reporta ${data.status.total} no total)` : '')
    );

    const opportunities: ArbitrageOpportunity[] = [];
    for (const sb of liberadas) {
      const opp = this.converterSurebet(sb, false);
      if (opp) opportunities.push(opp);
    }
    for (const sb of vip) {
      const opp = this.converterSurebet(sb, true);
      if (opp) opportunities.push(opp);
    }

    const esportes = [...new Set(opportunities.map((o) => o.esporte))].join(', ');
    console.log(`   [SureRadar/API] ${opportunities.length} oportunidades extraídas (${esportes || 'nenhum esporte'}).`);
    return opportunities;
  }

  /**
   * Converte uma surebet da API para o formato interno, revalidando o break-even.
   * O SureRadar é fonte terceira: não confiamos cegamente no ROI exibido (regra.md) —
   * as odds são validadas localmente e o ROI derivado delas cobre profit_pct ausente/zerado.
   */
  private converterSurebet(sb: SureRadarSurebet, vip: boolean): ArbitrageOpportunity | null {
    if (!Array.isArray(sb.legs) || sb.legs.length !== 2) {
      console.warn(`⚠️ [SureRadar] Surebet ignorada (${sb.legs?.length || 0} pernas — engine suporta 2): ${sb.event}`);
      return null;
    }

    const [legA, legB] = sb.legs;
    const oddsValidas = Number.isFinite(legA.odd) && Number.isFinite(legB.odd) && legA.odd > 1 && legB.odd > 1;
    const totalPerc = 1 / legA.odd + 1 / legB.odd;
    if (!oddsValidas || totalPerc >= 1) {
      console.warn(`⚠️ [SureRadar] Surebet ignorada (falha no break-even): ${sb.event} | odds ${legA.odd} / ${legB.odd}`);
      return null;
    }

    // ROI: usa o do site quando é um número são; senão deriva das odds já validadas
    // ((1/totalPerc - 1) * 100 — mesma convenção do revalidationService p/ roi_pct).
    // Sem isso, um profit_pct null/0 da API suprimiria o alerta WhatsApp (gate ROI >= 5%).
    const roiDerivado = Number(((1 / totalPerc - 1) * 100).toFixed(2));
    const roi = Number.isFinite(sb.profit_pct) && sb.profit_pct > 0 ? sb.profit_pct : roiDerivado;

    // "(DD/MM/AAAA HH:MM)" no fim do evento — formato que o scanner usa para expirar/filtrar por data.
    const quando = this.formatarQuando(sb);

    const links = sb.legs
      .filter((l) => l.link)
      .map((l) => `${l.bookmaker_label}: ${l.link}`)
      .join(' | ');

    const analiseIA = vip
      ? `🔥 Surebet VIP do SureRadar (oculta na interface, extraída via API) com ROI garantido de ${roi}%. Sem link direto — busque o evento "${sb.event}" manualmente nas casas.`
      : `🟢 Oportunidade de Surebet importada diretamente do SureRadar com ROI garantido de ${roi}%.${links ? ` Links: ${links}` : ''}`;

    return {
      evento: `${sb.event} (${quando})`,
      mercado: sb.market_label || sb.market || 'Mercado',
      opcaoA: legA.desc || legA.outcome,
      opcaoB: legB.desc || legB.outcome,
      oddA: legA.odd,
      oddB: legB.odd,
      casaA: legA.bookmaker_label || legA.bookmaker,
      casaB: legB.bookmaker_label || legB.bookmaker,
      lucroGarantidoPerc: roi,
      oddCombinadaA: 1 / legA.odd / totalPerc,
      oddCombinadaB: 1 / legB.odd / totalPerc,
      totalPerc: parseFloat(totalPerc.toFixed(4)),
      esporte: sb.sport_label || sb.sport,
      url: SURERADAR_APP_URL,
      analiseIA,
    };
  }

  /**
   * Data/hora do evento no formato canônico "DD/MM/AAAA HH:MM" (Brasília).
   * Se commence_br faltar, deriva de commence_utc; só em último caso usa "Hoje"
   * (que sem HH:MM não é parseável pelo expirador do scanner — a linha sairia
   * apenas na limpeza de 24h).
   */
  private formatarQuando(sb: SureRadarSurebet): string {
    if (sb.commence_br) return sb.commence_br;
    if (sb.commence_utc) {
      const d = new Date(sb.commence_utc);
      if (!isNaN(d.getTime())) {
        return new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(d).replace(',', '');
      }
    }
    return 'Hoje';
  }

  // -------------------------------------------------------------------------
  // Fallback: renderização do painel com Playwright (estratégia antiga).
  // Só é acionado em falha de rede/5xx/schema da API — nunca em sessão inválida
  // (mesmos cookies) nem em lista vazia legítima (o painel usa a mesma API).
  // -------------------------------------------------------------------------
  private async extrairViaBrowser(cookies: any[]): Promise<ArbitrageOpportunity[]> {
    // --no-sandbox / --disable-dev-shm-usage: obrigatórios pra rodar Chromium como root em Docker.
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1400, height: 900 },
    });

    const opportunities: ArbitrageOpportunity[] = [];

    try {
      await context.addCookies(cookies);

      const page = await context.newPage();
      console.log(`   [SureRadar/Browser] Acessando painel: ${SURERADAR_APP_URL}...`);
      await page.goto(SURERADAR_APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Espera os cards (ou o estado vazio) aparecerem em vez de dormir 8s às cegas.
      await page.waitForSelector('div.op, .empty', { timeout: 20000 }).catch(() => {
        console.warn('⚠️ [SureRadar/Browser] Nenhum card renderizou em 20s.');
      });
      await page.waitForTimeout(1500);

      const cards = await page.evaluate(() => {
        const divs = Array.from(document.querySelectorAll('div.op'));
        return divs.map((el) => {
          const sport = el.querySelector('.op-league span:last-child')?.textContent?.trim() || 'Futebol';
          const time = el.querySelector('.op-time')?.textContent?.trim() || 'Hoje';
          const evento = el.querySelector('.op-event')?.textContent?.trim() || 'Evento';
          const mercado = el.querySelector('.op-market')?.textContent?.trim() || 'Resultado Final';

          const boxes = Array.from(el.querySelectorAll('.op-box'));
          const oddsInfo = boxes.map((b) => {
            return {
              label: b.querySelector('.op-box-label')?.textContent?.trim() || '',
              book: b.querySelector('.op-box-book span')?.textContent?.trim() || '',
              odd: parseFloat(b.querySelector('.op-box-odd')?.textContent?.trim() || '0'),
            };
          });

          const roiText = el.querySelector('.op-return')?.textContent?.trim() || '0%';
          const roiMatch = roiText.match(/(\d+(?:\.\d+)?)%/);
          const roi = roiMatch ? parseFloat(roiMatch[1]) : 0;

          return { sport, time, evento, mercado, oddsInfo, roi };
        });
      });

      console.log(`   [SureRadar/Browser] Encontrados ${cards.length} cards na interface.`);

      for (const card of cards) {
        if (card.oddsInfo.length >= 2) {
          const boxA = card.oddsInfo[0];
          const boxB = card.oddsInfo[1];

          // Validação própria de break-even (regra.md) + sanidade de dados.
          const oddsValidas =
            Number.isFinite(boxA.odd) && Number.isFinite(boxB.odd) && boxA.odd > 1 && boxB.odd > 1;
          const totalPerc = 1 / boxA.odd + 1 / boxB.odd;
          if (!oddsValidas || totalPerc >= 1) {
            console.warn(
              `⚠️ [SureRadar/Browser] Card ignorado (falha no break-even): ${card.evento} | odds ${boxA.odd} / ${boxB.odd}`
            );
            continue;
          }

          opportunities.push({
            // Normaliza o sufixo de tempo para o MESMO formato do caminho via API —
            // dedupe do banco, alertas e 'operacoes' comparam a string 'evento' exata.
            evento: `${card.evento} (${this.normalizarTempoPainel(card.time)})`,
            mercado: card.mercado,
            opcaoA: boxA.label,
            opcaoB: boxB.label,
            oddA: boxA.odd,
            oddB: boxB.odd,
            casaA: boxA.book,
            casaB: boxB.book,
            lucroGarantidoPerc: card.roi,
            oddCombinadaA: 1 / boxA.odd / totalPerc,
            oddCombinadaB: 1 / boxB.odd / totalPerc,
            totalPerc: parseFloat(totalPerc.toFixed(4)),
            esporte: card.sport,
            url: SURERADAR_APP_URL,
            analiseIA: `🟢 Oportunidade de Surebet importada diretamente do SureRadar com ROI garantido de ${card.roi}%.`,
          });
        }
      }
    } catch (err: any) {
      console.error(`❌ [SureRadar/Browser] Erro no scraper:`, err.message);
    } finally {
      await browser.close();
    }

    return opportunities;
  }

  /**
   * Converte o texto de tempo do painel ("Hoje 21:00", "Amanhã 13:00", "15/07 13:00")
   * para o formato canônico "DD/MM/AAAA HH:MM" usado pelo caminho via API.
   * Texto irreconhecível é mantido como veio (o scanner tem branches p/ "Hoje"/"Amanhã").
   */
  private normalizarTempoPainel(time: string): string {
    const t = (time || '').trim();
    if (/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(t)) return t;

    const dm = t.match(/^(\d{2})\/(\d{2})\s+(\d{2}:\d{2})$/);
    if (dm) {
      // Eventos são futuros: se DD/MM com o ano corrente cair >30 dias no passado,
      // é virada de ano (ex.: "01/01" visto em 31/12) → ano seguinte.
      let ano = new Date().getFullYear();
      const candidata = new Date(ano, parseInt(dm[2]) - 1, parseInt(dm[1]));
      if (Date.now() - candidata.getTime() > 30 * 24 * 60 * 60 * 1000) ano += 1;
      return `${dm[1]}/${dm[2]}/${ano} ${dm[3]}`;
    }

    const rel = t.match(/^(hoje|amanh[aã])\s*(\d{2}:\d{2})?$/i);
    if (rel) {
      const d = new Date();
      if (/amanh/i.test(rel[1])) d.setDate(d.getDate() + 1);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return `${dd}/${mm}/${d.getFullYear()} ${rel[2] || '00:00'}`;
    }

    return t;
  }

  // -------------------------------------------------------------------------
  // Utilitários de cookies
  // -------------------------------------------------------------------------
  private carregarCookies(): any[] | null {
    if (!fs.existsSync(this.cookiesPath)) {
      console.warn(`⚠️ [SureRadar] Arquivo de cookies não encontrado em ${this.cookiesPath}`);
      return null;
    }
    try {
      const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
      if (!Array.isArray(cookies) || cookies.length === 0) {
        console.warn(`⚠️ [SureRadar] Arquivo de cookies vazio ou em formato inesperado: ${this.cookiesPath}`);
        return null;
      }
      return cookies;
    } catch (err: any) {
      console.error(`❌ [SureRadar] Erro ao ler cookies (${this.cookiesPath}):`, err.message);
      return null;
    }
  }

  /** Alerta com antecedência quando o cookie de sessão estiver perto de expirar. */
  private avisarSeSessaoPertoDeExpirar(cookies: any[]): void {
    const sessao = cookies.find((c) => c.name === 'sr_session');
    const exp = sessao?.expires || sessao?.expirationDate;
    // Exports do Playwright/extensões usam expires: -1 para cookie de sessão (sem validade fixa).
    if (!exp || exp <= 0) return;
    const diasRestantes = (exp * 1000 - Date.now()) / (1000 * 60 * 60 * 24);
    if (diasRestantes <= 0) {
      console.error(`❌ [SureRadar] Cookie de sessão EXPIRADO. Refaça o login no site e exporte novos cookies para ${this.cookiesPath}.`);
    } else if (diasRestantes < 7) {
      console.warn(`⚠️ [SureRadar] Cookie de sessão expira em ${diasRestantes.toFixed(1)} dia(s). Renove os cookies em breve.`);
    }
  }
}
