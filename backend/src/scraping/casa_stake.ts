import { ScraperBase, ScrapedOdd } from './scraper_base';
import { chromium, Page, Browser } from 'playwright';
import { areEventsSame } from '../arbitrage/matcher';

/**
 * Stake (stake.bet.br) — plataforma própria. As odds vêm de uma API REST JSON
 * (`sbweb.stake.bet.br/api/v1/br/pt-br/events/{id}/odds`) que dá **403 no fetch direto**
 * (Cloudflare/fingerprint TLS, como a Betnacional) — só responde DENTRO do browser. Então
 * o scraper é browser-intercept (como o Blaze): navega o cupom, captura as respostas de
 * odds e parseia o mercado principal.
 *
 * Resultado Final (1X2 tempo integral) = marketId ESTÁVEL **1000316018** (confirmado no
 * recon em vários eventos), colunas fixas **columnId 0=mandante, 1=Empate, 2=visitante**;
 * os nomes dos times vêm dos próprios outcomes (a resposta não tem fixtures à parte).
 * v1: só Futebol (o 1X2 é específico de futebol; outros esportes → parse vazio, sem lixo).
 *
 * TRANSPORTE: o CF da Stake é COMPORTAMENTAL — o IP datacenter da VPS carrega no começo
 * mas passa a tomar 403 ("Attention Required") após acessos repetidos. Então roteia pelo
 * tsproxy (residencial BR, PINNACLE_PROXY=http://jotinhabet_tsproxy:1055) quando disponível
 * — mesmo túnel da Pinnacle; FRÁGIL se o celular cair da tailnet. Sem o proxy, tenta direto
 * (funciona esporádico). Se o feed não carrega, oddsDoEvento LANÇA (infra → re-gate).
 */
const ROTAS_STAKE: Record<string, string> = {
  Futebol: 'sports/soccer',
};
const MARKET_1X2 = '1000316018';
// Mesmo túnel Tailscale (celular exit node) usado pela Pinnacle — ver [[pinnacle-asn-bloqueio]].
const STAKE_PROXY = process.env.TSPROXY_URL || process.env.PINNACLE_PROXY || '';

export class StakeScraper extends ScraperBase {
  private urlBase = 'https://stake.bet.br/';
  private apiOdds: ScrapedOdd[] = [];
  private listenerInstalado = false;
  private esporteAtual = 'Futebol';
  private browserEfemero?: Browser;

  constructor() {
    super('Stake');
  }

  protected async inicializarNavegador(headless: boolean): Promise<void> {
    this.listenerInstalado = false;
    // Contexto EFÊMERO (não-persistente) de propósito: quando o CF desafia uma sessão, o
    // cookie de challenge fica PRESO num profile persistente e envenena as próximas runs
    // (visto no teste). Sessão nova a cada run mantém a revalidação confiável.
    const launchOpts: any = {
      headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
    };
    // Roteia pelo tsproxy (residencial BR) quando configurado — o CF da Stake bloqueia o
    // IP datacenter após acessos repetidos. Só resolve dentro do container (host da tailnet).
    if (STAKE_PROXY) launchOpts.proxy = { server: STAKE_PROXY };
    // Prod (container) só tem o chromium bundled; tenta o channel e cai no bundled.
    try {
      this.browserEfemero = await chromium.launch({ ...launchOpts, channel: 'chrome' });
    } catch {
      this.browserEfemero = await chromium.launch(launchOpts);
    }
    this.context = await this.browserEfemero.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      permissions: ['geolocation'],
      geolocation: { latitude: -23.55052, longitude: -46.633308 },
      locale: 'pt-BR',
    });
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  /** Fecha o contexto E o browser efêmero (senão vaza um chromium por revalidação). */
  protected async fecharNavegador(): Promise<void> {
    try {
      if (this.context) await this.context.close();
    } finally {
      if (this.browserEfemero) { await this.browserEfemero.close().catch(() => {}); this.browserEfemero = undefined; }
    }
  }

  private odd(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Converte as odds de UM lote (array da API) em ScrapedOdds de Resultado Final (1X2 → dupla chance). */
  private parse1x2(odds: any[]): ScrapedOdd[] {
    const porEvento = new Map<string, any[]>();
    for (const o of odds) {
      if (String(o.marketId) !== MARKET_1X2) continue;
      const eid = String(o.eventId);
      if (!porEvento.has(eid)) porEvento.set(eid, []);
      porEvento.get(eid)!.push(o);
    }
    const out: ScrapedOdd[] = [];
    for (const [eid, outs] of porEvento) {
      const home = outs.find((o) => o.columnId === 0);
      const draw = outs.find((o) => o.columnId === 1);
      const away = outs.find((o) => o.columnId === 2);
      if (!home || !draw || !away) continue;
      const oHome = this.odd(home.oddValue), oDraw = this.odd(draw.oddValue), oAway = this.odd(away.oddValue);
      // Suspensa/congelada vem com oddValue 0 (ou frozen) → descarta o evento.
      if (!(oHome > 1) || !(oDraw > 1) || !(oAway > 1)) continue;
      const timeA = String(home.name || '').trim();
      const timeB = String(away.name || '').trim();
      if (!timeA || !timeB) continue;
      const evento = `${timeA} vs ${timeB}`;
      const url = `stake-event://${eid}`;
      out.push({
        esporte: this.esporteAtual, evento, dataHora: 'Hoje', url, mercado: 'Resultado Final',
        opcaoA: `Vitória ${timeA}`, opcaoB: `${timeB} ou Empate`, oddA: oHome, oddB: 1 / (1 / oDraw + 1 / oAway),
      });
      out.push({
        esporte: this.esporteAtual, evento, dataHora: 'Hoje', url, mercado: 'Resultado Final',
        opcaoA: `Vitória ${timeB}`, opcaoB: `${timeA} ou Empate`, oddA: oAway, oddB: 1 / (1 / oDraw + 1 / oHome),
      });
    }
    return out;
  }

  /** Instala (uma vez por contexto) o interceptador das respostas de odds por evento. */
  private instalarCapturaApi(page: Page): void {
    if (this.listenerInstalado) return;
    this.listenerInstalado = true;
    page.on('response', async (response) => {
      try {
        if (!/\/events\/\d+\/odds/.test(response.url())) return;
        const j = await response.json().catch(() => null);
        if (!j || !Array.isArray(j.odds)) return;
        this.apiOdds.push(...this.parse1x2(j.odds));
      } catch (_) { /* ignora frame malformado */ }
    });
  }

  /** Navega para o cupom de um esporte e rola a página para disparar o fetch de odds dos eventos. */
  private async carregarEsporte(page: Page, rota: string): Promise<void> {
    this.apiOdds = [];
    await page.goto(`${this.urlBase}${rota}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(8000);
    // O cupom carrega odds sob demanda; rola para trazer mais eventos.
    for (let i = 0; i < 4; i++) {
      try { await page.mouse.wheel(0, 1400); } catch (_) {}
      await page.waitForTimeout(2500);
    }
  }

  protected async extrairLinksDaLista(esporte: string, _datas: string[]): Promise<string[]> {
    if (!this.context) throw new Error('Contexto não inicializado.');
    const rota = ROTAS_STAKE[esporte];
    if (!rota) return [];
    this.esporteAtual = esporte;
    const page = this.context.pages()[0] || await this.context.newPage();
    this.instalarCapturaApi(page);
    console.log(`   [Stake] Acessando ${esporte}: ${this.urlBase}${rota}`);
    await this.carregarEsporte(page, rota);
    return [...new Set(this.apiOdds.map((o) => o.url!).filter(Boolean))].slice(0, 10);
  }

  protected async extrairMercadosDoEvento(url: string, _esporte: string): Promise<ScrapedOdd[]> {
    return this.apiOdds.filter((o) => o.url === url);
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): re-abre o browser, navega o(s) cupom(ns) e
   * filtra as odds capturadas pelo confronto (areEventsSame). Mesmo contrato de falha da
   * Betnacional: throw quando NENHUM feed carrega (infra → gate re-gateia) vs [] quando o
   * evento está genuinamente ausente.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const esportes = esporte && ROTAS_STAKE[esporte] ? [esporte] : Object.keys(ROTAS_STAKE);
    try {
      await this.inicializarNavegador(true);
      if (!this.context) throw new Error('Stake: contexto não inicializado na revalidação');
      const page = this.context.pages()[0] || await this.context.newPage();
      this.instalarCapturaApi(page);
      let capturou = false;
      for (const esp of esportes) {
        const rota = ROTAS_STAKE[esp];
        if (!rota) continue;
        this.esporteAtual = esp;
        try {
          await this.carregarEsporte(page, rota);
        } catch {
          continue; // falha só neste esporte; se todos falharem, cai no throw de infra
        }
        if (this.apiOdds.length) capturou = true;
        const doEvento = this.apiOdds.filter((o) => areEventsSame(o.evento, evento));
        if (doEvento.length) return doEvento;
      }
      if (!capturou) throw new Error('Stake indisponível na revalidação (feed de odds vazio — CF/site fora)');
      return []; // feed carregou; evento genuinamente ausente
    } finally {
      await this.fecharNavegador();
    }
  }
}
