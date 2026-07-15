import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder } from '../arbitrage/markets';
import { fetchTextoComRetry } from '../utils/http';

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

// esporte interno → Pinnacle sportId (descoberto: Soccer=29, Tennis=33, Basketball=4).
const SPORT_ID: Record<string, number> = {
  Futebol: 29,
  Tenis: 33,
  Tênis: 33,
  Basquete: 4,
};
const SPORT_LABEL: Record<number, string> = { 29: 'Futebol', 33: 'Tenis', 4: 'Basquete' };
// Rótulo do total por esporte, para o assunto normalizar certo (gols/games/pontos).
const TOTAL_LABEL: Record<number, string> = { 29: 'Total de Gols', 33: 'Total de Games', 4: 'Total de Pontos' };

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
}

export class PinnacleScraper implements OddsScraper {
  private maxEventosPorEsporte = 25;

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

  /** Odds americanas → decimais. */
  private americanoParaDecimal(price: number): number {
    if (!Number.isFinite(price) || price === 0) return NaN;
    return price > 0 ? price / 100 + 1 : 100 / Math.abs(price) + 1;
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(`🤖 [Pinnacle] Extração via API arcadia (guest)...`);
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

  private async extrairEsporte(sportId: number): Promise<ScrapedOdd[]> {
    const rMatch = await fetchTextoComRetry(
      `${BASE}/sports/${sportId}/matchups?withSpecials=false&brandId=0`,
      { headers: this.headers() },
      3,
      'Pinnacle/match'
    );
    if (rMatch.status !== 200) throw new Error(`matchups HTTP ${rMatch.status}`);
    const matchups: PinMatchup[] = JSON.parse(rMatch.body);

    // Só jogos "raiz" (sem parentId) com 2 participantes; os mais próximos primeiro.
    const eventos = matchups
      .filter((m) => !m.parentId && (m.participants?.length || 0) >= 2)
      .sort((a, b) => (Date.parse(a.startTime || '') || 0) - (Date.parse(b.startTime || '') || 0))
      .slice(0, this.maxEventosPorEsporte);

    const odds: ScrapedOdd[] = [];
    for (const ev of eventos) {
      try {
        const parsed = await this.extrairMercadosEvento(ev, sportId);
        odds.push(...parsed);
      } catch {
        /* evento sem mercados — ignora */
      }
    }
    return odds;
  }

  private async extrairMercadosEvento(ev: PinMatchup, sportId: number): Promise<ScrapedOdd[]> {
    const home = ev.participants?.find((p) => p.alignment === 'home')?.name;
    const away = ev.participants?.find((p) => p.alignment === 'away')?.name;
    if (!home || !away) return [];

    const r = await fetchTextoComRetry(
      `${BASE}/matchups/${ev.id}/markets/related/straight`,
      { headers: this.headers() },
      2,
      'Pinnacle/mkt'
    );
    if (r.status !== 200) return [];
    const markets: PinMarket[] = JSON.parse(r.body);

    const esporte = SPORT_LABEL[sportId] || String(sportId);
    const dataHora = ev.startTime || 'Hoje';
    const eventoStr = `${home} vs ${away}`;
    const dec = (p?: number) => (typeof p === 'number' ? this.americanoParaDecimal(p) : NaN);
    const ok = (n: number) => Number.isFinite(n) && n > 1;
    const out: ScrapedOdd[] = [];

    for (const mk of markets) {
      if (mk.period !== 0 || mk.status === 'closed') continue; // só jogo completo, mercado aberto

      if (mk.type === 'moneyline') {
        const h = dec(mk.prices.find((p) => p.designation === 'home')?.price);
        const a = dec(mk.prices.find((p) => p.designation === 'away')?.price);
        const d = dec(mk.prices.find((p) => p.designation === 'draw')?.price);
        if (Number.isFinite(d) && d > 1) {
          // 3-way (futebol) → dupla chance sintética
          if (ok(h) && ok(a)) {
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
        if (ok(oOver) && ok(oUnder) && typeof linha === 'number') {
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
        if (ok(oH) && ok(oA) && typeof linha === 'number') {
          const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
          out.push({
            esporte, evento: eventoStr, dataHora,
            mercado: 'Handicap',
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
