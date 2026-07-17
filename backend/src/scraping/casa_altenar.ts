import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
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
  maxCampeonatosPorEsporte?: number; // default 40 (maiores ligas)
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

// sportId 145 = E-Sports (confirmado ao vivo: VCT/Valorant, Esports World Cup, etc.).
// Neste endpoint só vem o mercado principal (Vencedor da partida) para e-sports.
// 69=Vôlei, 77=Tênis de Mesa, 76=Beisebol (confirmados no menu ao vivo; vôlei/mesa
// expõem "Total pontos"/"Handicap pontos", beisebol "Total/Handicap/Vencedor
// (incluindo innings extra)").
const SPORT_ID: Record<string, number> = {
  Futebol: 66, Basquete: 67, Tenis: 68, Tênis: 68, Esports: 145,
  Volei: 69, 'Vôlei': 69,
  TenisDeMesa: 77, 'Tenis de Mesa': 77, 'Tênis de Mesa': 77,
  Beisebol: 76,
};
const SPORT_LABEL: Record<number, string> = {
  66: 'Futebol', 67: 'Basquete', 68: 'Tenis', 145: 'Esports',
  69: 'Volei', 77: 'Tenis de Mesa', 76: 'Beisebol',
};
const TOTAL_LABEL: Record<number, string> = {
  66: 'Total de Gols', 67: 'Total de Pontos', 68: 'Total de Games',
  69: 'Total de Pontos', 77: 'Total de Pontos', 76: 'Total de Corridas',
};

export class AltenarWidgetScraper implements OddsScraper {
  private cfg: Required<AltenarConfig>;
  private readonly F = 'https://sb2frontend-altenar2.biahosted.com/api';

  constructor(cfg: AltenarConfig) {
    this.cfg = { maxCampeonatosPorEsporte: 40, ...cfg };
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

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): odds atuais de UM evento. A API do widget
   * só busca por campeonato, então re-extrai o esporte (menu + lotes) e filtra o evento
   * — ~5 requests. Reusa o parser de produção.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    try {
      const menuResp = await fetchTextoComRetry(
        `${this.F}/widget/GetClickableSportMenu?${this.q()}`, { headers: this.headers() }, 1, `${this.cfg.nome}/reval-menu`, 10000
      );
      const menu: AltResp = JSON.parse(menuResp.body);
      const sids = esporte && SPORT_ID[esporte] ? [SPORT_ID[esporte]] : [...new Set(Object.values(SPORT_ID))];
      for (const sid of sids) {
        const odds = await this.extrairEsporte(sid, menu, new Set());
        const doEvento = odds.filter((o) => areEventsSame(o.evento, evento));
        if (doEvento.length) return doEvento;
      }
    } catch {
      /* melhor esforço */
    }
    return [];
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
    // Meia-linha e quarter asiática (.25/.75); inteira barrada (push). Piso da
    // quarter aplicado no engine.
    const ehLinhaOk = (l: number) => linhaArbitravel(l);
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
        // Nome base sem o sufixo "(incluindo Prorrogação)" / "(incluindo innings extra)"
        // — normaliza futebol/basquete/tênis/beisebol. (Ambos os sufixos indicam a
        // convenção padrão de liquidação do esporte, então remover não muda o mercado.)
        const base = (m.name || '').replace(/\s*\(incluindo (?:prorroga[cç][aã]o|innings? extras?)\)\s*/i, '').trim();

        // --- Resultado Final (1x2 3-way / Vencedor 2-way; e-sports: "Vencedor da partida") ---
        if (base === '1x2' || base === 'Vencedor' || base === 'Vencedor da partida') {
          const oHome = oddsM.find((o) => o.competitorId === cids[0]);
          const oAway = oddsM.find((o) => o.competitorId === cids[1]);
          const oDraw = oddsM.find((o) => !o.competitorId || /empate|draw|^x$/i.test(o.name || ''));
          if (!ativa(oHome) || !ativa(oAway)) continue;
          if (oDraw && ativa(oDraw)) {
            // Diretrizes §5: e-sports não admite 1X2/3-vias (empate de BO2) → descarta.
            if (esporte === 'Esports') continue;
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
        //     exclui "Total de escanteios", "X total" (por-time), "Nº tempo - total".
        //     Vôlei/mesa usam "Total pontos" (rótulo final vem de TOTAL_LABEL). ---
        else if ((base === 'Total' || base === 'Total pontos') && m.sv) {
          const linha = parseFloat(m.sv);
          if (!Number.isFinite(linha) || !ehLinhaOk(linha)) continue;
          const over = oddsM.find((o) => /mais/i.test(o.name || ''));
          const under = oddsM.find((o) => /menos/i.test(o.name || ''));
          if (!ativa(over) || !ativa(under)) continue;
          out.push({
            esporte, evento, dataHora, mercado: TOTAL_LABEL[espId] || 'Total',
            linha, opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
            oddA: over!.price, oddB: under!.price,
          });
        }

        // --- Handicap Asiático 2-way (home/away com sinal), linha em sv, só meia-linha.
        //     Vôlei/mesa usam "Handicap pontos" → rótulo com ASSUNTO ("Handicap de
        //     Pontos"), para nunca colidir com handicap de SETS de outra casa. ---
        else if ((base === 'Handicap' || base === 'Handicap pontos') && m.sv) {
          const linha = parseFloat(m.sv); // linha do mandante
          if (!Number.isFinite(linha) || !ehLinhaOk(linha)) continue;
          const oHome = oddsM.find((o) => o.competitorId === cids[0]);
          const oAway = oddsM.find((o) => o.competitorId === cids[1]);
          if (!ativa(oHome) || !ativa(oAway)) continue;
          out.push({
            esporte, evento, dataHora,
            mercado: base === 'Handicap pontos' ? 'Handicap de Pontos' : 'Handicap',
            linha,
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
