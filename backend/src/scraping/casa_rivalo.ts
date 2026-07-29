import { chromium, Browser, Page } from 'playwright';
import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';

/**
 * Scraper da Rivalo (rivalo.bet.br) — plataforma PRÓPRIA ("matchserv"), API REST
 * `/api/offer/...` com odds decimais. Recon de 29/07/2026:
 *
 *  - A API é protegida por Cloudflare: `curl` puro devolve 403 **até nos endpoints
 *    JSON**, então os fetches saem de DENTRO da página (page.evaluate), herdando a
 *    liberação da conexão — mesmo padrão do casa_betnacional.ts.
 *  - E o Cloudflare barra o fingerprint HEADLESS (a home volta "Attention Required!"
 *    mesmo com stealth). Por isso este scraper roda **headless:false**, o que exige um
 *    DISPLAY — o Dockerfile sobe um Xvfb (:99) justamente para isto.
 *  - Headers OBRIGATÓRIOS; sem eles a API responde 400 "Invalid value for: header
 *    X-Betr-Brand": X-Betr-Brand, X-Betr-Operator, X-Locale.
 *
 * Endpoint usado (PRÉ-JOGO): `/api/offer/v4/fixtures/home/upcoming?first=N&sport=X`.
 * Estrutura: data[] → (agrupado por competição OU fixture direto) → fixtures[] com
 * `competitors[].name`, `startTime`, `markets[].type` e `markets[].outcomes[]`
 * {value, odds, status}. Linha em `market.properties.boundary` (totais) / `.handicap`.
 *
 * RESSALVA de cobertura: o payload traz um SUBCONJUNTO dos mercados (o fixture anuncia
 * `totalMarkets: 18` e vêm ~6). Os arbitráveis principais (total, handicap, BTTS,
 * vencedor) estão entre eles; o resto exigiria um endpoint por-fixture ainda não achado.
 */

const HOME = 'https://www.rivalo.bet.br/pt/sports/soccer';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** esporte interno → valor do parâmetro `sport` da Rivalo. */
const SPORT_PARAM: Record<string, string> = {
  Futebol: 'Football',
  Basquete: 'Basketball',
  Tenis: 'Tennis',
  'Tênis': 'Tennis',
  Volei: 'Volleyball',
  'Vôlei': 'Volleyball',
  TenisDeMesa: 'TableTennis',
  'Tenis de Mesa': 'TableTennis',
  'Tênis de Mesa': 'TableTennis',
  Beisebol: 'Baseball',
};
/** valor do `sport` → rótulo interno (o que vai no ScrapedOdd.esporte). */
const SPORT_LABEL: Record<string, string> = {
  Football: 'Futebol',
  Basketball: 'Basquete',
  Tennis: 'Tenis',
  Volleyball: 'Volei',
  TableTennis: 'Tenis de Mesa',
  Baseball: 'Beisebol',
};
/** rótulo do mercado de total por esporte. */
const TOTAL_LABEL: Record<string, string> = {
  Football: 'Total de Gols',
  Basketball: 'Total de Pontos',
  Tennis: 'Total de Games',
  Volleyball: 'Total de Pontos',
  TableTennis: 'Total de Pontos',
  Baseball: 'Total de Corridas',
};

interface RvOutcome { value?: string; odds?: number; status?: string; name?: string }
interface RvMarket { type?: string; properties?: Record<string, string>; outcomes?: RvOutcome[]; boosted?: boolean }
interface RvFixture {
  id?: string;
  sport?: string;
  startTime?: string;
  status?: string;
  totalMarkets?: number;
  competitors?: Array<{ name?: string }>;
  markets?: RvMarket[];
}

export class RivaloScraper implements OddsScraper {
  private readonly nome = 'Rivalo';
  /** Quantos fixtures pedir por esporte. 200 cobre o pré-jogo relevante sem estourar. */
  private readonly porEsporte = 200;

  getNome(): string {
    return this.nome;
  }

  /** Anti-freeze: um page.evaluate pendurado não pode travar a varredura (trava global). */
  private async comTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    let t: ReturnType<typeof setTimeout>;
    const limite = new Promise<T>((res) => { t = setTimeout(() => res(fallback), ms); });
    try {
      return await Promise.race([p, limite]);
    } finally {
      clearTimeout(t!);
    }
  }

  /**
   * Abre o browser HEADED (exigência do Cloudflare) e espera a liberação.
   * headless:false precisa de DISPLAY — em produção vem do Xvfb do Dockerfile.
   */
  private async abrir(): Promise<{ browser: Browser; page: Page }> {
    const browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    try {
      const context = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1366, height: 900 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
      });
      await context.addInitScript(() =>
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      );
      const page = await context.newPage();
      await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,mp4}', (r) => r.abort()).catch(() => {});
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(9000); // deixa a Cloudflare liberar
      return { browser, page };
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
  }

  /** GET na API de dentro da página (herda a liberação do Cloudflare + manda os headers X-Betr-*). */
  private async api(page: Page, path: string): Promise<any | null> {
    const r = await this.comTimeout(
      page.evaluate(async (p) => {
        const uuid = () =>
          (crypto as any).randomUUID?.() ||
          `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try {
          const resp = await fetch(p, {
            headers: {
              Accept: 'application/json',
              'X-Betr-Brand': 'rivalo.bet.br',
              'X-Betr-Operator': 'matchserv',
              'X-Locale': 'pt',
              'Accept-Language': 'pt-BR',
              'X-Request-Id': uuid(),
              'X-Correlation-Id': uuid(),
            },
          });
          if (!resp.ok) return { erro: `HTTP ${resp.status}` };
          return { json: await resp.json() };
        } catch (e: any) {
          return { erro: String(e?.message || e).slice(0, 120) };
        }
      }, path),
      25000,
      { erro: 'timeout' } as any
    );
    if (!r || r.erro) {
      console.error(`   ⚠️ [${this.nome}] ${path} → ${r?.erro || 'sem resposta'}`);
      return null;
    }
    return r.json;
  }

  /** Achata a resposta: algumas rotas agrupam por competição, outras vêm com fixture direto. */
  private extrairFixtures(j: any): RvFixture[] {
    const out: RvFixture[] = [];
    for (const it of j?.data || []) {
      if (Array.isArray(it?.fixtures)) out.push(...it.fixtures);
      else if (it) out.push(it);
    }
    return out;
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(`🤖 [${this.nome}] Extração via API de ofertas (browser + Cloudflare)...`);
    const todas: ScrapedOdd[] = [];
    let browser: Browser | undefined;
    try {
      const aberto = await this.abrir();
      browser = aberto.browser;
      const page = aberto.page;

      const params = [...new Set(esportes.map((e) => SPORT_PARAM[e]).filter(Boolean))];
      for (const sp of params) {
        const j = await this.api(
          page,
          `/api/offer/v4/fixtures/home/upcoming?first=${this.porEsporte}&liveCoverage=true&sport=${sp}`
        );
        if (!j) continue;
        const fixtures = this.extrairFixtures(j);
        const antes = todas.length;
        for (const f of fixtures) this.parseFixture(f, sp, todas);
        console.log(`   [${this.nome}] ${SPORT_LABEL[sp] || sp}: ${todas.length - antes} odds (${fixtures.length} jogos)`);
      }
    } catch (err: any) {
      console.error(`   ⚠️ [${this.nome}] falha na extração: ${err.message}`);
    } finally {
      await browser?.close().catch(() => {});
    }
    console.log(`✅ [${this.nome}] Total: ${todas.length} odds.`);
    return todas;
  }

  /** Revalidação dirigida: re-busca o esporte e filtra o evento (a API não busca por jogo). */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const params = esporte && SPORT_PARAM[esporte]
      ? [SPORT_PARAM[esporte]]
      : [...new Set(Object.values(SPORT_PARAM))];
    let browser: Browser | undefined;
    try {
      const aberto = await this.abrir();
      browser = aberto.browser;
      const page = aberto.page;
      for (const sp of params) {
        const j = await this.api(
          page,
          `/api/offer/v4/fixtures/home/upcoming?first=${this.porEsporte}&liveCoverage=true&sport=${sp}`
        );
        if (!j) continue;
        const out: ScrapedOdd[] = [];
        for (const f of this.extrairFixtures(j)) this.parseFixture(f, sp, out);
        const doEvento = out.filter((o) => areEventsSame(o.evento, evento));
        if (doEvento.length) return doEvento;
      }
    } catch {
      /* melhor esforço — revalidação nunca derruba o alerta */
    } finally {
      await browser?.close().catch(() => {});
    }
    return [];
  }

  /**
   * Rótulo do TOTAL a partir da UNIDADE no `type` (não do esporte). O motor deriva o
   * "assunto" do canônico do texto do rótulo (markets.ts → assunto()), então trocar a
   * unidade parearia mercados diferentes: um "total de SETS 2.5" com um "total de GAMES
   * 2.5" de outra casa tem a mesma linha e nada a ver um com o outro.
   * Unidade desconhecida → null (não emite), em vez de chutar pelo esporte.
   */
  private rotuloTotal(tipo: string, sportParam: string): string | null {
    if (/GOALS/i.test(tipo)) return 'Total de Gols';
    if (/GAMES/i.test(tipo)) return 'Total de Games';
    if (/POINTS/i.test(tipo)) return 'Total de Pontos';
    if (/SETS/i.test(tipo)) return 'Total de Sets';
    if (/RUNS|CORRIDAS/i.test(tipo)) return 'Total de Corridas';
    // Sem unidade no nome do tipo: cai no padrão do esporte (ex.: BASEBALL_OVER_UNDER).
    return TOTAL_LABEL[sportParam] || null;
  }

  /**
   * Rótulo do HANDICAP pela unidade. "Handicap" puro vira HANDICAP_GERAL no canônico —
   * é o que as casas Altenar emitem para tênis (games) e basquete (pontos), então manter
   * "Handicap" aqui é o que permite o pareamento. Já PONTOS e SETS ganham assunto
   * próprio para nunca cruzarem com uma unidade diferente.
   */
  private rotuloHandicap(tipo: string): string {
    if (/POINTS/i.test(tipo)) return 'Handicap de Pontos';
    if (/SETS/i.test(tipo)) return 'Handicap de Sets';
    return 'Handicap';
  }

  private parseFixture(f: RvFixture, sportParam: string, out: ScrapedOdd[]): void {
    const esporte = SPORT_LABEL[f.sport || sportParam] || SPORT_LABEL[sportParam];
    if (!esporte) return;
    const nomes = (f.competitors || []).map((c) => (c?.name || '').trim()).filter(Boolean);
    if (nomes.length !== 2) return;
    const [home, away] = nomes;
    // Só PRÉ-JOGO (o endpoint é "upcoming", mas o campo manda).
    const t = Date.parse(f.startTime || '');
    if (!isNaN(t) && t <= Date.now()) return;
    const evento = `${home} vs ${away}`;
    const dataHora = f.startTime || 'Hoje';
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;

    const ativo = (o?: RvOutcome) => !!o && o.status === 'Active' && typeof o.odds === 'number' && o.odds > 1;
    const achar = (m: RvMarket, v: string) => (m.outcomes || []).find((o) => o.value === v);

    for (const m of f.markets || []) {
      const tipo = m.type || '';
      // Mercado com odd turbinada é promocional (limite de aposta) → fora.
      if (m.boosted) continue;

      // --- TOTAL (over/under), linha em properties.boundary ---
      if (/_OVER_UNDER_/.test(tipo)) {
        const linha = parseFloat(m.properties?.boundary || '');
        if (!Number.isFinite(linha) || !linhaArbitravel(linha)) continue;
        const over = achar(m, 'OVER');
        const under = achar(m, 'UNDER');
        if (!ativo(over) || !ativo(under)) continue;
        const rotulo = this.rotuloTotal(tipo, sportParam);
        if (!rotulo) continue; // unidade desconhecida: não arrisca pareamento
        out.push({
          esporte, evento, dataHora,
          mercado: rotulo,
          linha,
          opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
          oddA: over!.odds!, oddB: under!.odds!,
        });
        continue;
      }

      // --- HANDICAP (2 vias com sinal), linha em properties.handicap ---
      // A linha publicada é do lado 1 (mandante/COMPETITOR_1) — conferido contra o
      // favoritismo: o lado com odd de vencedor menor é o que recebe handicap negativo.
      if (/_HANDICAP/.test(tipo)) {
        const linha = parseFloat(m.properties?.handicap || '');
        if (!Number.isFinite(linha) || !linhaArbitravel(linha)) continue;
        const a = achar(m, 'COMPETITOR_1') || achar(m, 'HOME');
        const b = achar(m, 'COMPETITOR_2') || achar(m, 'AWAY');
        if (!ativo(a) || !ativo(b)) continue;
        out.push({
          esporte, evento, dataHora,
          mercado: this.rotuloHandicap(tipo),
          linha,
          opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
          oddA: a!.odds!, oddB: b!.odds!,
        });
        continue;
      }

      // --- AMBAS MARCAM ---
      if (/BOTH_TEAMS_TO_SCORE/.test(tipo)) {
        const sim = achar(m, 'YES');
        const nao = achar(m, 'NO');
        if (!ativo(sim) || !ativo(nao)) continue;
        out.push({
          esporte, evento, dataHora, mercado: 'Ambas equipes marcam',
          opcaoA: 'Sim', opcaoB: 'Não', oddA: sim!.odds!, oddB: nao!.odds!,
        });
        continue;
      }

      // --- VENCEDOR ---
      // Só 2 VIAS (tênis, mesa, vôlei, basquete, beisebol). O 3-vias do futebol fica
      // FORA: Resultado Final de futebol é proibido pelas Diretrizes (risco do empate)
      // e seria descartado adiante de qualquer forma.
      // FOOTBALL_WINNER_X_UP também fica fora — é pagamento antecipado promocional
      // ("time X gols à frente"), liquidação diferente do vencedor normal.
      if (/_WINNER$/.test(tipo)) {
        if (sportParam === 'Football') continue;
        const a = achar(m, 'COMPETITOR_1') || achar(m, 'HOME');
        const b = achar(m, 'COMPETITOR_2') || achar(m, 'AWAY');
        const empate = achar(m, 'DRAW');
        if (empate) continue; // 3-vias: fora (só 2 vias entram)
        if (!ativo(a) || !ativo(b)) continue;
        out.push({
          esporte, evento, dataHora, mercado: 'Resultado Final',
          opcaoA: home, opcaoB: away, oddA: a!.odds!, oddB: b!.odds!,
        });
      }
    }
  }
}
