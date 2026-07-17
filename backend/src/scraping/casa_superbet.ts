import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
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
// E-Sports: sportIds por jogo (confirmado ao vivo: 39=LoL, 54=Dota 2, 55=CS2/Valorant).
const ESPORTS_SPORT_IDS = [39, 54, 55];
const SPORT_LABEL: Record<number, string> = {
  5: 'Futebol',
  2: 'Tenis',
  4: 'Basquete',
  39: 'Esports',
  54: 'Esports',
  55: 'Esports',
};

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
      // E-Sports varre 3 sportIds (LoL/Dota/CS2+Valorant); demais, 1 só.
      const ehEsports = /^e-?sports?$/i.test(esporte);
      const ids = ehEsports ? ESPORTS_SPORT_IDS : (SPORT_ID[esporte] ? [SPORT_ID[esporte]] : []);
      if (!ids.length) continue;
      for (const sid of ids) {
        try {
          const odds = await this.extrairEsporte(sid);
          if (odds.length) console.log(`   [Superbet] ${esporte} (sportId ${sid}): ${odds.length} odds`);
          todas.push(...odds);
        } catch (err: any) {
          console.error(`   ⚠️ [Superbet] Falha em ${esporte}/${sid}: ${err.message}`);
        }
      }
    }
    console.log(`✅ [Superbet] Total: ${todas.length} odds.`);
    return todas;
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): odds atuais de UM evento, 2-3 requests
   * (by-date do esporte + detalhe só do evento casado). Reusa os parsers de produção.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const ehEsports = /^e-?sports?$/i.test(esporte || '');
    const sids = ehEsports
      ? ESPORTS_SPORT_IDS
      : esporte && SPORT_ID[esporte]
        ? [SPORT_ID[esporte]]
        : [...new Set(Object.values(SPORT_ID))];
    const now = new Date();
    const end = new Date(now.getTime() + 48 * 3600 * 1000);
    for (const sid of sids) {
      try {
        const url = `${BASE}/events/by-date?currentStatus=active&offerState=prematch&startDate=${this.fmtData(now)}&endDate=${this.fmtData(end)}&sportId=${sid}`;
        const r = await fetchTextoComRetry(url, { headers: this.headers() }, 1, 'Superbet/reval', 10000);
        if (r.status !== 200) continue;
        const agora = Date.now();
        const evs: SbEvent[] = ((JSON.parse(r.body).data || []) as SbEvent[])
          // Mesmo filtro da varredura: só PRÉ-JOGO (início no futuro).
          .filter((ev) => {
            const t = Date.parse((ev.matchDate || '').replace(' ', 'T') + 'Z');
            return isNaN(t) || t > agora;
          })
          .filter((ev) => {
            const par = this.evento(ev.matchName);
            return !!par && areEventsSame(`${par[0]} vs ${par[1]}`, evento);
          })
          .slice(0, 2);
        const odds: ScrapedOdd[] = [];
        for (const ev of evs) {
          const mw = this.parseMatchWinner(ev, sid);
          if (mw) odds.push(mw);
          try {
            odds.push(...(ehEsports ? await this.extrairMercadosEsports(ev.eventId) : await this.extrairMercadosEvento(ev.eventId, sid)));
          } catch { /* segue */ }
        }
        if (odds.length) return odds;
      } catch {
        /* tenta o próximo esporte */
      }
    }
    return [];
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

    // 2) Mercados completos de um subconjunto. Em e-sports os mercados são outros
    //    (mapas/rounds) → parser dedicado; nos demais, o de bola (gols/pontos/BTTS/DNB).
    const ehEsports = ESPORTS_SPORT_IDS.includes(sportId);
    const detalhe = eventos.slice(0, this.maxEventosDetalhe);
    for (const ev of detalhe) {
      try {
        const extras = ehEsports
          ? await this.extrairMercadosEsports(ev.eventId)
          : await this.extrairMercadosEvento(ev.eventId, sportId);
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

    // 3-way: dupla chance sintética (futebol). Diretrizes §5: e-sports não admite
    // 1X2/3-vias → descarta (o "Vencedor" de e-sports é 2-vias e cai no fluxo direto).
    if (cross && cross.price > 1) {
      if (ESPORTS_SPORT_IDS.includes(sportId)) return null;
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

  /**
   * Mercados de E-Sports de um evento (Diretrizes §5 — só 2-vias da whitelist):
   *  - Vencedor de mapa ("X° Mapa - Vencedor", nº do mapa no sv "1"/"2"/"3") → "Mapa N".
   *  - Total de Mapas (sv = linha, ex.: 2.5) → over/under.
   *  - Handicap de Mapas (sv = linha do mandante, ex.: -1.5) → home/away com sinal.
   * O match-winner vem do endpoint de lista (parseMatchWinner); aqui não se repete.
   * Combos/exato/kills/pistola (sv composto "1-20.5", "Resultado Correto…", "Jogador…")
   * são ignorados por não serem 2-vias limpas / caírem na blacklist das Diretrizes.
   * NOTA: o Handicap de Mapas ficou desativado até 2026-07-17 por causa de um bug do
   * motor (pareava pernas de mesmo sinal → ROI falso ~40%); com o motor sign-aware
   * (engine.ts alinharAoCluster), foi reabilitado — a Superbet expõe as 2 perspectivas
   * (sv +1.5 e -1.5) e o motor separa a espelhada em cluster próprio.
   */
  private async extrairMercadosEsports(eventId: number): Promise<ScrapedOdd[]> {
    const r = await fetchTextoComRetry(`${BASE}/events/${eventId}`, { headers: this.headers() }, 2, 'Superbet/ev-es');
    if (r.status !== 200) return [];
    const j = JSON.parse(r.body);
    const ev: SbEvent = (j.data || j || [])[0];
    if (!ev) return [];
    const par = this.evento(ev.matchName);
    if (!par) return [];
    const [home, away] = par;
    const dataHora = ev.matchDate || 'Hoje';
    const eventoStr = `${home} vs ${away}`;
    const esporte = 'Esports';
    const ehMeiaLinha = (l: number) => Math.abs(l % 1) === 0.5;
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
    const ativos = (ev.odds || []).filter((o) => o.status === 'active' && o.price > 1);
    const out: ScrapedOdd[] = [];

    // 1) Vencedor de mapa: nome contém "Mapa" + "Vencedor", sv = nº do mapa (inteiro puro).
    //    Exclui combos/exato/dupla-chance (sv composto ou palavras extras no nome).
    const mapaWin = new Map<string, { home?: SbOdd; away?: SbOdd }>();
    for (const o of ativos) {
      const mn = o.marketName || '';
      if (!/mapa/i.test(mn) || !/vencedor/i.test(mn)) continue;
      if (/&|total|round|rodada|dupla|1x2|resultado|margem|corret|kill/i.test(mn)) continue;
      const sv = o.specialBetValue || '';
      if (!/^\d+$/.test(sv)) continue; // mapa puro (combos usam sv tipo "1-20.5")
      const g = mapaWin.get(sv) || {};
      if (o.code === '1') g.home = o;
      else if (o.code === '2') g.away = o;
      mapaWin.set(sv, g);
    }
    for (const [sv, g] of mapaWin) {
      if (g.home && g.away) {
        out.push({
          esporte, evento: eventoStr, dataHora, mercado: `Mapa ${sv}`,
          opcaoA: home, opcaoB: away, oddA: g.home.price, oddB: g.away.price,
        });
      }
    }

    // 2) Total de Mapas (over/under), sv = linha (meia-linha).
    const totMapas = new Map<string, { over?: SbOdd; under?: SbOdd }>();
    for (const o of ativos) {
      if ((o.marketName || '') !== 'Total de Mapas') continue;
      const sv = o.specialBetValue || '';
      const g = totMapas.get(sv) || {};
      if (o.code === '+' || /mais de/i.test(o.name || '')) g.over = o;
      else if (o.code === '-' || /menos de/i.test(o.name || '')) g.under = o;
      totMapas.set(sv, g);
    }
    for (const [sv, g] of totMapas) {
      const linha = Number(sv);
      if (g.over && g.under && Number.isFinite(linha) && ehMeiaLinha(linha)) {
        out.push({
          esporte, evento: eventoStr, dataHora, mercado: 'Total de Mapas', linha,
          opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
          oddA: g.over.price, oddB: g.under.price,
        });
      }
    }

    // 3) Handicap de Mapas (home/away com sinal), sv = linha do mandante (meia-linha).
    //    O motor sign-aware garante que só cruza a perna complementar (mesmo |linha|,
    //    times/sinais opostos) — a perspectiva espelhada da Superbet vira cluster próprio.
    const hcpMapas = new Map<string, { home?: SbOdd; away?: SbOdd }>();
    for (const o of ativos) {
      if ((o.marketName || '') !== 'Handicap de Mapas') continue;
      const sv = o.specialBetValue || '';
      const g = hcpMapas.get(sv) || {};
      if (o.code === '1') g.home = o;
      else if (o.code === '2') g.away = o;
      hcpMapas.set(sv, g);
    }
    for (const [sv, g] of hcpMapas) {
      const linha = parseFloat(sv);
      if (g.home && g.away && Number.isFinite(linha) && ehMeiaLinha(linha)) {
        out.push({
          esporte, evento: eventoStr, dataHora, mercado: 'Handicap de Mapas', linha,
          opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
          oddA: g.home.price, oddB: g.away.price,
        });
      }
    }

    return out;
  }
}
