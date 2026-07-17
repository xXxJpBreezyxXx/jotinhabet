import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';
import { ProxyAgent } from 'undici';

/**
 * A Pinnacle bloqueia por ASN o IP do datacenter da VPS (HTTP 403). PINNACLE_PROXY
 * (ex.: http://jotinhabet_tsproxy:1055) aponta pro sidecar Tailscale que sai por um
 * exit node residencial (celular). O dispatcher é passado SÓ nas requisições da
 * Pinnacle — o resto do backend continua saindo direto.
 */
const PINNACLE_PROXY = process.env.PINNACLE_PROXY || '';
const pinnacleDispatcher = PINNACLE_PROXY ? new ProxyAgent(PINNACLE_PROXY) : undefined;

/**
 * Pinnacle — via API "arcadia" guest (pública, X-API-Key estática do próprio site).
 *
 * Pinnacle é a casa de odds mais afiada (baixa margem, não limita ganhadores), então
 * cruzá-la contra casas "soft" (KTO, Superbet, ...) é a melhor fonte de arbitragem.
 *
 *  - /0.1/sports/{sportId}/matchups            → eventos (id, participants, startTime).
 *  - /0.1/matchups/{id}/markets/related/straight → moneyline / total / spread (period 0 = FT).
 *
 * Odds vêm em formato AMERICANO (ex.: -365, +298) → convertidas para decimal.
 */

const BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
const API_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R'; // guest key pública usada pelo site da Pinnacle

// esporte interno → Pinnacle sportId (descoberto: Soccer=29, Tennis=33, Basketball=4,
// E-Sports=12, Volleyball=34, Baseball=3). Tênis de Mesa NÃO existe na Pinnacle.
const SPORT_ID: Record<string, number> = {
  Futebol: 29,
  Tenis: 33,
  Tênis: 33,
  Basquete: 4,
  Esports: 12,
  'E-Sports': 12,
  Volei: 34,
  'Vôlei': 34,
  Beisebol: 3,
};
const SPORT_LABEL: Record<number, string> = {
  29: 'Futebol', 33: 'Tenis', 4: 'Basquete', 12: 'Esports', 34: 'Volei', 3: 'Beisebol',
};
// Rótulo do total por esporte, para o assunto normalizar certo (gols/games/pontos/mapas).
// Em e-sports o total de jogo completo (period 0) é o total de MAPAS → normaliza p/ TOTAIS_MAPAS.
// VÔLEI (period 0): total e spread são em SETS (linhas 3.5/4.5 e 1.5/2.5 — confirmado
// ao vivo), NÃO em pontos — rotular como pontos cruzaria com mercado errado da Kambi.
const TOTAL_LABEL: Record<number, string> = {
  29: 'Total de Gols',
  33: 'Total de Games',
  4: 'Total de Pontos',
  12: 'Total de Mapas',
  34: 'Total de Sets',
  3: 'Total de Corridas',
};
// Rótulo do spread por esporte (default 'Handicap'; e-sports vira Handicap de Mapas no parser).
const HANDICAP_LABEL: Record<number, string> = {
  34: 'Handicap de Sets',
};

interface PinPrice {
  designation?: string; // home | away | draw | over | under
  points?: number;
  price: number; // americano
}
interface PinMarket {
  matchupId: number;
  type: string; // moneyline | total | spread | team_total
  period: number; // 0 = jogo completo
  side?: string;
  prices: PinPrice[];
  status?: string;
}
interface PinParticipant {
  name: string;
  alignment?: string; // home | away | neutral
}
interface PinMatchup {
  id: number;
  startTime?: string;
  parentId?: number | null;
  participants?: PinParticipant[];
  league?: { name?: string };
  state?: string;
  isLive?: boolean;
}

export class PinnacleScraper implements OddsScraper {
  private maxEventosPorEsporte = 80;

  getNome(): string {
    return 'Pinnacle';
  }

  private headers() {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'X-API-Key': API_KEY,
      Referer: 'https://www.pinnacle.com/',
      Origin: 'https://www.pinnacle.com',
    };
  }

  /** Init do fetch: headers + dispatcher do proxy (quando PINNACLE_PROXY configurado). */
  private fetchInit(): RequestInit {
    const init: any = { headers: this.headers() };
    if (pinnacleDispatcher) init.dispatcher = pinnacleDispatcher;
    return init as RequestInit;
  }

  /** Odds americanas → decimais. */
  private americanoParaDecimal(price: number): number {
    if (!Number.isFinite(price) || price === 0) return NaN;
    return price > 0 ? price / 100 + 1 : 100 / Math.abs(price) + 1;
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(
      `🤖 [Pinnacle] Extração via API arcadia (guest)${PINNACLE_PROXY ? ` [proxy Tailscale: ${PINNACLE_PROXY}]` : ''}...`
    );
    const todas: ScrapedOdd[] = [];
    for (const esporte of esportes) {
      const sid = SPORT_ID[esporte];
      if (!sid) continue;
      try {
        const odds = await this.extrairEsporte(sid);
        console.log(`   [Pinnacle] ${esporte}: ${odds.length} odds`);
        todas.push(...odds);
      } catch (err: any) {
        console.error(`   ⚠️ [Pinnacle] Falha em ${esporte}: ${err.message}`);
      }
    }
    console.log(`✅ [Pinnacle] Total: ${todas.length} odds.`);
    return todas;
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): odds atuais de UM evento, 2-3 requests
   * (matchups do esporte + markets só do matchup casado). Reusa o parser de produção.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const sids = esporte && SPORT_ID[esporte] ? [SPORT_ID[esporte]] : [...new Set(Object.values(SPORT_ID))];
    for (const sid of sids) {
      try {
        // 1 tentativa/10s: com o túnel morto, o gate não pode pendurar a varredura.
        const rMatch = await fetchTextoComRetry(
          `${BASE}/sports/${sid}/matchups?withSpecials=false&brandId=0`,
          this.fetchInit(), 1, 'Pinnacle/reval', 10000
        );
        if (rMatch.status !== 200) continue;
        const matchups: PinMatchup[] = JSON.parse(rMatch.body);
        const alvo = matchups
          .filter((m) => {
            // Mesmos filtros da varredura: raiz, 2 participantes, NÃO ao vivo, pré-jogo.
            if (m.parentId || (m.participants?.length || 0) < 2 || m.isLive) return false;
            const t = Date.parse(m.startTime || '');
            if (!isNaN(t) && t <= Date.now()) return false;
            const home = m.participants!.find((p) => p.alignment === 'home')?.name;
            const away = m.participants!.find((p) => p.alignment === 'away')?.name;
            return !!home && !!away && areEventsSame(`${home} vs ${away}`, evento);
          })
          .slice(0, 2);
        const odds: ScrapedOdd[] = [];
        for (const ev of alvo) {
          try { odds.push(...(await this.extrairMercadosEvento(ev, sid))); } catch { /* segue */ }
        }
        if (odds.length) return odds;
      } catch {
        /* tenta o próximo esporte */
      }
    }
    return [];
  }

  private async extrairEsporte(sportId: number): Promise<ScrapedOdd[]> {
    const rMatch = await fetchTextoComRetry(
      `${BASE}/sports/${sportId}/matchups?withSpecials=false&brandId=0`,
      this.fetchInit(),
      3,
      'Pinnacle/match'
    );
    if (rMatch.status !== 200) throw new Error(`matchups HTTP ${rMatch.status}`);
    const matchups: PinMatchup[] = JSON.parse(rMatch.body);

    // Só jogos "raiz" (sem parentId) com 2 participantes, PRÉ-JOGO (não ao vivo, início
    // no futuro); os mais próximos primeiro.
    const agora = Date.now();
    const eventos = matchups
      .filter((m) => {
        if (m.parentId || (m.participants?.length || 0) < 2 || m.isLive) return false;
        const t = Date.parse(m.startTime || '');
        return isNaN(t) || t > agora;
      })
      .sort((a, b) => (Date.parse(a.startTime || '') || 0) - (Date.parse(b.startTime || '') || 0))
      .slice(0, this.maxEventosPorEsporte);
    if (eventos.length === 0) return [];

    // BULK: todos os mercados straight do esporte em 1 request. Com o teto de 80
    // eventos, o modelo por-evento seriam ~80 requests por esporte pelo túnel
    // Tailscale; o bulk resolve o esporte inteiro com 2. Se falhar, cai no
    // per-evento (comportamento antigo).
    let porMatchup: Map<number, PinMarket[]> | null = null;
    try {
      const rB = await fetchTextoComRetry(
        `${BASE}/sports/${sportId}/markets/straight?primaryOnly=false&withSpecials=false`,
        this.fetchInit(), 2, 'Pinnacle/bulk', 30000
      );
      if (rB.status === 200) {
        const todos: PinMarket[] = JSON.parse(rB.body);
        porMatchup = new Map();
        for (const mk of todos) {
          const arr = porMatchup.get(mk.matchupId);
          if (arr) arr.push(mk);
          else porMatchup.set(mk.matchupId, [mk]);
        }
      }
    } catch {
      /* bulk indisponível — segue no per-evento */
    }

    const odds: ScrapedOdd[] = [];
    for (const ev of eventos) {
      try {
        const markets = porMatchup ? porMatchup.get(ev.id) || [] : await this.buscarMercadosEvento(ev.id);
        odds.push(...this.parseMercados(ev, sportId, markets));
      } catch {
        /* evento sem mercados — ignora */
      }
    }
    return odds;
  }

  /** Mercados straight de UM matchup (usado na revalidação e no fallback sem bulk). */
  private async buscarMercadosEvento(matchupId: number): Promise<PinMarket[]> {
    const r = await fetchTextoComRetry(
      `${BASE}/matchups/${matchupId}/markets/related/straight`,
      this.fetchInit(),
      2,
      'Pinnacle/mkt'
    );
    if (r.status !== 200) return [];
    return JSON.parse(r.body);
  }

  private async extrairMercadosEvento(ev: PinMatchup, sportId: number): Promise<ScrapedOdd[]> {
    return this.parseMercados(ev, sportId, await this.buscarMercadosEvento(ev.id));
  }

  /** Converte os mercados crus de um matchup em ScrapedOdds (moneyline/total/spread, period 0). */
  private parseMercados(ev: PinMatchup, sportId: number, markets: PinMarket[]): ScrapedOdd[] {
    const home = ev.participants?.find((p) => p.alignment === 'home')?.name;
    const away = ev.participants?.find((p) => p.alignment === 'away')?.name;
    if (!home || !away) return [];

    const esporte = SPORT_LABEL[sportId] || String(sportId);
    const ehEsports = sportId === 12;
    const dataHora = ev.startTime || 'Hoje';
    const eventoStr = `${home} vs ${away}`;
    const dec = (p?: number) => (typeof p === 'number' ? this.americanoParaDecimal(p) : NaN);
    const ok = (n: number) => Number.isFinite(n) && n > 1;
    // Meia-linha (.5) e quarter asiática (.25/.75) — a Pinnacle é a maior fonte de
    // quarters. Inteira segue barrada (push). O piso de lucro da quarter (cenário do
    // meio paga metade) é aplicado no engine, não aqui.
    const out: ScrapedOdd[] = [];

    for (const mk of markets) {
      if (mk.period !== 0 || mk.status === 'closed') continue; // só jogo completo, mercado aberto
      // O endpoint "related/straight" traz mercados de DEZENAS de matchups relacionados
      // (escanteios, especiais, props). Sem este filtro, totais de ESCANTEIOS (linha
      // 9.5/10.5...) eram emitidos como "Total de Gols" e cruzavam com mercados errados
      // de outras casas (ex.: a falsa arb "chutes × escanteios" rotulada de gols).
      if (mk.matchupId !== ev.id) continue;

      if (mk.type === 'moneyline') {
        const h = dec(mk.prices.find((p) => p.designation === 'home')?.price);
        const a = dec(mk.prices.find((p) => p.designation === 'away')?.price);
        const d = dec(mk.prices.find((p) => p.designation === 'draw')?.price);
        if (Number.isFinite(d) && d > 1) {
          // 3-way (futebol) → dupla chance sintética. Diretrizes §5: e-sports não admite
          // 1X2/3-vias (empate de BO2) → não sintetiza (deixa passar só o moneyline 2-vias).
          if (ok(h) && ok(a) && !ehEsports) {
            out.push({
              esporte, evento: eventoStr, dataHora,
              mercado: 'Resultado Final',
              opcaoA: `Vitória ${home}`,
              opcaoB: `${away} ou Empate`,
              oddA: h,
              oddB: 1 / (1 / d + 1 / a),
            });
          }
        } else if (ok(h) && ok(a)) {
          out.push({
            esporte, evento: eventoStr, dataHora,
            mercado: 'Resultado Final',
            opcaoA: home, opcaoB: away, oddA: h, oddB: a,
          });
        }
      } else if (mk.type === 'total') {
        const over = mk.prices.find((p) => p.designation === 'over');
        const under = mk.prices.find((p) => p.designation === 'under');
        const oOver = dec(over?.price);
        const oUnder = dec(under?.price);
        const linha = over?.points;
        if (ok(oOver) && ok(oUnder) && typeof linha === 'number' && linhaArbitravel(linha)) {
          out.push({
            esporte, evento: eventoStr, dataHora,
            mercado: TOTAL_LABEL[sportId] || 'Total',
            linha,
            opcaoA: rotuloOver(linha),
            opcaoB: rotuloUnder(linha),
            oddA: oOver, oddB: oUnder,
          });
        }
      } else if (mk.type === 'spread') {
        const hp = mk.prices.find((p) => p.designation === 'home');
        const ap = mk.prices.find((p) => p.designation === 'away');
        const oH = dec(hp?.price);
        const oA = dec(ap?.price);
        const linha = hp?.points;
        if (ok(oH) && ok(oA) && typeof linha === 'number' && linhaArbitravel(linha)) {
          const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
          out.push({
            esporte, evento: eventoStr, dataHora,
            // Em e-sports o spread de jogo completo é handicap de MAPAS → normaliza p/ HANDICAP_MAPAS;
            // no vôlei é handicap de SETS (HANDICAP_LABEL).
            mercado: ehEsports ? 'Handicap de Mapas' : HANDICAP_LABEL[sportId] || 'Handicap',
            linha,
            opcaoA: `${home} (${sinal(linha)})`,
            opcaoB: `${away} (${sinal(-linha)})`,
            oddA: oH, oddB: oA,
          });
        }
      }
    }
    return out;
  }
}
