import { OddsScraper, ScrapedOdd } from './scraper_base';
import { fetchTextoComRetry } from '../utils/http';
import { areEventsSame } from '../arbitrage/matcher';
import { rotuloOver, rotuloUnder } from '../arbitrage/markets';

/**
 * Scraper da Esportes da Sorte (plataforma Sportingtech / "TraderX", feed api-v2).
 *
 * Arquétipo REST (mesmo molde do BetBoom): snapshot sem browser. O SPA fica
 * atrás de Cloudflare, mas os endpoints api-v2 são replayáveis via fetch desde
 * que se envie os headers que o front manda (o servidor valida `bragiurl` —
 * sem ele responde {"message":"Invalid bragiurl"}).
 *
 * Fluxo (descoberto por sondagem Playwright em 18/07/2026):
 *   1. GET /api-v2/left-menu/null/23/<brand>/<b64{}>  → estrutura esporte→liga
 *      (data[stId].cs[].sns[].sId = seasonId).
 *   2. GET /api-v2/league-card/null/23/<brand>/<sIds join '-'>  (encodedbody =
 *      base64 {"requestBody":{"seasonIds":[...]}}) → fixtures + odds.
 *      data[st].cs[].sns[].fs[] = fixture (hcN/acN times, fsd início ms,
 *      lSt=live?, vld, frz); fs.btgs[] = mercado (btgN nome); btg.fos[] =
 *      outcome (btN/hSh/pSh rótulo, hO odd, sv linha).
 *
 * WHITELIST CONSERVADORA (v1, dinheiro real): só mercados com estrutura de
 * outcome VERIFICADA no feed — Total de Gols (over/under) e Ambas Marcam (BTTS)
 * no futebol. 1X2 ("Resultado"), Dupla Chance e futuros ficam de FORA
 * (Diretrizes proíbem 1X2 no futebol; os demais não têm par 2-vias limpo).
 * Handicap Asiático / DNB / outros esportes: expandir após capturar o
 * fixture-detail e confirmar a estrutura (NUNCA adivinhar mercado de dinheiro).
 */

const BRAND = 'esportesdasortevip';
const LANG = '23'; // ptb
const BASE = 'https://esportesdasorte.bet.br/api-v2';
const BRAGI = 'https://bragi.sportingtech.com/';

// stId do Sportingtech → esporte do scanner. v1: só futebol (vocabulário de
// mercado verificado). Outros esportes: adicionar após auditar os btgN deles.
const SPORT_LABEL: Record<number, string> = {
  152: 'Futebol',
};
const ESPORTE_STID: Record<string, number[]> = {
  Futebol: [152],
};

interface EdsFo {
  btN?: string; hSh?: string; pSh?: string; oc?: string;
  hO?: number; sv?: string | number; valid?: boolean; freeze?: boolean; prm?: boolean;
}
interface EdsBtg { btgN?: string; mrkp?: string; fos?: EdsFo[] }
interface EdsFixture {
  fId: number; fsd?: number; hcN?: string; acN?: string;
  lSt?: boolean; vld?: boolean; frz?: boolean; btgs?: EdsBtg[];
}
interface EdsSeason { sId: number; fs?: EdsFixture[] }
interface EdsCategory { sns?: EdsSeason[] }
interface EdsSport { stId: number; cs?: EdsCategory[] }
interface EdsResp { data?: EdsSport[] }

export class EsportesDaSorteScraper implements OddsScraper {
  private maxSeasonsPorLote = 40; // limita o tamanho da URL do league-card
  private maxEventosPorEsporte = 200;

  getNome(): string {
    return 'EsportesDaSorte';
  }

  private headers(encodedBody: string) {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      bragiurl: BRAGI,
      encodedbody: encodedBody,
      customorigin: 'https://esportesdasorte.bet.br',
      languageid: LANG,
      device: 'm',
      Referer: 'https://esportesdasorte.bet.br/',
    };
  }

  private b64(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj)).toString('base64');
  }

  /** Estrutura do menu → seasonIds por stId de esporte. */
  private async seasonIdsPorEsporte(rapido: boolean): Promise<Record<number, number[]>> {
    const eb = this.b64({ requestBody: {} });
    const r = await fetchTextoComRetry(
      `${BASE}/left-menu/null/${LANG}/${BRAND}/${eb}`,
      { headers: this.headers(eb) },
      rapido ? 1 : 3,
      'EsportesDaSorte/menu',
      rapido ? 10000 : 20000
    );
    if (r.status !== 200) throw new Error(`left-menu HTTP ${r.status}`);
    const j: EdsResp = JSON.parse(r.body);
    const map: Record<number, number[]> = {};
    for (const st of j.data || []) {
      if (!SPORT_LABEL[st.stId]) continue;
      const ids: number[] = [];
      for (const c of st.cs || []) for (const s of c.sns || []) if (s.sId) ids.push(s.sId);
      map[st.stId] = ids;
    }
    return map;
  }

  /** Baixa os fixtures+odds de um lote de seasonIds. */
  private async leagueCard(seasonIds: number[], rapido: boolean): Promise<EdsSport[]> {
    if (seasonIds.length === 0) return [];
    const eb = this.b64({ requestBody: { seasonIds } });
    const path = seasonIds.join('-');
    const r = await fetchTextoComRetry(
      `${BASE}/league-card/null/${LANG}/${BRAND}/${path}`,
      { headers: this.headers(eb) },
      rapido ? 1 : 2,
      'EsportesDaSorte/card',
      rapido ? 12000 : 22000
    );
    if (r.status !== 200) return [];
    try {
      return (JSON.parse(r.body) as EdsResp).data || [];
    } catch {
      return [];
    }
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log('🤖 [EsportesDaSorte] Extração via feed api-v2 (Sportingtech)...');
    const stIdsAlvo = new Set<number>();
    for (const e of esportes) (ESPORTE_STID[e] || []).forEach((s) => stIdsAlvo.add(s));
    if (stIdsAlvo.size === 0) return [];

    let sids: Record<number, number[]>;
    try {
      sids = await this.seasonIdsPorEsporte(false);
    } catch (e: any) {
      console.error(`   ⚠️ [EsportesDaSorte] menu indisponível: ${e.message}`);
      return [];
    }

    const todos: number[] = [];
    for (const st of stIdsAlvo) (sids[st] || []).forEach((id) => todos.push(id));
    if (todos.length === 0) return [];

    const sports: EdsSport[] = [];
    for (let i = 0; i < todos.length; i += this.maxSeasonsPorLote) {
      try {
        sports.push(...(await this.leagueCard(todos.slice(i, i + this.maxSeasonsPorLote), false)));
      } catch {
        /* lote indisponível — segue */
      }
    }

    const odds = this.parseSports(sports, stIdsAlvo);
    const porEsporte: Record<string, number> = {};
    for (const o of odds) porEsporte[o.esporte] = (porEsporte[o.esporte] || 0) + 1;
    for (const [esp, n] of Object.entries(porEsporte)) console.log(`   [EsportesDaSorte] ${esp}: ${n} odds`);
    console.log(`✅ [EsportesDaSorte] Total: ${odds.length} odds.`);
    return odds;
  }

  /** Busca dirigida para a revalidação pré-alerta. */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    try {
      const stIds = new Set<number>(
        esporte && ESPORTE_STID[esporte] ? ESPORTE_STID[esporte] : Object.keys(SPORT_LABEL).map(Number)
      );
      const sids = await this.seasonIdsPorEsporte(true);
      const todos: number[] = [];
      for (const st of stIds) (sids[st] || []).forEach((id) => todos.push(id));

      const sports: EdsSport[] = [];
      for (let i = 0; i < todos.length; i += this.maxSeasonsPorLote) {
        sports.push(...(await this.leagueCard(todos.slice(i, i + this.maxSeasonsPorLote), true)));
      }
      // filtra ao evento pedido ANTES de parsear tudo
      const filtrados = this.filtrarSportsPorEvento(sports, evento);
      return this.parseSports(filtrados, stIds);
    } catch {
      return [];
    }
  }

  private filtrarSportsPorEvento(sports: EdsSport[], evento: string): EdsSport[] {
    return sports.map((st) => ({
      ...st,
      cs: (st.cs || []).map((c) => ({
        ...c,
        sns: (c.sns || []).map((s) => ({
          ...s,
          fs: (s.fs || []).filter((f) => f.hcN && f.acN && areEventsSame(`${f.hcN} vs ${f.acN}`, evento)),
        })),
      })),
    }));
  }

  /** Percorre a árvore data[st].cs[].sns[].fs[] e emite ScrapedOdd. */
  parseSports(sports: EdsSport[], stIdsAlvo: Set<number>): ScrapedOdd[] {
    const agora = Date.now();
    const out: ScrapedOdd[] = [];
    const contadorPorEsporte = new Map<number, number>();

    for (const st of sports) {
      if (!stIdsAlvo.has(st.stId) || !SPORT_LABEL[st.stId]) continue;
      const esporte = SPORT_LABEL[st.stId];
      for (const c of st.cs || []) {
        for (const s of c.sns || []) {
          for (const f of s.fs || []) {
            if ((contadorPorEsporte.get(st.stId) || 0) >= this.maxEventosPorEsporte) break;
            // Só PRÉ-JOGO: lSt false (não ao vivo), válido, não congelado, começa no futuro.
            if (f.lSt === true || f.vld === false || f.frz === true) continue;
            const t = f.fsd || 0;
            if (!t || t <= agora) continue;
            const home = (f.hcN || '').trim();
            const away = (f.acN || '').trim();
            if (!home || !away) continue;
            const linhas = this.parseFixture(f, esporte, home, away, t);
            if (linhas.length) {
              out.push(...linhas);
              contadorPorEsporte.set(st.stId, (contadorPorEsporte.get(st.stId) || 0) + 1);
            }
          }
        }
      }
    }
    return out;
  }

  private parseFixture(
    f: EdsFixture,
    esporte: string,
    home: string,
    away: string,
    startMs: number
  ): ScrapedOdd[] {
    const evento = `${home} vs ${away}`;
    const dataHora = new Date(startMs).toISOString();
    const out: ScrapedOdd[] = [];

    for (const btg of f.btgs || []) {
      const nome = (btg.btgN || '').toLowerCase();
      const fos = (btg.fos || []).filter((o) => o.valid !== false && o.freeze !== true);

      // --- Total de Gols (over/under por linha) ---
      if (nome.includes('total') && nome.includes('gol')) {
        const porLinha = new Map<number, { over?: number; under?: number }>();
        for (const o of fos) {
          const odd = this.odd(o.hO);
          const linha = this.num(o.sv);
          if (!Number.isFinite(odd) || linha === null) continue;
          const dir = this.direcao(o);
          if (!dir) continue;
          const slot = porLinha.get(linha) || {};
          slot[dir] = odd;
          porLinha.set(linha, slot);
        }
        for (const [linha, par] of porLinha) {
          if (par.over && par.under) {
            out.push({
              esporte, evento, dataHora,
              mercado: 'Total de Gols',
              linha,
              opcaoA: rotuloOver(linha),
              opcaoB: rotuloUnder(linha),
              oddA: par.over,
              oddB: par.under,
            });
          }
        }
        continue;
      }

      // --- Ambas as Equipes Marcam (BTTS) — Sim/Não ---
      if (nome.includes('ambas') && nome.includes('marcam')) {
        let sim: number | undefined;
        let nao: number | undefined;
        for (const o of fos) {
          const odd = this.odd(o.hO);
          if (!Number.isFinite(odd)) continue;
          const rot = `${o.btN || ''} ${o.hSh || ''}`.toLowerCase();
          if (/\bsim\b/.test(rot)) sim = odd;
          else if (/\bn[aã]o\b/.test(rot)) nao = odd;
        }
        if (sim && nao) {
          out.push({
            esporte, evento, dataHora,
            mercado: 'Ambas Equipes Marcam',
            opcaoA: 'Sim',
            opcaoB: 'Não',
            oddA: sim,
            oddB: nao,
          });
        }
        continue;
      }
      // Demais mercados: ignorados (whitelist conservadora).
    }
    return out;
  }

  private odd(v: unknown): number {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) && n > 1 ? n : NaN;
  }

  private num(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  }

  /** Direção over/under de um outcome de total (pSh inglês estável; hSh/oc pt fallback). */
  private direcao(o: EdsFo): 'over' | 'under' | null {
    const s = `${o.pSh || ''} ${o.hSh || ''} ${o.oc || ''}`.toLowerCase();
    if (/over|mais de|acima/.test(s)) return 'over';
    if (/under|menos de|abaixo/.test(s)) return 'under';
    return null;
  }
}
