import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';

/**
 * Scraper genérico para casas na plataforma **NSoft "Sports AIO" (7platform)** — ex.:
 * Brazino777 e Aposta Ganha. API PÚBLICA na nuvem da NSoft: HTTP puro, sem browser,
 * sem cookie e sem Cloudflare (o Cloudflare fica só no site da casa, que NÃO é usado).
 *
 * Recon 29/07/2026 (detalhes em memória `brazino777-nsoft-protocolo`):
 *  - Oferta: GET {AIO}/tenants/<tenant>/games/1/languages/pt/offer/cursors?sports=<sportId>
 *    (games/1 = pré-match, games/2 = ao vivo; o path exige gameID NUMÉRICO).
 *  - Paginação por CURSOR em path: .../offer/cursors/<cursorId>. `limit` é ignorado.
 *  - Os DICIONÁRIOS (sports/markets/outcomes) vêm INCREMENTALMENTE: só a 1ª página os
 *    traz; as seguintes só mandam o que é novo. Por isso o parser ACUMULA entre páginas.
 *  - O tenant de cada marca sai de
 *    https://sports-assets-proxy.nsoft.app/applications/sports-aio-web/bootstrap-config
 *
 * Convenções do feed (todas verificadas em payload real):
 *  - **Odds são inteiros escalados por 10.000**: 37000 = 3.70.
 *  - **`competitors` vem FORA DE ORDEM** — o mandante é o de `ordinal: 1`, NUNCA o
 *    índice 0 do array (visto ordinal 2 antes do 1).
 *  - **Um mercado de Total/Handicap carrega VÁRIAS linhas de uma vez**: os `outcomes`
 *    repetem o mesmo `outcomeId` com `specifiers[].value` diferente. Pareia-se
 *    Over×Under (e Home×Away no handicap) SÓ com specifier IGUAL.
 *  - No handicap, o specifier é a linha do MANDANTE; o visitante é a negação (o próprio
 *    template do feed é `{{HANDICAP_VALUE*-1}}` para o lado 2).
 */

const AIO = 'https://aio-offer-distribution.de-2.nsoft.cloud';
const ORIGIN = 'https://sports-aio-web.7platform.net';

interface NSoftConfig {
  nome: string;
  tenant: string;
  /** Páginas de cursor por esporte (cada uma ~50 eventos). Default 4. */
  maxPaginas?: number;
}

/**
 * esporte interno → NOME do esporte no feed da NSoft (em pt).
 *
 * ⚠️ Os sportIds da NSoft são **POR TENANT**, não globais: na Brazino777 o id 65 é
 * "Futebol", e na Aposta Ganha o MESMO 65 é "Futebol Americano". Hardcodar id levaria a
 * rotular futebol americano como futebol e cruzar com futebol de verdade de outra casa.
 * Por isso os ids são resolvidos em runtime pelo NOME, por tenant (resolverSports()).
 *
 * O casamento é por nome EXATO normalizado — "futebol" NUNCA pode casar por substring
 * com "futebol americano".
 */
const SPORT_NOME: Record<string, string> = {
  Futebol: 'futebol',
  Basquete: 'basquetebol',
  Tenis: 'tênis',
  'Tênis': 'tênis',
  Volei: 'voleibol',
  'Vôlei': 'voleibol',
  TenisDeMesa: 'tênis de mesa',
  'Tenis de Mesa': 'tênis de mesa',
  'Tênis de Mesa': 'tênis de mesa',
  Beisebol: 'beisebol',
};
/** nome no feed → rótulo interno emitido no ScrapedOdd.esporte. */
const NOME_LABEL: Record<string, string> = {
  futebol: 'Futebol',
  basquetebol: 'Basquete',
  'tênis': 'Tenis',
  voleibol: 'Volei',
  'tênis de mesa': 'Tenis de Mesa',
  beisebol: 'Beisebol',
};
/** rótulo interno → chave da tabela MERCADOS (que é por ESPORTE, não por id). */
const MERCADOS_POR_LABEL: Record<string, string> = {
  Futebol: 'futebol',
  Basquete: 'basquetebol',
  Tenis: 'tênis',
  Volei: 'voleibol',
  'Tenis de Mesa': 'tênis de mesa',
  Beisebol: 'beisebol',
};

type Tipo = 'TOTAL' | 'HANDICAP' | 'VENCEDOR' | 'BTTS';

/**
 * Mercados aceitos por esporte, casados pelo NOME EXATO do dicionário (normalizado).
 * Regra do projeto: nunca casar mercado por heurística de forma.
 *
 * Ficam FORA de propósito:
 *  - "Qualificar" (futebol, marketId 137): é avanço de fase e tem a MESMA forma de um
 *    vencedor 2-vias — cruzar com Resultado Final de outra casa é arbitragem entre
 *    mercados diferentes.
 *  - Tudo com `{{...}}` no nome: são as variantes por set/game/map/time
 *    ("{{M.S.SET_NUMBER}}º set - Vencedor", "{{E.C1.NAME}} - Total"), que liquidam
 *    diferente do mercado da partida.
 *  - E-sports (sportId 34): mercados de MAPAS pedem tratamento próprio (Diretrizes §5).
 *
 * O rótulo emitido tem de bater com o das casas já integradas, senão o canônico difere
 * e a casa nunca cruza — conferido com normalizarMercado contra Altenar/Rivalo.
 */
const MERCADOS: Record<string, Record<string, { tipo: Tipo; rotulo: string }>> = {
  futebol: {
    'total de gols': { tipo: 'TOTAL', rotulo: 'Total de Gols' },
    'ambas as equipes marcam': { tipo: 'BTTS', rotulo: 'Ambas equipes marcam' },
  },
  'tênis': {
    'total de jogos': { tipo: 'TOTAL', rotulo: 'Total de Games' },
    'handicap de jogos': { tipo: 'HANDICAP', rotulo: 'Handicap' },
    vencedor: { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
  },
  basquetebol: {
    'total (incl. ot)': { tipo: 'TOTAL', rotulo: 'Total de Pontos' },
    'handicap (incl. prorrogação)': { tipo: 'HANDICAP', rotulo: 'Handicap' },
    'vencedor (incl. prorrogação)': { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
  },
  voleibol: {
    'total de pontos': { tipo: 'TOTAL', rotulo: 'Total de Pontos' },
    handicap: { tipo: 'HANDICAP', rotulo: 'Handicap de Pontos' },
    vencedor: { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
  },
  'tênis de mesa': {
    'total de pontos': { tipo: 'TOTAL', rotulo: 'Total de Pontos' },
    'handicap de pontos': { tipo: 'HANDICAP', rotulo: 'Handicap de Pontos' },
    vencedor: { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
  },
  beisebol: {
    'total (incl. ei)': { tipo: 'TOTAL', rotulo: 'Total de Corridas' },
    'handicap (incl. prorrogação)': { tipo: 'HANDICAP', rotulo: 'Handicap' },
    vencedor: { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
  },
};

/** Papel de cada outcome dentro do mercado, pelo `name` do dicionário. */
type Papel = 'OVER' | 'UNDER' | 'HOME' | 'AWAY' | 'SIM' | 'NAO' | null;
function papelOutcome(nome: string): Papel {
  const n = (nome || '').trim().toLowerCase();
  if (/^(acima|over|mais)/.test(n)) return 'OVER';
  if (/^(abaixo|under|menos)/.test(n)) return 'UNDER';
  if (/^home/.test(n) || n === '1') return 'HOME';
  if (/^away/.test(n) || n === '2') return 'AWAY';
  if (/^(sim|yes)$/.test(n)) return 'SIM';
  if (/^(n[aã]o|no)$/.test(n)) return 'NAO';
  return null;
}

const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

interface NsOutcomeDic { id: number; name?: string }
interface NsMarketDic { id: number; sportId?: number; name?: string; eventMarketName?: string; outcomes?: NsOutcomeDic[] }
interface NsEventOutcome { outcomeId: number; odds?: number; status?: number; specifiers?: Array<{ id: number; value?: string }> }
interface NsEventMarket { marketId: number; outcomes?: NsEventOutcome[] }
interface NsEvent {
  id: number; name?: string; startsAt?: string; playStatus?: number;
  competitors?: Array<{ ordinal?: number; teamName?: string; name?: string }>;
  markets?: NsEventMarket[];
}
interface NsResp { sports?: any[]; markets?: NsMarketDic[]; events?: NsEvent[]; cursorId?: string }

export class NSoftAioScraper implements OddsScraper {
  private cfg: Required<NSoftConfig>;

  constructor(cfg: NSoftConfig) {
    this.cfg = { maxPaginas: 4, ...cfg };
  }

  getNome(): string {
    return this.cfg.nome;
  }

  private headers() {
    return {
      Accept: 'application/json',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    };
  }

  private base(): string {
    return `${AIO}/tenants/${this.cfg.tenant}/games/1/languages/pt/offer/cursors`;
  }

  /**
   * Resolve nome do esporte → sportId DESTE tenant (os ids não são globais na NSoft).
   * Fonte: offer-stats/event-counts/cursors, que lista os esportes do tenant com id+nome.
   * Cacheado por instância (uma chamada por varredura).
   */
  private sportsCache: Map<string, number> | null = null;
  private async resolverSports(): Promise<Map<string, number>> {
    if (this.sportsCache) return this.sportsCache;
    const mapa = new Map<string, number>();
    try {
      const url = `${AIO}/tenants/${this.cfg.tenant}/games/1/languages/pt/offer-stats/event-counts/cursors`;
      const resp = await fetchTextoComRetry(url, { headers: this.headers() }, 2, `${this.cfg.nome}/sports`);
      if (resp.status === 200) {
        const j: NsResp = JSON.parse(resp.body);
        for (const sp of j.sports || []) {
          const nome = norm(sp?.name || '');
          if (nome && typeof sp?.id === 'number' && !mapa.has(nome)) mapa.set(nome, sp.id);
        }
      }
    } catch (e: any) {
      console.error(`   ⚠️ [${this.cfg.nome}] não resolveu sportIds: ${e.message}`);
    }
    this.sportsCache = mapa;
    return mapa;
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(`🤖 [${this.cfg.nome}] Extração via NSoft AIO (API pública)...`);
    const todas: ScrapedOdd[] = [];
    const mapa = await this.resolverSports();
    const nomes = [...new Set(esportes.map((e) => SPORT_NOME[e]).filter(Boolean))];
    for (const nome of nomes) {
      const sid = mapa.get(nome);
      if (!sid) {
        console.log(`   [${this.cfg.nome}] ${NOME_LABEL[nome]}: esporte não ofertado neste tenant`);
        continue;
      }
      try {
        const antes = todas.length;
        await this.coletarEsporte(sid, nome, todas);
        console.log(`   [${this.cfg.nome}] ${NOME_LABEL[nome]}: ${todas.length - antes} odds`);
      } catch (e: any) {
        console.error(`   ⚠️ [${this.cfg.nome}] falha em ${NOME_LABEL[nome]}: ${e.message}`);
      }
    }
    const unicas = this.dedupar(todas);
    console.log(`✅ [${this.cfg.nome}] Total: ${unicas.length} odds${unicas.length !== todas.length ? ` (${todas.length - unicas.length} duplicadas removidas)` : ''}.`);
    return unicas;
  }

  /**
   * Remove ofertas repetidas de (evento, mercado, linha). O feed lista o MESMO confronto
   * sob ids de evento diferentes (visto em tênis de mesa da Liga Pro), o que gerava duas
   * linhas idênticas com odds levemente distintas — ambíguo para o motor. Mantém a de
   * odd mais alta (a melhor oferta real para o apostador).
   */
  private dedupar(odds: ScrapedOdd[]): ScrapedOdd[] {
    const melhor = new Map<string, ScrapedOdd>();
    for (const o of odds) {
      const k = `${o.esporte}|${o.evento}|${o.mercado}|${o.linha ?? ''}`;
      const at = melhor.get(k);
      if (!at || o.oddA + o.oddB > at.oddA + at.oddB) melhor.set(k, o);
    }
    return [...melhor.values()];
  }

  /** Revalidação dirigida: re-coleta o esporte e filtra o evento (a API não busca por jogo). */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const mapa = await this.resolverSports();
    const nomes = esporte && SPORT_NOME[esporte] ? [SPORT_NOME[esporte]] : [...new Set(Object.values(SPORT_NOME))];
    for (const nome of nomes) {
      const sid = mapa.get(nome);
      if (!sid) continue;
      try {
        const out: ScrapedOdd[] = [];
        await this.coletarEsporte(sid, nome, out);
        const doEvento = out.filter((o) => areEventsSame(o.evento, evento));
        if (doEvento.length) return doEvento;
      } catch {
        /* melhor esforço */
      }
    }
    return [];
  }

  /** Percorre as páginas de cursor de um esporte, acumulando o dicionário de mercados. */
  private async coletarEsporte(sportId: number, nomeEsporte: string, out: ScrapedOdd[]): Promise<void> {
    const dicMercados = new Map<number, NsMarketDic>();
    const dicOutcomes = new Map<number, string>(); // outcomeId → name
    // O stream de cursor REENVIA eventos já vistos (atualização). Sem dedupe, o mesmo
    // jogo é parseado 2x e sai linha duplicada — visto em tênis de mesa: dois handicaps
    // -0.5 no mesmo evento com odds 1.82 e 1.86.
    const vistos = new Set<number>();
    let url = `${this.base()}?sports=${sportId}`;
    let cursorAnterior: string | null = null;

    for (let p = 0; p < this.cfg.maxPaginas; p++) {
      const resp = await fetchTextoComRetry(url, { headers: this.headers() }, 2, `${this.cfg.nome}/of`);
      if (resp.status !== 200) break;
      const j: NsResp = JSON.parse(resp.body);
      // Dicionários vêm incrementalmente — acumula, nunca substitui.
      for (const m of j.markets || []) {
        dicMercados.set(m.id, m);
        for (const o of m.outcomes || []) if (o.name) dicOutcomes.set(o.id, o.name);
      }
      for (const ev of j.events || []) {
        if (vistos.has(ev.id)) continue;
        vistos.add(ev.id);
        this.parseEvento(ev, nomeEsporte, dicMercados, dicOutcomes, out);
      }

      const cur = j.cursorId;
      if (!cur || cur === cursorAnterior || !(j.events || []).length) break;
      cursorAnterior = cur;
      url = `${this.base()}/${encodeURIComponent(cur)}`;
    }
  }

  private parseEvento(
    ev: NsEvent,
    nomeEsporte: string,
    dicMercados: Map<number, NsMarketDic>,
    dicOutcomes: Map<number, string>,
    out: ScrapedOdd[]
  ): void {
    const esporte = NOME_LABEL[nomeEsporte];
    if (!esporte) return;
    // Mandante = ordinal 1. NUNCA usar a ordem do array (vem embaralhada).
    const comps = (ev.competitors || []).slice().sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
    if (comps.length !== 2) return;
    const home = (comps[0].teamName || comps[0].name || '').trim();
    const away = (comps[1].teamName || comps[1].name || '').trim();
    if (!home || !away) return;
    // Só PRÉ-JOGO.
    const t = Date.parse(ev.startsAt || '');
    if (!isNaN(t) && t <= Date.now()) return;
    const evento = `${home} vs ${away}`;
    const dataHora = ev.startsAt || 'Hoje';
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
    const permitidos = MERCADOS[MERCADOS_POR_LABEL[esporte]] || {};

    for (const m of ev.markets || []) {
      const dic = dicMercados.get(m.marketId);
      if (!dic) continue;
      const nomeMercado = dic.eventMarketName || dic.name || '';
      // Variantes por set/game/map/time trazem placeholder no nome → fora.
      if (nomeMercado.includes('{{')) continue;
      const cfg = permitidos[norm(nomeMercado)];
      if (!cfg) continue;

      const odd = (o: NsEventOutcome) => (o.odds || 0) / 10000;
      const ativo = (o?: NsEventOutcome) => !!o && o.status === 1 && odd(o) > 1;
      const spec = (o: NsEventOutcome) => o.specifiers?.[0]?.value ?? '';
      const papel = (o: NsEventOutcome) => papelOutcome(dicOutcomes.get(o.outcomeId) || '');
      const outs = (m.outcomes || []).filter(ativo);

      if (cfg.tipo === 'TOTAL' || cfg.tipo === 'HANDICAP') {
        // Um mercado traz VÁRIAS linhas: agrupa por specifier e pareia dentro do grupo.
        const porLinha = new Map<string, NsEventOutcome[]>();
        for (const o of outs) {
          const k = spec(o);
          if (!k) continue;
          if (!porLinha.has(k)) porLinha.set(k, []);
          porLinha.get(k)!.push(o);
        }
        for (const [valor, grupo] of porLinha) {
          const linha = parseFloat(valor);
          if (!Number.isFinite(linha) || !linhaArbitravel(linha)) continue;
          if (cfg.tipo === 'TOTAL') {
            const over = grupo.find((o) => papel(o) === 'OVER');
            const under = grupo.find((o) => papel(o) === 'UNDER');
            if (!over || !under) continue;
            out.push({
              esporte, evento, dataHora, mercado: cfg.rotulo, linha,
              opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
              oddA: odd(over), oddB: odd(under),
            });
          } else {
            // specifier = linha do MANDANTE; o visitante é a negação (template do feed).
            const h = grupo.find((o) => papel(o) === 'HOME');
            const a = grupo.find((o) => papel(o) === 'AWAY');
            if (!h || !a) continue;
            out.push({
              esporte, evento, dataHora, mercado: cfg.rotulo, linha,
              opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
              oddA: odd(h), oddB: odd(a),
            });
          }
        }
      } else if (cfg.tipo === 'VENCEDOR') {
        // Só 2 vias. Se houver empate no mercado, é 3-vias → fora.
        if (outs.some((o) => !papel(o))) continue;
        const h = outs.find((o) => papel(o) === 'HOME');
        const a = outs.find((o) => papel(o) === 'AWAY');
        if (!h || !a || outs.length !== 2) continue;
        out.push({
          esporte, evento, dataHora, mercado: cfg.rotulo,
          opcaoA: home, opcaoB: away, oddA: odd(h), oddB: odd(a),
        });
      } else if (cfg.tipo === 'BTTS') {
        const sim = outs.find((o) => papel(o) === 'SIM');
        const nao = outs.find((o) => papel(o) === 'NAO');
        if (!sim || !nao) continue;
        out.push({
          esporte, evento, dataHora, mercado: cfg.rotulo,
          opcaoA: 'Sim', opcaoB: 'Não', oddA: odd(sim), oddB: odd(nao),
        });
      }
    }
  }
}

/**
 * Brazino777 — NSoft AIO, tenant `brazino777br` (do bootstrap-config da NSoft).
 * O site tem Cloudflare e o iframe do sportsbook não carrega odds, mas a API da NSoft
 * responde por HTTP puro — este scraper NÃO precisa de browser.
 */
export class Brazino777Scraper extends NSoftAioScraper {
  constructor() {
    super({ nome: 'Brazino777', tenant: '27b22090-fe8e-49f7-a64e-1d75d7f44076' });
  }
}

/**
 * Aposta Ganha — NSoft AIO, tenant `aposta_ganha_sportsbook`. Descoberta de brinde no
 * recon da Brazino: o bootstrap-config da NSoft lista as marcas, e ela usa a MESMA
 * plataforma — entra só com config.
 */
export class ApostaGanhaScraper extends NSoftAioScraper {
  constructor() {
    super({ nome: 'ApostaGanha', tenant: '736cb862-f857-4970-8664-3ab7e4ea1137' });
  }
}
