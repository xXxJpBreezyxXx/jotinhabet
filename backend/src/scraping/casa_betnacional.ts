import { chromium, Browser, Page } from 'playwright';
import { OddsScraper, ScrapedOdd } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';

/**
 * Betnacional (BR) — plataforma própria "bet6" (provider RAMP, encoding Sportradar UOF).
 *
 * TRANSPORTE (descoberto por sondagem Playwright em 18/07/2026): o feed de odds
 * (prod-global-bff-events.bet6.com.br) está atrás de Cloudflare Bot Management por
 * FINGERPRINT DE TLS/HTTP2 — curl/undici tomam 403 mesmo com os headers idênticos
 * do browser, todos os cookies e do MESMO IP. NÃO é bloqueio de ASN/datacenter (o
 * Chromium headless passa desse mesmo IP), então túnel residencial (Tailscale) não
 * ajudaria. Um browser real é OBRIGATÓRIO: abrimos betnacional.bet.br (passa a CF em
 * ~9s), e os fetches ao BFF saem de DENTRO do contexto (page.evaluate).
 *
 * FEED (2 fases, no molde do Pinnacle: lista → mercados por evento):
 *   1. LIST  GET /api/odds/1/events-by-seasons?sport_id=1&markets=1&provider=ramp
 *      → array PLANO odds[] só do mercado destacado (1X2). Serve p/ ENUMERAR os
 *        eventos prematch (event_id, home, away, date_start, is_live).
 *   2. GROUPED GET /api/event-odds/{eid}/grouped?languageId=1&marketIds=<ids>&statusId=0&provider=ramp
 *      → { events:[meta], odds:[...] } com TODOS os mercados do evento. Sem o filtro
 *        marketIds a resposta chega a 3.2MB/evento; filtrando aos ids da whitelist cai
 *        p/ ~11KB. Cada linha odds[] tem market_id, market_code, outcome_name, odd
 *        (string), specifier ("total=2,5" — VÍRGULA decimal).
 *
 * WHITELIST CONSERVADORA (v1, dinheiro real): SÓ mercados 2-vias com estrutura de
 * outcome VERIFICADA no feed real (futebol):
 *   - Total de Gols FT   — market_code "Total" (≠ "TOTAL_1ST_HALF"), over/under por linha.
 *   - Ambas Marcam FT    — market_code "Both Teams To Score" (≠ "...First/Second Half"), Sim/Não.
 *   - DNB FT             — market_code "Draw No Bet", 2 outcomes = nomes dos times.
 * 1X2 ("Resultado da partida") e Chance Dupla ficam de FORA (Diretrizes proíbem 1X2
 * no futebol). Handicap ("Home/Away Team -X.5 Goals") e outros esportes: v2, após
 * validar em produção o pareamento sign-aware (handicap já foi fonte de bug — ver
 * handicap-pareamento-motor). NUNCA adivinhar estrutura de mercado que toca dinheiro.
 */

const HOME = 'https://betnacional.bet.br/';
const BFF = 'https://prod-global-bff-events.bet6.com.br';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const listUrl = (sportId: number) =>
  `${BFF}/api/odds/1/events-by-seasons?sport_id=${sportId}&category_id=0&tournament_id=&markets=1&provider=ramp`;
const groupedUrl = (eid: number, marketIds: string) =>
  `${BFF}/api/event-odds/${eid}/grouped?languageId=1&marketIds=${marketIds}&outcomeIds=&statusId=0&provider=ramp`;

// bet6 sport_id → esporte interno. v1: só Futebol (mercados verificados).
const SPORT_LABEL: Record<number, string> = { 1: 'Futebol' };
const ESPORTE_SPORT: Record<string, number[]> = { Futebol: [1] };

// Whitelist de market_ids (variant ids do Sportradar/bet6, estáveis por tipo+linha)
// para o filtro marketIds= do GROUPED. É PERFORMANCE: reduz o payload. A CORRETUDE
// vem do parser (dispatch por market_code + estrutura do outcome), então um id que
// mude/suma só resulta em MENOS odds, nunca em odd errada.
const MERCADO_IDS_FUTEBOL = [
  '999165', '999166', '999167', '999168', '999169', '999170', '999171', '999172', // Total 0,5..7,5 gols
  '999273', // Ambas Marcam
  '999134', // Empate anula (DNB)
].join(',');

interface BnListOdd {
  event_id: number; home: string; away: string; date_start?: string;
  is_live?: number; event_status_id?: number;
}
interface BnGroupedOdd {
  market_id: number; market_code?: string; market_name?: string;
  outcome_name?: string; outcome_code?: string; odd?: string | number;
  specifier?: string; specifier_value?: string;
  market_display_status?: number; selection_display_status?: number;
}
interface BnEventMeta { eid: number; home: string; away: string; dataHora: string; esporte: string }
interface BnGroupedResp { events?: any[]; odds?: BnGroupedOdd[] }

export class BetnacionalScraper implements OddsScraper {
  // Per-evento via browser: teto na JANELA ACIONÁVEL (mais próximos do kickoff, onde
  // a odd está ativa e a aposta é real). tournament_important não discrimina (341/343
  // jogos = valor default), então o horário é o melhor proxy: jogos grandes (ex.:
  // Brasileirão) entram na janela conforme se aproximam. Batching mantém o custo ~20s.
  private maxEventosPorEsporte = 60;
  private batch = 6; // fetches concorrentes por page.evaluate

  getNome(): string {
    return 'Betnacional';
  }

  /** Converte "2026-07-21 19:30:00" (horário local BR) em ISO UTC. */
  private paraIso(ds?: string): string {
    if (!ds) return 'Hoje';
    const t = Date.parse(ds.replace(' ', 'T') + '-03:00');
    return isNaN(t) ? 'Hoje' : new Date(t).toISOString();
  }

  private odd(v: unknown): number {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    return Number.isFinite(n) && n > 1 ? n : NaN;
  }

  /** Linha a partir do specifier "total=2,5" (vírgula decimal) → 2.5. */
  private linhaSpec(spec?: string): number | null {
    const m = (spec || '').match(/=\s*(-?\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /** market_code normalizado (tira os pipes "|...|" inconsistentes do feed). */
  private code(o: BnGroupedOdd): string {
    return (o.market_code || '').replace(/\|/g, '').trim().toLowerCase();
  }

  /**
   * Seleção bettável? Usa SÓ selection_display_status (0 = seleção fechada). NÃO
   * filtra por market_display_status: verificado em 18/07/2026 que o BTTS tem
   * market_display_status=0 em 100% dos jogos (fica numa sub-aba da UI) mesmo com
   * odds válidas e margem normal — filtrar por ele zerava o mercado inteiro. A
   * corretude da odd fica no `odd > 1` do parser + revalidação pré-alerta.
   */
  private ativo(o: BnGroupedOdd): boolean {
    return o.selection_display_status !== 0;
  }

  /**
   * Corre uma promise contra um teto de tempo, devolvendo `fallback` se estourar.
   * REDE DE SEGURANÇA anti-freeze: um page.evaluate que pendure (página travada)
   * jamais pode segurar a coleta — e a varredura agendada tem trava GLOBAL estática
   * (um hang aqui congelaria TODAS as varreduras futuras).
   */
  private async comTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    let t: ReturnType<typeof setTimeout>;
    const limite = new Promise<T>((res) => { t = setTimeout(() => res(fallback), ms); });
    try {
      return await Promise.race([promise, limite]);
    } finally {
      clearTimeout(t!);
    }
  }

  /** Abre o browser, passa a Cloudflare e devolve {browser, page} prontos. */
  private async abrir(rapido: boolean): Promise<{ browser: Browser; page: Page }> {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    // Qualquer falha DEPOIS do launch fecha o browser antes de propagar — senão o
    // processo chromium vaza (crítico: executarCrawler roda a cada 5 min).
    try {
      const context = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1366, height: 900 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
      });
      await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
      const page = await context.newPage();
      // bloqueia imagens/fontes/css — só precisamos das respostas JSON do BFF
      await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css,mp4}', (r) => r.abort()).catch(() => {});
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: rapido ? 30000 : 45000 }).catch(() => {});
      await page.waitForTimeout(rapido ? 6000 : 8000); // deixa a CF liberar (cf_clearance implícito na conexão)
      return { browser, page };
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
  }

  /** Baixa a lista de eventos prematch de um esporte (dedupada, com metadados). */
  private async listaEventos(page: Page, sportId: number): Promise<BnEventMeta[]> {
    const esporte = SPORT_LABEL[sportId];
    const buscar = () =>
      this.comTimeout(
        page.evaluate(async (url) => {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 12000); // fetch sem timeout = hang
          try {
            const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
            if (r.status !== 200) return null; // 403 = CF ainda não liberou
            const j = await r.json();
            return j?.odds || [];
          } catch {
            return null;
          } finally {
            clearTimeout(to);
          }
        }, listUrl(sportId)),
        15000,
        null as BnListOdd[] | null
      );
    // 1 re-tentativa curta se a CF ainda não liberou (lista 403/erro no 1º fetch).
    let odds: BnListOdd[] | null = await buscar();
    if (odds === null) {
      await page.waitForTimeout(3000);
      odds = await buscar();
    }
    if (!odds) return [];

    const agora = Date.now();
    const porEvento = new Map<number, BnEventMeta>();
    for (const o of odds) {
      if (!o.event_id || porEvento.has(o.event_id)) continue;
      if (o.is_live === 1 || o.event_status_id !== 0) continue; // só PRÉ-JOGO
      const dataHora = this.paraIso(o.date_start);
      const t = Date.parse(dataHora);
      if (isNaN(t) || t <= agora) continue; // começa no futuro
      const home = (o.home || '').trim();
      const away = (o.away || '').trim();
      if (!home || !away) continue;
      porEvento.set(o.event_id, { eid: o.event_id, home, away, dataHora, esporte });
    }
    // mais próximos primeiro (maior liquidez / chance de arb)
    return [...porEvento.values()].sort((a, b) => Date.parse(a.dataHora) - Date.parse(b.dataHora));
  }

  /** Baixa os mercados (grouped, filtrado) de um LOTE de eventos, concorrente no browser. */
  private async grouped(page: Page, eids: number[]): Promise<Record<number, BnGroupedResp>> {
    const urls = eids.map((eid) => ({ eid, url: groupedUrl(eid, MERCADO_IDS_FUTEBOL) }));
    return this.comTimeout(
      page.evaluate(async (reqs) => {
        const out: Record<number, any> = {};
        await Promise.all(
          reqs.map(async ({ eid, url }) => {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 12000); // fetch sem timeout = hang
            try {
              const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
              if (r.status === 200) out[eid] = await r.json();
            } catch {
              /* evento indisponível — segue */
            } finally {
              clearTimeout(to);
            }
          })
        );
        return out;
      }, urls),
      20000,
      {} as Record<number, BnGroupedResp>
    );
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    const sportIds = new Set<number>();
    for (const e of esportes) (ESPORTE_SPORT[e] || []).forEach((s) => sportIds.add(s));
    if (sportIds.size === 0) return [];

    console.log('🤖 [Betnacional] Extração via feed bet6/RAMP (browser + Cloudflare)...');
    let browser: Browser | null = null;
    const out: ScrapedOdd[] = [];
    try {
      const aberto = await this.abrir(false);
      browser = aberto.browser;
      const page = aberto.page;

      // Deadline geral da coleta: mesmo com timeout por lote, um feed degradado
      // (10 lotes × 20s) passaria de 3 min e atrasaria o ciclo de 5 min / seguraria a
      // trava global do scanner. Para de iniciar lotes novos após o teto (entrega o
      // que já coletou).
      const deadline = Date.now() + 90_000;
      for (const sportId of sportIds) {
        try {
          const eventos = (await this.listaEventos(page, sportId)).slice(0, this.maxEventosPorEsporte);
          if (eventos.length === 0) {
            console.error(`   ⚠️ [Betnacional] ${SPORT_LABEL[sportId]}: lista vazia (CF/feed indisponível?)`);
            continue;
          }
          const metaPorId = new Map(eventos.map((e) => [e.eid, e]));
          let nOdds = 0;
          for (let i = 0; i < eventos.length; i += this.batch) {
            if (Date.now() > deadline) {
              console.warn(`   ⚠️ [Betnacional] deadline de coleta atingido — entregando parcial (${SPORT_LABEL[sportId]})`);
              break;
            }
            const lote = eventos.slice(i, i + this.batch).map((e) => e.eid);
            let resp: Record<number, BnGroupedResp>;
            try {
              resp = await this.grouped(page, lote);
            } catch {
              continue;
            }
            for (const [eidStr, g] of Object.entries(resp)) {
              const meta = metaPorId.get(Number(eidStr));
              if (!meta) continue;
              const linhas = this.parseGrouped(g, meta);
              out.push(...linhas);
              nOdds += linhas.length;
            }
          }
          console.log(`   [Betnacional] ${SPORT_LABEL[sportId]}: ${nOdds} odds (${eventos.length} eventos)`);
        } catch (e: any) {
          console.error(`   ⚠️ [Betnacional] falha no esporte ${SPORT_LABEL[sportId]}: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      console.error(`   ⚠️ [Betnacional] falha na extração: ${e?.message || e}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    console.log(`✅ [Betnacional] Total: ${out.length} odds.`);
    return out;
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta): re-abre o browser, acha o evento na
   * lista e baixa só o grouped dele. Custa uma abertura de browser (~10s com a CF),
   * mas o memo de 60s do RevalidationService dedup a e o gate roda em Promise.all
   * com a outra perna.
   *
   * CONTRATO DE FALHA (importante): distingue INFRA de AUSÊNCIA GENUÍNA. Se o browser
   * não abre ou a CF não libera (lista vazia em TODOS os esportes — sempre há centenas
   * de jogos prematch), LANÇA. O gate (checarPernasAoVivo) trata o throw como "falha ao
   * re-buscar pernas", que casa o guard de INFRA do scanner (/falha ao/) → a linha é
   * removida e re-gateada na próxima varredura. Devolver [] aqui viraria "perna não
   * encontrada" (≠ guard) e suprimiria o alerta de uma arb VÁLIDA PARA SEMPRE. Só
   * devolve [] quando a lista carregou mas o evento/mercado está genuinamente ausente.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const sportIds = esporte && ESPORTE_SPORT[esporte] ? ESPORTE_SPORT[esporte] : Object.keys(SPORT_LABEL).map(Number);
    let browser: Browser | null = null;
    try {
      const aberto = await this.abrir(true); // falha de browser/CF PROPAGA (infra)
      browser = aberto.browser;
      const page = aberto.page;
      let listaCarregou = false;
      for (const sportId of sportIds) {
        const eventos = await this.listaEventos(page, sportId);
        if (eventos.length > 0) listaCarregou = true;
        const alvo = eventos.filter((e) => areEventsSame(`${e.home} vs ${e.away}`, evento)).slice(0, 2);
        if (alvo.length === 0) continue;
        const resp = await this.grouped(page, alvo.map((e) => e.eid));
        const odds: ScrapedOdd[] = [];
        for (const e of alvo) {
          const g = resp[e.eid];
          if (g) odds.push(...this.parseGrouped(g, e));
        }
        if (odds.length) return odds;
      }
      // Lista vazia em todos os esportes ⇒ CF/feed fora ⇒ sinaliza INFRA (não ausência).
      if (!listaCarregou) throw new Error('Betnacional indisponível na revalidação (lista vazia — CF/feed fora)');
      return []; // lista carregou; evento/mercado genuinamente ausente
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /** Converte o grouped de UM evento em ScrapedOdds (parser PURO — testável sem browser). */
  parseGrouped(g: BnGroupedResp, meta: BnEventMeta): ScrapedOdd[] {
    const { home, away, dataHora, esporte } = meta;
    const evento = `${home} vs ${away}`;
    const out: ScrapedOdd[] = [];

    // Total de Gols FT — pareado pela LINHA, não pelo market_id. No feed atual cada
    // linha tem seu próprio market_id, mas agrupar por id e "descobrir" a linha por
    // last-write arriscava casar o over de uma linha com o under de OUTRA (surebet
    // fabricada) se um id trouxesse >1 specifier. Chavear pela linha do specifier
    // torna over/under sempre da MESMA linha.
    const totalPorLinha = new Map<number, { over?: number; under?: number }>();
    let bttsSim: number | undefined;
    let bttsNao: number | undefined;
    let dnbHome: number | undefined;
    let dnbAway: number | undefined;

    for (const o of g.odds || []) {
      if (!this.ativo(o)) continue;
      const odd = this.odd(o.odd);
      if (!Number.isFinite(odd)) continue;
      const code = this.code(o);
      const nome = (o.outcome_name || '').toLowerCase();

      // Total de Gols FT (code "total"; "total_1st_half" NÃO casa)
      if (code === 'total') {
        const linha = this.linhaSpec(o.specifier || o.specifier_value);
        if (linha === null || !linhaArbitravel(linha)) continue;
        const slot = totalPorLinha.get(linha) || {};
        if (/mais de|acima|\bover\b/.test(nome)) slot.over = odd;
        else if (/menos de|abaixo|\bunder\b/.test(nome)) slot.under = odd;
        totalPorLinha.set(linha, slot);
      }
      // Ambas as Equipes Marcam FT (Sim/Não) — sub/2º tempo têm code diferente
      else if (code === 'both teams to score') {
        if (/\bsim\b/.test(nome)) bttsSim = odd;
        else if (/\bn[aã]o\b/.test(nome)) bttsNao = odd;
      }
      // DNB / Empate anula (2 outcomes = nomes EXATOS dos times)
      else if (code === 'draw no bet') {
        if (this.mesmoTime(o.outcome_name || '', home)) dnbHome = odd;
        else if (this.mesmoTime(o.outcome_name || '', away)) dnbAway = odd;
      }
      // Demais mercados: ignorados (whitelist conservadora).
    }

    for (const [linha, par] of totalPorLinha) {
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
    if (bttsSim && bttsNao) {
      out.push({
        esporte, evento, dataHora,
        mercado: 'Ambas Equipes Marcam',
        opcaoA: 'Sim', opcaoB: 'Não', oddA: bttsSim, oddB: bttsNao,
      });
    }
    if (dnbHome && dnbAway) {
      out.push({
        esporte, evento, dataHora,
        mercado: 'Empate anula a aposta',
        opcaoA: home, opcaoB: away, oddA: dnbHome, oddB: dnbAway,
      });
    }
    return out;
  }

  /**
   * Mesmo time? Igualdade EXATA normalizada (minúsculas, sem acento, só [a-z0-9]).
   * Sem fuzzy DE PROPÓSITO: home/away e o outcome do DNB vêm do MESMO feed bet6, então
   * o exato basta; fuzzy arriscaria trocar times quase-homônimos ("Atletico GO" ×
   * "Atletico MG") e atribuir a odd ao lado errado do DNB.
   */
  private mesmoTime(a: string, b: string): boolean {
    const norm = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    const na = norm(a);
    return na.length > 0 && na === norm(b);
  }
}
