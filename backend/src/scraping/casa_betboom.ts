import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';

/**
 * BetBoom (BR) — feed Sportradar "sptpub" REST PÚBLICO (descoberto via recon +
 * captura Playwright em 17/07/2026; o site principal tem Cloudflare, mas o host
 * do feed não).
 *
 * Fluxo (todas as odds do catálogo em ~5 requests, sem browser):
 *  - GET {BASE}/0                → índice { top_events_versions, rest_events_versions }.
 *  - GET {BASE}/{versão}         → blob { sports, events } (gzip; ~400 eventos/página).
 *
 * Encoding Betradar (Sportradar UOF): events[id].markets[marketId][specifier][outcomeId].k
 *  - mercado 1 (1x2): outcomes 1/2/3 — SÓ futebol; não emitimos (futebol 1X2 é
 *    proibido pelas Diretrizes e viraria peso morto).
 *  - "Vencedor" 2-vias (186/219/251/330): outcomes 4 (mandante) / 5 (visitante).
 *  - Totais (18/189/225/238/258/314/328/332): specifier "total=X", outcomes 12/13.
 *  - Handicaps (16/187/188/223/327/331): specifier "hcp=X" (linha do MANDANTE),
 *    outcomes 1714 (mandante) / 1715 (visitante).
 * Confirmado com eventos reais do blob em 17/07/2026.
 *
 * SEM tênis de mesa no prematch (conferido no feed). e-soccer ("eFutebol", "FC 26")
 * fica fora do mapa de esportes de propósito (odd travada de virtual).
 */

const BASE = 'https://api-32-sp-c7818b61-598.sptpub.com/api/v4/prematch/brand/2671060590084104192/pt-BR';

// Betradar sport id → rótulo interno do esporte.
const SPORT_LABEL: Record<string, string> = {
  '1': 'Futebol',
  '2': 'Basquete',
  '5': 'Tenis',
  '23': 'Volei',
  '3': 'Beisebol',
  '109': 'Esports', // Counter-Strike
  '110': 'Esports', // League of Legends
  '111': 'Esports', // Dota 2
  '194': 'Esports', // Valorant
};

// esporte do scanner → Betradar sport ids a raspar.
const ESPORTE_SPORTS: Record<string, string[]> = {
  Futebol: ['1'],
  Basquete: ['2'],
  Tenis: ['5'],
  Tênis: ['5'],
  Volei: ['23'],
  'Vôlei': ['23'],
  Beisebol: ['3'],
  Esports: ['109', '110', '111', '194'],
  'E-Sports': ['109', '110', '111', '194'],
};

/** Whitelist de mercados por Betradar sport id (chave 'ES' = e-sports, comum aos 4 jogos). */
interface MercadoCfg {
  tipo: 'rf2' | 'total' | 'handicap' | 'mapa_vencedor' | 'mapa_total' | 'mapa_handicap';
  label?: string;
}
const MERCADOS: Record<string, Record<string, MercadoCfg>> = {
  // Futebol: 1x2 fora (Diretrizes); BTTS/DNB não existem no feed.
  '1': {
    '18': { tipo: 'total', label: 'Total de Gols' },
    '16': { tipo: 'handicap', label: 'Handicap' },
  },
  // Basquete: SÓ os mercados "incl. prorrogação" (219/225/223). O 1x2 regulamentar
  // do basquete NÃO entra — liquidação diferente do vencedor incl. OT das outras casas.
  '2': {
    '219': { tipo: 'rf2' },
    '225': { tipo: 'total', label: 'Total de Pontos' },
    '223': { tipo: 'handicap', label: 'Handicap' },
  },
  '5': {
    '186': { tipo: 'rf2' },
    '189': { tipo: 'total', label: 'Total de Games' },
    '187': { tipo: 'handicap', label: 'Handicap' }, // handicap de games (GERAL, como a Pinnacle)
    '314': { tipo: 'total', label: 'Total de Sets' },
    '188': { tipo: 'handicap', label: 'Handicap de Sets' },
  },
  '23': {
    '186': { tipo: 'rf2' },
    '238': { tipo: 'total', label: 'Total de Pontos' },
  },
  '3': {
    '251': { tipo: 'rf2' }, // Vencedor (incluindo innings extra) — padrão MLB das outras casas
    '258': { tipo: 'total', label: 'Total de Corridas' },
  },
  ES: {
    '186': { tipo: 'rf2' },
    '328': { tipo: 'total', label: 'Total de Mapas' },
    '327': { tipo: 'handicap', label: 'Handicap de Mapas' },
    '330': { tipo: 'mapa_vencedor' },
    '332': { tipo: 'mapa_total' },    // "Mapa N - Total de rodadas" (cluster ROUNDS_MN, igual à Kambi)
    '331': { tipo: 'mapa_handicap' }, // "Mapa N - Handicap de rodadas"
  },
};

interface BbCompetitor { id: string; name: string; }
interface BbEvent {
  desc: {
    scheduled?: number; // unix segundos
    type?: string;
    virtual?: boolean;
    sport?: string;
    competitors?: BbCompetitor[];
  };
  markets?: Record<string, Record<string, Record<string, { k?: string }>>>;
  state?: { status?: number };
}
interface BbBlob { sports?: Record<string, { name?: string }>; events?: Record<string, BbEvent>; }

export class BetBoomScraper implements OddsScraper {
  private maxEventosPorEsporte = 200; // o parse é local (sem request por evento) — cap generoso

  getNome(): string {
    return 'BetBoom';
  }

  private headers() {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: 'https://betboom.bet.br/',
      Origin: 'https://betboom.bet.br',
    };
  }

  /** Baixa índice + todas as páginas do snapshot e devolve os eventos unificados. */
  private async baixarEventos(rapido = false): Promise<Record<string, BbEvent>> {
    const tent = rapido ? 1 : 3;
    const tmo = rapido ? 10000 : 20000;
    const rIdx = await fetchTextoComRetry(`${BASE}/0`, { headers: this.headers() }, tent, 'BetBoom/idx', tmo);
    if (rIdx.status !== 200) throw new Error(`índice HTTP ${rIdx.status}`);
    const idx = JSON.parse(rIdx.body);
    const versoes: number[] = [...(idx.top_events_versions || []), ...(idx.rest_events_versions || [])];
    const eventos: Record<string, BbEvent> = {};
    for (const v of versoes) {
      try {
        const r = await fetchTextoComRetry(`${BASE}/${v}`, { headers: this.headers() }, rapido ? 1 : 2, 'BetBoom/blob', tmo);
        if (r.status !== 200) continue;
        const blob: BbBlob = JSON.parse(r.body);
        Object.assign(eventos, blob.events || {});
      } catch {
        /* página indisponível — segue com as demais */
      }
    }
    return eventos;
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(`🤖 [BetBoom] Extração via feed sptpub (Sportradar)...`);
    const sportIdsAlvo = new Set<string>();
    for (const e of esportes) (ESPORTE_SPORTS[e] || []).forEach((s) => sportIdsAlvo.add(s));
    if (sportIdsAlvo.size === 0) return [];

    let eventos: Record<string, BbEvent>;
    try {
      eventos = await this.baixarEventos();
    } catch (e: any) {
      console.error(`   ⚠️ [BetBoom] feed indisponível: ${e.message}`);
      return [];
    }

    const odds = this.parseEventos(eventos, sportIdsAlvo);
    const porEsporte: Record<string, number> = {};
    for (const o of odds) porEsporte[o.esporte] = (porEsporte[o.esporte] || 0) + 1;
    for (const [esp, n] of Object.entries(porEsporte)) console.log(`   [BetBoom] ${esp}: ${n} odds`);
    console.log(`✅ [BetBoom] Total: ${odds.length} odds.`);
    return odds;
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): re-baixa o snapshot (5 requests, sem
   * browser) e filtra o evento — mesmo custo do Altenar na revalidação.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    try {
      const sportIds = new Set<string>(
        esporte && ESPORTE_SPORTS[esporte] ? ESPORTE_SPORTS[esporte] : Object.keys(SPORT_LABEL)
      );
      const eventos = await this.baixarEventos(true);
      const filtrados: Record<string, BbEvent> = {};
      for (const [id, ev] of Object.entries(eventos)) {
        const comps = ev.desc?.competitors || [];
        if (comps.length !== 2) continue;
        if (areEventsSame(`${comps[0].name} vs ${comps[1].name}`, evento)) filtrados[id] = ev;
      }
      return this.parseEventos(filtrados, sportIds);
    } catch {
      return [];
    }
  }

  /** Converte os eventos crus em ScrapedOdds segundo a whitelist de mercados. */
  parseEventos(eventos: Record<string, BbEvent>, sportIdsAlvo: Set<string>): ScrapedOdd[] {
    const agora = Date.now();
    const porEsporte = new Map<string, BbEvent[]>();
    for (const ev of Object.values(eventos)) {
      const d = ev.desc || ({} as BbEvent['desc']);
      const sport = d.sport || '';
      if (!sportIdsAlvo.has(sport) || !SPORT_LABEL[sport]) continue;
      if (d.virtual || d.type !== 'match') continue;
      if ((ev.state?.status ?? 0) !== 0) continue; // 0 = agendado (pré-jogo)
      const t = (d.scheduled || 0) * 1000;
      if (!t || t <= agora) continue; // só PRÉ-JOGO
      if ((d.competitors || []).length !== 2) continue;
      const lista = porEsporte.get(sport) || [];
      lista.push(ev);
      porEsporte.set(sport, lista);
    }

    const out: ScrapedOdd[] = [];
    for (const [sport, lista] of porEsporte) {
      lista.sort((a, b) => (a.desc.scheduled || 0) - (b.desc.scheduled || 0));
      for (const ev of lista.slice(0, this.maxEventosPorEsporte)) out.push(...this.parseEvento(ev, sport));
    }
    return out;
  }

  private parseEvento(ev: BbEvent, sport: string): ScrapedOdd[] {
    const esporte = SPORT_LABEL[sport];
    const [c1, c2] = ev.desc.competitors!;
    const home = (c1.name || '').trim();
    const away = (c2.name || '').trim();
    if (!home || !away) return [];
    const evento = `${home} vs ${away}`;
    const dataHora = new Date((ev.desc.scheduled || 0) * 1000).toISOString();
    const cfgMercados = esporte === 'Esports' ? MERCADOS.ES : MERCADOS[sport];
    if (!cfgMercados) return [];
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
    const odd = (o?: { k?: string }) => {
      const n = parseFloat(o?.k || '');
      return Number.isFinite(n) && n > 1 ? n : NaN;
    };
    const out: ScrapedOdd[] = [];

    for (const [mid, specs] of Object.entries(ev.markets || {})) {
      const cfg = cfgMercados[mid];
      if (!cfg) continue;
      for (const [spec, outs] of Object.entries(specs)) {
        // specifier em pares "chave=valor" separados por "|" (ex.: "mapnr=1|total=21.5")
        const kv: Record<string, string> = {};
        for (const par of spec.split('|')) {
          const i = par.indexOf('=');
          if (i > 0) kv[par.slice(0, i)] = par.slice(i + 1);
        }

        if (cfg.tipo === 'rf2' || cfg.tipo === 'mapa_vencedor') {
          const oH = odd(outs['4']);
          const oA = odd(outs['5']);
          if (!oH || !oA) continue;
          const mercado = cfg.tipo === 'mapa_vencedor' ? `Mapa ${kv.mapnr || '?'}` : 'Resultado Final';
          out.push({ esporte, evento, dataHora, mercado, opcaoA: home, opcaoB: away, oddA: oH, oddB: oA });
        } else if (cfg.tipo === 'total' || cfg.tipo === 'mapa_total') {
          const linha = parseFloat(kv.total || '');
          if (!Number.isFinite(linha) || !linhaArbitravel(linha)) continue;
          const oOver = odd(outs['12']);
          const oUnder = odd(outs['13']);
          if (!oOver || !oUnder) continue;
          const mercado = cfg.tipo === 'mapa_total' ? `Mapa ${kv.mapnr || '?'} - Total de rodadas` : cfg.label!;
          out.push({
            esporte, evento, dataHora, mercado, linha,
            opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha), oddA: oOver, oddB: oUnder,
          });
        } else if (cfg.tipo === 'handicap' || cfg.tipo === 'mapa_handicap') {
          const linha = parseFloat(kv.hcp || '');
          if (!Number.isFinite(linha) || !linhaArbitravel(linha)) continue;
          const oH = odd(outs['1714']);
          const oA = odd(outs['1715']);
          if (!oH || !oA) continue;
          const mercado = cfg.tipo === 'mapa_handicap' ? `Mapa ${kv.mapnr || '?'} - Handicap de rodadas` : cfg.label!;
          out.push({
            esporte, evento, dataHora, mercado, linha,
            opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`, oddA: oH, oddB: oA,
          });
        }
      }
    }
    return out;
  }
}
