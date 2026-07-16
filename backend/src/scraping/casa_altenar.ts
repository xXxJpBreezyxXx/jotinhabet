import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder } from '../arbitrage/markets';
import { fetchTextoComRetry } from '../utils/http';

/**
 * Scraper para casas na plataforma Altenar servidas pelo widget "sb2" (biahosted) —
 * ex.: Aposta1, BetPix365. API PÚBLICA (sem login), descoberta via recon+browser.
 *
 * Estrutura RELACIONAL (join por id):
 *  - GetClickableSportMenu?sportId=X → campeonatos {id, eventsCount}.
 *  - widget/GetEvents?champIds=a,b   → { events, markets, odds, competitors }.
 *    event.marketIds → markets(id) → market.oddIds → odds(id). odds em DECIMAL.
 *    Total: market.name "Total", linha no campo `sv`; odds "Mais de X"/"Menos de X".
 *    1x2: 3 odds (casa/empate/fora por competitorId) → dupla chance sintética.
 *  (Handicap não vem neste endpoint — exigiria detalhe por evento; fica p/ depois.)
 */

interface AltenarConfig {
  nome: string;
  integration: string; // ex: 'aposta1'
  referer: string; // ex: 'https://www.aposta1.bet.br/'
  maxCampeonatosPorEsporte?: number; // default 20 (maiores ligas)
}

interface AltCompetitor { id: number; name: string; }
interface AltOdd { id: number; price: number; name?: string; competitorId?: number; typeId?: number; oddStatus?: number; }
interface AltMarket { id: number; name?: string; sv?: string; oddIds?: number[]; }
interface AltEvent {
  id: number; name?: string; startDate?: string; sportId?: number;
  competitorIds?: number[]; marketIds?: number[]; status?: number;
}
interface AltSport { id: number; catIds?: number[]; }
interface AltCategory { id: number; champIds?: number[]; }
interface AltChamp { id: number; name?: string; eventsCount?: number; }
interface AltResp {
  events?: AltEvent[]; markets?: AltMarket[]; odds?: AltOdd[]; competitors?: AltCompetitor[];
  champs?: AltChamp[]; sports?: AltSport[]; categories?: AltCategory[];
}

const SPORT_ID: Record<string, number> = { Futebol: 66, Basquete: 67, Tenis: 68, Tênis: 68 };
const SPORT_LABEL: Record<number, string> = { 66: 'Futebol', 67: 'Basquete', 68: 'Tenis' };
const TOTAL_LABEL: Record<number, string> = { 66: 'Total de Gols', 67: 'Total de Pontos', 68: 'Total de Games' };

export class AltenarWidgetScraper implements OddsScraper {
  private cfg: Required<AltenarConfig>;
  private readonly F = 'https://sb2frontend-altenar2.biahosted.com/api';

  constructor(cfg: AltenarConfig) {
    this.cfg = { maxCampeonatosPorEsporte: 20, ...cfg };
  }

  getNome(): string {
    return this.cfg.nome;
  }

  private q(): string {
    return `culture=pt-BR&timezoneOffset=180&integration=${this.cfg.integration}&deviceType=1&numFormat=en-GB&countryCode=BR`;
  }
  private headers() {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: this.cfg.referer,
      Origin: this.cfg.referer.replace(/\/$/, ''),
    };
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(`🤖 [${this.cfg.nome}] Extração via Altenar widget (biahosted)...`);
    const todas: ScrapedOdd[] = [];
    const vistos = new Set<number>(); // dedupe de eventos entre esportes
    // O menu do Altenar IGNORA o param sportId (retorna tudo); busca 1x e filtra os
    // campeonatos por esporte via a cadeia sport.catIds → category.champIds → champ.id.
    let menu: AltResp;
    try {
      const menuResp = await fetchTextoComRetry(
        `${this.F}/widget/GetClickableSportMenu?${this.q()}`, { headers: this.headers() }, 3, `${this.cfg.nome}/menu`
      );
      menu = JSON.parse(menuResp.body);
    } catch (e: any) {
      console.error(`   ⚠️ [${this.cfg.nome}] menu falhou: ${e.message}`);
      return todas;
    }
    for (const esporte of esportes) {
      const sid = SPORT_ID[esporte];
      if (!sid) continue;
      try {
        const odds = await this.extrairEsporte(sid, menu, vistos);
        console.log(`   [${this.cfg.nome}] ${esporte}: ${odds.length} odds`);
        todas.push(...odds);
      } catch (err: any) {
        console.error(`   ⚠️ [${this.cfg.nome}] Falha em ${esporte}: ${err.message}`);
      }
    }
    console.log(`✅ [${this.cfg.nome}] Total: ${todas.length} odds.`);
    return todas;
  }

  private async extrairEsporte(sportId: number, menu: AltResp, vistos: Set<number>): Promise<ScrapedOdd[]> {
    // Campeonatos DESTE esporte: sport.catIds → categories.champIds → champ.
    const sport = (menu.sports || []).find((s) => s.id === sportId);
    if (!sport) return [];
    const catIds = new Set(sport.catIds || []);
    const champIdsDoEsporte = new Set<number>();
    for (const cat of menu.categories || []) {
      if (catIds.has(cat.id)) (cat.champIds || []).forEach((id) => champIdsDoEsporte.add(id));
    }
    const champs = (menu.champs || [])
      .filter((c) => champIdsDoEsporte.has(c.id) && (c.eventsCount || 0) > 0)
      .sort((a, b) => (b.eventsCount || 0) - (a.eventsCount || 0))
      .slice(0, this.cfg.maxCampeonatosPorEsporte);

    const odds: ScrapedOdd[] = [];
    // 2) Eventos por campeonato (em lotes de 5 champIds).
    for (let i = 0; i < champs.length; i += 5) {
      const ids = champs.slice(i, i + 5).map((c: any) => c.id).join(',');
      let resp;
      try {
        resp = await fetchTextoComRetry(`${this.F}/widget/GetEvents?${this.q()}&champIds=${ids}`, { headers: this.headers() }, 2, `${this.cfg.nome}/ev`);
      } catch { continue; }
      if (resp.status !== 200) continue;
      const j: AltResp = JSON.parse(resp.body);
      this.parseResposta(j, odds, vistos);
    }
    return odds;
  }

  private parseResposta(j: AltResp, out: ScrapedOdd[], vistos: Set<number>): void {
    const comp = new Map<number, string>((j.competitors || []).map((c) => [c.id, c.name]));
    const oddById = new Map<number, AltOdd>((j.odds || []).map((o) => [o.id, o]));
    const mktById = new Map<number, AltMarket>((j.markets || []).map((m) => [m.id, m]));
    const agora = Date.now();
    const ehMeiaLinha = (l: number) => Math.abs(l % 1) === 0.5;
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;

    for (const ev of j.events || []) {
      if (vistos.has(ev.id)) continue;
      vistos.add(ev.id);
      // Rotula pelo esporte REAL do evento (o menu por sportId às vezes mistura esportes,
      // ex.: NFL sportId 75). Só mantém futebol/basquete/tênis.
      const espId = ev.sportId || 0;
      const esporte = SPORT_LABEL[espId];
      if (!esporte) continue;
      const cids = ev.competitorIds || [];
      if (cids.length !== 2) continue;
      const home = comp.get(cids[0]);
      const away = comp.get(cids[1]);
      if (!home || !away) continue;
      // Só PRÉ-JOGO.
      const t = Date.parse(ev.startDate || '');
      if (!isNaN(t) && t <= agora) continue;
      const evento = `${home} vs ${away}`;
      const dataHora = ev.startDate || 'Hoje';

      for (const mid of ev.marketIds || []) {
        const m = mktById.get(mid);
        if (!m) continue;
        const oddsM = (m.oddIds || []).map((id) => oddById.get(id)).filter(Boolean) as AltOdd[];
        const ativa = (o?: AltOdd) => o && o.price > 1 && o.oddStatus !== 1;
        // Nome base sem o sufixo "(incluindo Prorrogação)" — normaliza futebol/basquete/tênis.
        const base = (m.name || '').replace(/\s*\(incluindo prorroga[cç][aã]o\)\s*/i, '').trim();

        // --- Resultado Final (1x2 3-way / Vencedor 2-way) ---
        if (base === '1x2' || base === 'Vencedor') {
          const oHome = oddsM.find((o) => o.competitorId === cids[0]);
          const oAway = oddsM.find((o) => o.competitorId === cids[1]);
          const oDraw = oddsM.find((o) => !o.competitorId || /empate|draw|^x$/i.test(o.name || ''));
          if (!ativa(oHome) || !ativa(oAway)) continue;
          if (oDraw && ativa(oDraw)) {
            out.push({
              esporte, evento, dataHora, mercado: 'Resultado Final',
              opcaoA: `Vitória ${home}`, opcaoB: `${away} ou Empate`,
              oddA: oHome!.price, oddB: 1 / (1 / oDraw!.price + 1 / oAway!.price),
            });
          } else {
            out.push({
              esporte, evento, dataHora, mercado: 'Resultado Final',
              opcaoA: home, opcaoB: away, oddA: oHome!.price, oddB: oAway!.price,
            });
          }
        }

        // --- Total DA PARTIDA (Over/Under), linha em sv. "base" exatamente "Total"
        //     exclui "Total de escanteios", "X total" (por-time), "Nº tempo - total". ---
        else if (base === 'Total' && m.sv) {
          const linha = parseFloat(m.sv);
          if (!Number.isFinite(linha) || !ehMeiaLinha(linha)) continue;
          const over = oddsM.find((o) => /mais/i.test(o.name || ''));
          const under = oddsM.find((o) => /menos/i.test(o.name || ''));
          if (!ativa(over) || !ativa(under)) continue;
          out.push({
            esporte, evento, dataHora, mercado: TOTAL_LABEL[espId] || 'Total',
            linha, opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
            oddA: over!.price, oddB: under!.price,
          });
        }

        // --- Handicap Asiático 2-way (home/away com sinal), linha em sv, só meia-linha ---
        else if (base === 'Handicap' && m.sv) {
          const linha = parseFloat(m.sv); // linha do mandante
          if (!Number.isFinite(linha) || !ehMeiaLinha(linha)) continue;
          const oHome = oddsM.find((o) => o.competitorId === cids[0]);
          const oAway = oddsM.find((o) => o.competitorId === cids[1]);
          if (!ativa(oHome) || !ativa(oAway)) continue;
          out.push({
            esporte, evento, dataHora, mercado: 'Handicap', linha,
            opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
            oddA: oHome!.price, oddB: oAway!.price,
          });
        }

        // --- Ambas equipes marcam (BTTS): Sim/Não ---
        else if (base === 'Ambas equipes marcam') {
          const sim = oddsM.find((o) => /^sim$/i.test(o.name || ''));
          const nao = oddsM.find((o) => /^n[aã]o$/i.test(o.name || ''));
          if (!ativa(sim) || !ativa(nao)) continue;
          out.push({
            esporte, evento, dataHora, mercado: 'Ambas equipes marcam',
            opcaoA: 'Sim', opcaoB: 'Não', oddA: sim!.price, oddB: nao!.price,
          });
        }

        // --- DNB / Empate devolve aposta: home vs away (empate reembolsa) ---
        else if (base === 'Empate devolve aposta') {
          const oHome = oddsM.find((o) => o.competitorId === cids[0]);
          const oAway = oddsM.find((o) => o.competitorId === cids[1]);
          if (!ativa(oHome) || !ativa(oAway)) continue;
          out.push({
            esporte, evento, dataHora, mercado: 'Empate Anula',
            opcaoA: home, opcaoB: away, oddA: oHome!.price, oddB: oAway!.price,
          });
        }
      }
    }
  }
}

/** Aposta1 — Altenar widget, integration "aposta1". */
export class Aposta1Scraper extends AltenarWidgetScraper {
  constructor() {
    super({ nome: 'Aposta1', integration: 'aposta1', referer: 'https://www.aposta1.bet.br/' });
  }
}
