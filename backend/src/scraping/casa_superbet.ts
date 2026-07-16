import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder } from '../arbitrage/markets';
import { fetchTextoComRetry } from '../utils/http';

/**
 * Superbet (BR) — via API de oferta própria (Fastly), pública e sem proteção
 * anti-bot (descoberto no recon). Substitui o antigo scraper de DOM.
 *
 *  - /events/by-date?...&sportId=X  → lista de eventos com o mercado principal
 *    (Vencedor/Resultado Final) embutido em `odds` (preços já decimais).
 *  - /events/{eventId}              → TODOS os mercados do evento (Total de Gols,
 *    Handicap, etc.). Buscamos só de um subconjunto (custo ~270KB/evento).
 *
 * Nome do confronto vem como "Casa·Fora" (ponto médio). Odds já são decimais.
 */

const BASE = 'https://production-superbet-offer-br.freetls.fastly.net/v2/pt-BR';

// esporte interno → sportId da Superbet (confirmado: 5=Futebol, 2=Tenis, 4=Basquete).
const SPORT_ID: Record<string, number> = {
  Futebol: 5,
  Tenis: 2,
  Tênis: 2,
  Basquete: 4,
};
const SPORT_LABEL: Record<number, string> = { 5: 'Futebol', 2: 'Tenis', 4: 'Basquete' };

// Mercado de total DA PARTIDA por esporte (nome exato) — evita props de jogador.
const TOTAL_CFG: Record<number, { market: string; label: string }> = {
  5: { market: 'Total de Gols', label: 'Total de Gols' },
  4: { market: 'Total de Pontos (Inc. prorrogação)', label: 'Total de Pontos' },
};

interface SbOdd {
  price: number;
  status?: string;
  code?: string;
  name?: string;
  marketName?: string;
  specialBetValue?: string;
  info?: string;
}
interface SbEvent {
  eventId: number;
  matchName: string;
  matchDate?: string;
  sportId?: number;
  odds?: SbOdd[];
  marketCount?: number;
}

export class SuperbetScraper implements OddsScraper {
  private maxEventosPorEsporte = 40;
  private maxEventosDetalhe = 30; // quantos eventos buscar mercados completos (Total)

  getNome(): string {
    return 'Superbet';
  }

  private headers() {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: 'https://superbet.bet.br/',
      Origin: 'https://superbet.bet.br',
    };
  }

  private fmtData(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}+${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
  }

  private evento(matchName: string): [string, string] | null {
    const parts = (matchName || '').split('·');
    if (parts.length !== 2) return null;
    const home = parts[0].trim();
    const away = parts[1].trim();
    if (!home || !away) return null;
    return [home, away];
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(`🤖 [Superbet] Extração via API de oferta (Fastly)...`);
    const todas: ScrapedOdd[] = [];
    for (const esporte of esportes) {
      const sid = SPORT_ID[esporte];
      if (!sid) continue;
      try {
        const odds = await this.extrairEsporte(sid);
        console.log(`   [Superbet] ${esporte}: ${odds.length} odds`);
        todas.push(...odds);
      } catch (err: any) {
        console.error(`   ⚠️ [Superbet] Falha em ${esporte}: ${err.message}`);
      }
    }
    console.log(`✅ [Superbet] Total: ${todas.length} odds.`);
    return todas;
  }

  private async extrairEsporte(sportId: number): Promise<ScrapedOdd[]> {
    const now = new Date();
    const end = new Date(now.getTime() + 48 * 3600 * 1000);
    const url = `${BASE}/events/by-date?currentStatus=active&offerState=prematch&startDate=${this.fmtData(now)}&endDate=${this.fmtData(end)}&sportId=${sportId}`;
    const r = await fetchTextoComRetry(url, { headers: this.headers() }, 3, 'Superbet/list');
    if (r.status !== 200) throw new Error(`by-date HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    const agora = Date.now();
    const eventos: SbEvent[] = (j.data || j || [])
      // offerState=prematch já exclui ao vivo; reforça descartando início no passado.
      .filter((ev: SbEvent) => {
        const t = Date.parse((ev.matchDate || '').replace(' ', 'T') + 'Z');
        return isNaN(t) || t > agora;
      })
      .slice(0, this.maxEventosPorEsporte);

    const odds: ScrapedOdd[] = [];

    // 1) Mercado principal (match winner) de TODOS os eventos — barato.
    for (const ev of eventos) {
      const mw = this.parseMatchWinner(ev, sportId);
      if (mw) odds.push(mw);
    }

    // 2) Mercados completos (Total de Gols) de um subconjunto.
    const detalhe = eventos.slice(0, this.maxEventosDetalhe);
    for (const ev of detalhe) {
      try {
        const extras = await this.extrairMercadosEvento(ev.eventId, sportId);
        odds.push(...extras);
      } catch {
        /* evento sem detalhe — ignora */
      }
    }
    return odds;
  }

  private parseMatchWinner(ev: SbEvent, sportId: number): ScrapedOdd | null {
    const par = this.evento(ev.matchName);
    if (!par) return null;
    const [home, away] = par;
    const esporte = SPORT_LABEL[sportId] || String(sportId);
    const dataHora = ev.matchDate || 'Hoje';

    const ativos = (ev.odds || []).filter((o) => o.status === 'active' && o.price > 1);
    const one = ativos.find((o) => o.code === '1');
    const cross = ativos.find((o) => o.code === '0' || (o.name || '').toUpperCase() === 'X');
    const two = ativos.find((o) => o.code === '2');
    if (!one || !two) return null;

    // 3-way (futebol): dupla chance sintética (mesma técnica da Blaze/Kambi).
    if (cross && cross.price > 1) {
      return {
        esporte, evento: `${home} vs ${away}`, dataHora,
        mercado: 'Resultado Final',
        opcaoA: `Vitória ${home}`,
        opcaoB: `${away} ou Empate`,
        oddA: one.price,
        oddB: 1 / (1 / cross.price + 1 / two.price),
      };
    }
    // 2-way: direto.
    return {
      esporte, evento: `${home} vs ${away}`, dataHora,
      mercado: 'Resultado Final',
      opcaoA: home,
      opcaoB: away,
      oddA: one.price,
      oddB: two.price,
    };
  }

  private async extrairMercadosEvento(eventId: number, sportId: number): Promise<ScrapedOdd[]> {
    const r = await fetchTextoComRetry(`${BASE}/events/${eventId}`, { headers: this.headers() }, 2, 'Superbet/ev');
    if (r.status !== 200) return [];
    const j = JSON.parse(r.body);
    const ev: SbEvent = (j.data || j || [])[0];
    if (!ev) return [];
    const par = this.evento(ev.matchName);
    if (!par) return [];
    const [home, away] = par;
    const esporte = SPORT_LABEL[sportId] || String(sportId);
    const dataHora = ev.matchDate || 'Hoje';
    const eventoStr = `${home} vs ${away}`;

    const out: ScrapedOdd[] = [];

    // Total DA PARTIDA (gols/pontos por esporte): agrupa por specialBetValue (linha) → Over/Under.
    const cfg = TOTAL_CFG[sportId];
    if (!cfg) return out;
    const totais = (ev.odds || []).filter((o) => o.marketName === cfg.market && o.status === 'active');
    const porLinha = new Map<string, { over?: SbOdd; under?: SbOdd }>();
    for (const o of totais) {
      const sbv = o.specialBetValue || '';
      if (!sbv) continue;
      const g = porLinha.get(sbv) || {};
      if (/mais de/i.test(o.name || '')) g.over = o;
      else if (/menos de/i.test(o.name || '')) g.under = o;
      porLinha.set(sbv, g);
    }
    for (const [sbv, g] of porLinha) {
      if (g.over && g.under && g.over.price > 1 && g.under.price > 1) {
        const linha = Number(sbv);
        if (!Number.isFinite(linha)) continue;
        out.push({
          esporte, evento: eventoStr, dataHora,
          mercado: cfg.label,
          linha,
          opcaoA: rotuloOver(linha),
          opcaoB: rotuloUnder(linha),
          oddA: g.over.price,
          oddB: g.under.price,
        });
      }
    }

    // --- BTTS / Ambas as Equipes Marcam (futebol): Sim/Não ---
    const btts = (ev.odds || []).filter((o) => o.marketName === 'Ambas as Equipes Marcam' && o.status === 'active');
    const sim = btts.find((o) => /^sim$/i.test(o.name || ''));
    const nao = btts.find((o) => /^n[aã]o$/i.test(o.name || ''));
    if (sim && nao && sim.price > 1 && nao.price > 1) {
      out.push({
        esporte, evento: eventoStr, dataHora, mercado: 'Ambas equipes marcam',
        opcaoA: 'Sim', opcaoB: 'Não', oddA: sim.price, oddB: nao.price,
      });
    }

    // --- DNB / Empate Anula Aposta (futebol): home vs away (code 1/2) ---
    const dnb = (ev.odds || []).filter((o) => o.marketName === 'Empate Anula Aposta' && o.status === 'active');
    const dHome = dnb.find((o) => o.code === '1');
    const dAway = dnb.find((o) => o.code === '2');
    if (dHome && dAway && dHome.price > 1 && dAway.price > 1) {
      out.push({
        esporte, evento: eventoStr, dataHora, mercado: 'Empate Anula',
        opcaoA: home, opcaoB: away, oddA: dHome.price, oddB: dAway.price,
      });
    }

    return out;
  }
}
