import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame, areTeamsSame, splitEvento } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';
import { ProxyAgent } from 'undici';

/**
 * Betfair Exchange como BÚSSOLA (linha afiada) do Radar Cashout.
 *
 * ⚠️ VIABILIDADE (pesquisa 20/07/2026): a API oficial foi ENCERRADA para contas
 * brasileiras (jan/2025) e o betfair.bet.br não expõe API. Só funciona com uma conta
 * INTERNACIONAL (.com) + saída de rede numa jurisdição permitida (a Betfair bloqueia
 * por GeoIP, não por ASN de datacenter). Por isso o egress vai por BETFAIR_PROXY (ex.:
 * um exit node/VPS no Reino Unido), igual ao esquema da Pinnacle. SEM as credenciais +
 * proxy, executarCrawler devolve [] (fica desligada). Ver memória radar-cashout.
 *
 * Auth: login interativo (X-Application=appKey, username/password → ssoid) + keep-alive;
 * re-loga em INVALID_SESSION. Preços: listMarketCatalogue → marketIds/runners;
 * listMarketBook (EX_BEST_OFFERS) → melhor back. Exchange é decimal e margem ~0.
 */

const APP_KEY = process.env.BETFAIR_APP_KEY || '';
const USERNAME = process.env.BETFAIR_USERNAME || '';
const PASSWORD = process.env.BETFAIR_PASSWORD || '';
const BETFAIR_PROXY = process.env.BETFAIR_PROXY || '';
const dispatcher = BETFAIR_PROXY ? new ProxyAgent(BETFAIR_PROXY) : undefined;

const IDENTITY = 'https://identitysso.betfair.com/api';
const RPC = 'https://api.betfair.com/exchange/betting/json-rpc/v1';

// esporte interno → Betfair eventTypeId (Futebol=1, Tênis=2, Basquete=7522).
const SPORT_ID: Record<string, number> = {
  Futebol: 1,
  Tenis: 2,
  Tênis: 2,
  Basquete: 7522,
};
const SPORT_LABEL: Record<number, string> = { 1: 'Futebol', 2: 'Tenis', 7522: 'Basquete' };

interface BfRunnerCat { selectionId: number; runnerName: string; }
interface BfMarketCat {
  marketId: string;
  marketStartTime?: string;
  description?: { marketType?: string };
  event?: { name?: string; openDate?: string };
  runners?: BfRunnerCat[];
}
interface BfPriceSize { price: number; size: number; }
interface BfRunnerBook { selectionId: number; ex?: { availableToBack?: BfPriceSize[] }; }
interface BfMarketBook { marketId: string; runners?: BfRunnerBook[]; }

export class BetfairScraper implements OddsScraper {
  private ssoid: string | null = null;
  private maxMercadosPorEsporte = 100;

  getNome(): string {
    return 'Betfair';
  }

  private configurada(): boolean {
    return !!(APP_KEY && USERNAME && PASSWORD);
  }

  private fetchInit(extra: RequestInit = {}): RequestInit {
    const init: any = { ...extra };
    if (dispatcher) init.dispatcher = dispatcher;
    return init as RequestInit;
  }

  /** Login interativo → ssoid. Roteado pelo proxy (jurisdição permitida). */
  private async login(): Promise<boolean> {
    try {
      const r = await fetchTextoComRetry(
        `${IDENTITY}/login`,
        this.fetchInit({
          method: 'POST',
          headers: {
            'X-Application': APP_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: `username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`,
        }),
        2,
        'Betfair/login',
        15000
      );
      if (r.status !== 200) {
        console.error(`❌ [Betfair] login HTTP ${r.status}`);
        return false;
      }
      const j = JSON.parse(r.body);
      if (j.status !== 'SUCCESS' || !j.token) {
        console.error(`❌ [Betfair] login falhou: ${j.status} ${j.error || ''}`);
        return false;
      }
      this.ssoid = j.token;
      return true;
    } catch (err: any) {
      console.error('❌ [Betfair] erro no login:', err.message);
      return false;
    }
  }

  /** Chamada JSON-RPC autenticada; re-loga uma vez em sessão inválida. */
  private async rpc(method: string, params: any, label: string): Promise<any[] | null> {
    if (!this.ssoid && !(await this.login())) return null;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const r = await fetchTextoComRetry(
        RPC,
        this.fetchInit({
          method: 'POST',
          headers: {
            'X-Application': APP_KEY,
            'X-Authentication': this.ssoid || '',
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: `SportsAPING/v1.0/${method}`, params, id: 1 }),
        }),
        2,
        label,
        30000
      );
      if (r.status !== 200) return null;
      const j = JSON.parse(r.body);
      if (j.error) {
        const code = j.error?.data?.APINGException?.errorCode || j.error?.message || '';
        if (/INVALID_SESSION|NO_SESSION/i.test(String(code)) && tentativa === 0) {
          this.ssoid = null;
          if (!(await this.login())) return null;
          continue;
        }
        console.warn(`⚠️ [Betfair] ${label}: ${code}`);
        return null;
      }
      return j.result || [];
    }
    return null;
  }

  private marketTypesFor(etId: number): string[] {
    // Só mercados com unidade NÃO-ambígua (evita cruzar games×sets etc. no cashout).
    if (etId === 1) return ['MATCH_ODDS', 'OVER_UNDER_05', 'OVER_UNDER_15', 'OVER_UNDER_25', 'OVER_UNDER_35', 'OVER_UNDER_45'];
    return ['MATCH_ODDS']; // tênis/basquete: só o vencedor
  }

  /** OVER_UNDER_25 → 2.5 ; OVER_UNDER_05 → 0.5 */
  private linhaDoTipo(marketType: string): number | null {
    const m = marketType.match(/^OVER_UNDER_(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) / 10;
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    if (!this.configurada()) {
      console.warn('⚠️ [Betfair] credenciais ausentes (BETFAIR_APP_KEY/USERNAME/PASSWORD) — desligada.');
      return [];
    }
    console.log(`🤖 [Betfair] Exchange API${BETFAIR_PROXY ? ` [proxy: ${BETFAIR_PROXY}]` : ' [SEM proxy — pode cair no GeoIP BR]'}...`);
    const todas: ScrapedOdd[] = [];
    for (const esporte of esportes) {
      const etId = SPORT_ID[esporte];
      if (!etId) continue;
      try {
        const odds = await this.extrairEsporte(etId);
        console.log(`   [Betfair] ${esporte}: ${odds.length} odds`);
        todas.push(...odds);
      } catch (err: any) {
        console.error(`   ⚠️ [Betfair] Falha em ${esporte}: ${err.message}`);
      }
    }
    console.log(`✅ [Betfair] Total: ${todas.length} odds.`);
    return todas;
  }

  /** Busca dirigida (revalidação): odds atuais de UM evento. */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    if (!this.configurada()) return [];
    const etIds = esporte && SPORT_ID[esporte] ? [SPORT_ID[esporte]] : [...new Set(Object.values(SPORT_ID))];
    for (const etId of etIds) {
      try {
        const odds = (await this.extrairEsporte(etId)).filter((o) => areEventsSame(o.evento, evento));
        if (odds.length) return odds;
      } catch {
        /* tenta o próximo esporte */
      }
    }
    return [];
  }

  private async extrairEsporte(etId: number): Promise<ScrapedOdd[]> {
    const agoraIso = new Date(Date.now() - 5 * 60_000).toISOString(); // margem de -5min
    const catalogo = (await this.rpc(
      'listMarketCatalogue',
      {
        filter: { eventTypeIds: [String(etId)], marketTypeCodes: this.marketTypesFor(etId), marketStartTime: { from: agoraIso } },
        marketProjection: ['EVENT', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'MARKET_START_TIME'],
        sort: 'FIRST_TO_START',
        maxResults: this.maxMercadosPorEsporte,
      },
      'Betfair/catalogue'
    )) as BfMarketCat[] | null;
    if (!catalogo?.length) return [];

    const catById = new Map<string, BfMarketCat>();
    for (const c of catalogo) catById.set(c.marketId, c);

    // listMarketBook em lotes (limite de peso da API).
    const ids = catalogo.map((c) => c.marketId);
    const books: BfMarketBook[] = [];
    for (let i = 0; i < ids.length; i += 40) {
      const lote = (await this.rpc(
        'listMarketBook',
        { marketIds: ids.slice(i, i + 40), priceProjection: { priceData: ['EX_BEST_OFFERS'] } },
        'Betfair/book'
      )) as BfMarketBook[] | null;
      if (lote?.length) books.push(...lote);
    }

    const out: ScrapedOdd[] = [];
    for (const book of books) {
      const cat = catById.get(book.marketId);
      if (!cat) continue;
      try {
        out.push(...this.parseMercado(etId, cat, book));
      } catch {
        /* mercado com formato inesperado — ignora */
      }
    }
    return out;
  }

  private parseMercado(etId: number, cat: BfMarketCat, book: BfMarketBook): ScrapedOdd[] {
    const esporte = SPORT_LABEL[etId] || String(etId);
    const dataHora = cat.marketStartTime || cat.event?.openDate || 'Hoje';
    const eventoName = cat.event?.name || '';
    const split = splitEvento(eventoName.replace(/\s+v\s+/i, ' vs '));
    if (!split) return [];
    const [home, away] = split;
    const eventoStr = `${home} vs ${away}`;
    const marketType = cat.description?.marketType || '';

    // melhor back por selectionId
    const backById = new Map<number, number>();
    for (const r of book.runners || []) {
      const p = r.ex?.availableToBack?.[0]?.price;
      if (typeof p === 'number' && p > 1) backById.set(r.selectionId, p);
    }
    const nomePorId = new Map<number, string>();
    for (const r of cat.runners || []) nomePorId.set(r.selectionId, r.runnerName);
    const ok = (n?: number) => typeof n === 'number' && Number.isFinite(n) && n > 1;

    if (marketType === 'MATCH_ODDS') {
      // separa runners
      let backHome: number | undefined, backAway: number | undefined, backDraw: number | undefined;
      for (const [id, nome] of nomePorId) {
        const back = backById.get(id);
        if (/draw|empate/i.test(nome)) backDraw = back;
        else if (areTeamsSame(nome, home)) backHome = back;
        else if (areTeamsSame(nome, away)) backAway = back;
      }
      if (etId === 1) {
        // futebol 3-vias → dupla chance sintética (igual à Pinnacle)
        if (ok(backHome) && ok(backAway) && ok(backDraw)) {
          return [{
            esporte, evento: eventoStr, dataHora, mercado: 'Resultado Final',
            opcaoA: `Vitória ${home}`, opcaoB: `${away} ou Empate`,
            oddA: backHome!, oddB: 1 / (1 / backAway! + 1 / backDraw!),
          }];
        }
        return [];
      }
      // tênis/basquete 2-vias
      if (ok(backHome) && ok(backAway)) {
        return [{
          esporte, evento: eventoStr, dataHora, mercado: 'Resultado Final',
          opcaoA: home, opcaoB: away, oddA: backHome!, oddB: backAway!,
        }];
      }
      return [];
    }

    // OVER_UNDER_x5 (gols)
    const linha = this.linhaDoTipo(marketType);
    if (linha != null && linhaArbitravel(linha)) {
      let over: number | undefined, under: number | undefined;
      for (const [id, nome] of nomePorId) {
        const back = backById.get(id);
        if (/^over/i.test(nome)) over = back;
        else if (/^under/i.test(nome)) under = back;
      }
      if (ok(over) && ok(under)) {
        return [{
          esporte, evento: eventoStr, dataHora, mercado: 'Total de Gols', linha,
          opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha), oddA: over!, oddB: under!,
        }];
      }
    }
    return [];
  }
}
