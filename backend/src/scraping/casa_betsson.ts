import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';

/**
 * Scraper da **Betsson** (www.betsson.bet.br) — sportsbook PRÓPRIO do Betsson Group
 * ("OBG"), servido pelo próprio domínio em `/api/sb/v1`. HTTP puro, sem browser.
 *
 * ⚠️ Recon 03/08/2026 CORRIGE a nota anterior do projeto: a Betsson **NÃO é Digitain**
 * (nem BetMGM/goldrush). Não existe GraphQL WS de odds; o feed é REST e responde do IP
 * da VPS sem túnel. As PÁGINAS HTML são barradas por AWS WAF (202 com corpo vazio), mas
 * `/api/sb/v1/*` NÃO passa pelo WAF — por isso o scraper nunca abre o site.
 *
 * Protocolo (tudo verificado em payload real):
 *  - Oferta: GET /api/sb/v1/widgets/events-table/v2
 *      ?categoryIds=<esporte>&eventPhase=PreMatch|Live&eventSortBy=StartDate
 *      &pageNumber=<n>&maxMarketCount=50&priceFormats=1[&competitionIds=<id>]
 *    Resposta: `data.events[]`, `data.markets[]`, `data.selections[]` (listas IRMÃS —
 *    selection→market por `marketId`, market→event por `eventId`).
 *  - **Paginação é `pageNumber`** (20 eventos/página). `page`/`offset`/`skip` são
 *    IGNORADOS em silêncio: devolvem a página 1 com HTTP 200, então quem errasse o nome
 *    varreria a mesma página N vezes achando que paginou.
 *  - `eventSortBy=StartDate` ordena ASCENDENTE — as primeiras páginas são os jogos mais
 *    próximos, o que permite CORTAR a paginação na janela de 48h do alerta (futebol tem
 *    44 páginas / 880 eventos, e a partir da ~pg 20 já é jogo de 5 dias à frente).
 *  - **Mercado é identificado por `marketTemplateId` (código estável, ex.: `MTG2W`), não
 *    por nome** — o feed da tabela não traz o nome do mercado. Casar por template é MAIS
 *    seguro que a regra geral do projeto (nome exato): não há ambiguidade de tradução.
 *    O nome amigável, quando preciso conferir, sai de
 *    GET /api/sb/v1/markets/static/<eventId>/<marketId>/0 (`marketFriendlyName` +
 *    `betGroupDescription`, que é onde está o "Incluindo OT").
 *  - `selectionTemplateId` dá o PAPEL da seleção independente de idioma:
 *    HOME/AWAY/DRAW, OVER/UNDER, YES/NO, HANDICAPHOME/HANDICAPAWAY/HANDICAPDRAW.
 *  - Odds são decimais prontas em `selection.odds` (sem escala).
 *  - **`lineValue` é um PAR "casa - visitante"** ("0 - 1.5", "2.5 - 0"), inútil para
 *    aritmética; **`lineValueRaw` é a linha JÁ ASSINADA na perspectiva do MANDANTE**
 *    (-1.5 = mandante -1.5, confirmado contra os rótulos "1 (-1.5)"/"2 (+1.5)" em 6
 *    esportes). É `lineValueRaw` que vira `ScrapedOdd.linha`.
 *  - Mandante = participante de `sortOrder`/`side` 1.
 *  - Filtros de oferta viva: `market.status === 'Open'` (existe 'Hold') e
 *    `selection.status === 'Open'` com `odds > 1` (o feed publica odd 1 em seleção
 *    'Open' — ex.: "Camboja ou Empate" a 1.00 — que não é oferta real).
 *  - Headers: o feed exige um conjunto de `x-sb-*` + `brandid` + `marketcode` e um
 *    User-Agent de browser real (o WAF devolve 403 sem ele). Os *-context-id NÃO são
 *    presos a sessão (qualquer valor serve — testado com "stc-1" e vazio), então não há
 *    bootstrap de sessão. Medido header a header: sozinhos, só UA/brandid/marketcode são
 *    obrigatórios, mas mandar SÓ eles dá HTTP 500 — o conjunto é exigido em bloco, por
 *    isso o mapa abaixo vai inteiro. `x-sb-segment-id` mexe na COBERTURA (sem ele vêm
 *    ~17% menos mercados), não só na autenticação.
 *
 * Esportes: a Betsson **não oferta tênis de mesa nem e-sports** (varredura de
 * categoryIds 1..80 em 03/08/2026), então esses dois nunca saem daqui. Futebol
 * americano, hóquei, handebol e rúgbi EXISTEM no feed mas ficam fora porque não estão
 * na lista de esportes da varredura.
 *
 * Tênis: a Betsson não está em GRUPO_A/GRUPO_B de `arbitrage/regras.ts`, então
 * `grupoTenis()` devolve null e TODO cruzamento de tênis dela é rejeitado (fail-safe da
 * doutrina de W.O.). A coleta acontece de propósito — o gate é que decide.
 */

const BASE = 'https://www.betsson.bet.br';
const API = `${BASE}/api/sb/v1/widgets/events-table/v2`;

interface BetssonConfig {
  nome?: string;
  /** Teto de páginas por esporte (20 eventos/página). Default 25 = 500 eventos. */
  maxPaginasPorEsporte?: number;
  /** Janela de coleta em horas — casada com HORAS_JANELA_ALERTA (48h) do scanner. */
  janelaHoras?: number;
  /** Varre TAMBÉM eventPhase=Live e não descarta partida já iniciada. */
  incluirAoVivo?: boolean;
}

/**
 * esporte interno → `categoryIds` da Betsson (ids GLOBAIS da marca, conferidos pelo
 * `categoryName` que volta no próprio payload — não são por-tenant como na NSoft).
 * Confirmados em 03/08/2026: 1 Futebol, 4 Basquete, 9 Vôlei, 11 Tênis, 19 Basebol.
 */
const SPORT_CID: Record<string, number> = {
  Futebol: 1,
  Basquete: 4,
  Volei: 9,
  'Vôlei': 9,
  Tenis: 11,
  'Tênis': 11,
  Beisebol: 19,
};
/** categoryId → rótulo interno emitido em ScrapedOdd.esporte. */
const CID_LABEL: Record<number, string> = {
  1: 'Futebol',
  4: 'Basquete',
  9: 'Volei',
  11: 'Tenis',
  19: 'Beisebol',
};

type Tipo = 'TOTAL' | 'HANDICAP' | 'VENCEDOR' | 'BTTS';

/**
 * Mercados aceitos por esporte, casados por `marketTemplateId`.
 *
 * O `rotulo` NÃO é livre: ele passa por `normalizarMercado` e o canônico resultante tem
 * de bater com o das casas já integradas, senão a Betsson coleta e nunca cruza. Cada um
 * abaixo foi escolhido conferindo o canônico contra Altenar/NSoft/Kambi/Superbet:
 *  - 'Handicap' → HANDICAP_GERAL_FT (convenção do handicap "principal": basquete,
 *    games do tênis, run line do beisebol).
 *  - 'Handicap de Sets' → HANDICAP_SETS_FT (vôlei; nunca cruza com handicap de pontos).
 *  - 'Total de Games'/'Total de Corridas'/'Total de Pontos'/'Total de Gols' seguem o
 *    TOTAL_LABEL do Altenar.
 *
 * FICAM FORA DE PROPÓSITO (cada um seria prejuízo, não perda de volume):
 *  - `M3WHCP` / `MWHCPALT` de 3 vias (futebol/rúgbi): handicap COM empate. As 3 vias não
 *    têm par complementar, e emitir HOME×AWAY como se fosse handicap asiático cruzaria
 *    com o asiático 2-vias de outra casa deixando o empate descoberto.
 *  - `DC` (dupla chance): as 3 saídas são 1X, 12 e X2 — nenhuma dupla é complementar da
 *    outra (o complemento de 1X é "2", que NÃO está neste mercado).
 *  - `MW3W` no BASQUETE: `betGroupDescription` = "Excluindo tempo extra", enquanto o
 *    `MW2W` diz "Incluindo OT". Cruzar vencedor de tempo normal com moneyline incl. OT é
 *    exatamente o que a Diretriz de basquete proíbe.
 *  - `MW3W`/`MW3W1H` no FUTEBOL: 1X2 de 3 vias, e Resultado Final de futebol é proibido
 *    por Diretriz de qualquer forma (`mercadoPermitido`).
 *  - `SW` (tênis, "Vencedor do set N"): a `lineValue` ali é o NÚMERO DO SET, não uma
 *    linha. Emitir como 'Resultado Final' venderia vencedor-de-set como vencedor-de-jogo.
 *  - `HTGIO`/`ATGIO` (basquete) e `HTT`/`ATT` (beisebol): totais POR TIME. São
 *    arbitráveis em teoria, mas o canônico carrega o nome do time (`escopoTime`), que
 *    difere de casa para casa — colhe risco sem gerar cruzamento.
 *
 * `MTG2W25` é o MESMO mercado que `MTG2W` na linha 2.5 (o `market.id` dos dois é
 * idêntico: `m-<evento>-MTG2W-2.5`) — é só um destaque de vitrine. Está mapeado para não
 * perder a linha 2.5 quando só a vitrine vier na página, e a duplicata morre no dedupe.
 */
const MERCADOS: Record<number, Record<string, { tipo: Tipo; rotulo: string }>> = {
  // ── Futebol (cid 1)
  1: {
    MTG2W: { tipo: 'TOTAL', rotulo: 'Total de Gols' },
    MTG2W25: { tipo: 'TOTAL', rotulo: 'Total de Gols' },
    BTTS: { tipo: 'BTTS', rotulo: 'Ambas equipes marcam' },
    // 1HTG = 1st Half Total Goals (prefixo "1H" + tag 10 = "Meio tempo" no
    // event-page-schema; linhas 0.5/1.5). O rótulo LEVA o período porque o canônico
    // precisa sair TOTAIS_GOLS_1T — sem isso cruzaria com o total do jogo inteiro.
    '1HTG': { tipo: 'TOTAL', rotulo: 'Total de Gols - 1º tempo' },
  },
  // ── Basquete (cid 4) — os três dizem "Incluindo OT"/"Incluindo tempo extra".
  4: {
    MW2W: { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
    PTSOUROLMID: { tipo: 'TOTAL', rotulo: 'Total de Pontos' },
    '2WHCPROLMID': { tipo: 'HANDICAP', rotulo: 'Handicap' },
  },
  // ── Vôlei (cid 9)
  9: {
    MW2W: { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
    MTP: { tipo: 'TOTAL', rotulo: 'Total de Pontos' },
    // MSH = Match Set Handicap. O nome amigável "Definir handicap" é tradução-máquina de
    // "Set handicap" ("set" lido como verbo), e as linhas (±1.5/±2.5) são de SET, não de
    // ponto — daí 'Handicap de Sets', que nunca colide com 'Handicap de Pontos'.
    MSH: { tipo: 'HANDICAP', rotulo: 'Handicap de Sets' },
  },
  // ── Tênis (cid 11)
  11: {
    MW2W: { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
    // "Jogos de match" = total de GAMES da partida (tradução-máquina de "Match games").
    MTG2WP: { tipo: 'TOTAL', rotulo: 'Total de Games' },
    // "Handicap de jogos" = handicap de games = o handicap principal do tênis.
    M2WHCP: { tipo: 'HANDICAP', rotulo: 'Handicap' },
  },
  // ── Beisebol (cid 19) — os três dizem "Incluir innings extras".
  19: {
    ML: { tipo: 'VENCEDOR', rotulo: 'Resultado Final' },
    RLS: { tipo: 'HANDICAP', rotulo: 'Handicap' },
    TR: { tipo: 'TOTAL', rotulo: 'Total de Corridas' },
  },
};

interface BsParticipant { label?: string; id?: string; sortOrder?: number; side?: number }
interface BsEvent {
  id?: string;
  globalId?: string;
  categoryId?: string;
  categoryName?: string;
  competitionId?: string;
  slug?: string;
  startDate?: string;
  phase?: string;
  eventType?: string;
  participants?: BsParticipant[];
}
interface BsMarket {
  id?: string;
  eventId?: string;
  marketTemplateId?: string;
  lineValue?: string;
  lineValueRaw?: number;
  status?: string;
}
interface BsSelection {
  marketId?: string;
  selectionTemplateId?: string;
  odds?: number;
  status?: string;
  label?: string;
}
interface BsResp {
  data?: { events?: BsEvent[]; markets?: BsMarket[]; selections?: BsSelection[]; totalPages?: number; page?: number };
}

export class BetssonScraper implements OddsScraper {
  private cfg: Required<BetssonConfig>;

  /**
   * evento normalizado → `competitionId`, alimentado pela própria coleta. A revalidação
   * usa isso para reconsultar UM campeonato (1 request) em vez de repaginar o esporte
   * inteiro — futebol tem 44 páginas, o que não caberia na janela de 10s da busca
   * dirigida. Sem cache (ex.: perna vinda do SureRadar/Telegram) cai no fallback
   * paginado, com teto próprio.
   */
  private competicaoPorEvento = new Map<string, { cid: number; competitionId: string }>();

  constructor(cfg: BetssonConfig = {}) {
    this.cfg = {
      nome: 'Betsson',
      maxPaginasPorEsporte: 25,
      janelaHoras: 48,
      incluirAoVivo: false,
      ...cfg,
    };
  }

  getNome(): string {
    return this.cfg.nome;
  }

  /**
   * Conjunto de headers do feed. Vai INTEIRO de propósito: individualmente quase todos
   * são dispensáveis, mas mandar só os obrigatórios (UA/brandid/marketcode) devolve
   * HTTP 500 — o gateway exige o bloco. `sessiontoken` (JWT anônimo fixo que a página
   * carrega) foi medido como dispensável e fica FORA, para não haver token a expirar.
   */
  private headers(): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR',
      brandid: '599869ba-7757-41ab-9b74-887dbf5c3705',
      marketcode: 'br',
      'x-obg-channel': 'Web',
      'x-obg-device': 'Desktop',
      'x-sb-channel': 'Web',
      'x-sb-content-id': '599869ba-7757-41ab-9b74-887dbf5c3705',
      'x-sb-country-code': 'BR',
      'x-sb-currency-code': 'BRL',
      'x-sb-device-type': 'Desktop',
      'x-sb-jurisdiction': 'Bra',
      'x-sb-language-code': 'br',
      // Mexe na COBERTURA (sem ele vêm ~17% menos mercados), não só na autenticação.
      'x-sb-segment-id': '70e606bb-1026-476f-92c6-88faf8a5aa6e',
      'x-sb-static-context-id': 'stc-1',
      'x-sb-type': 'b2b',
      'x-sb-user-context-id': 'stc-1',
      Referer: `${BASE}/apostas-esportivas`,
    };
  }

  private url(cid: number, pagina: number, fase: 'PreMatch' | 'Live', competitionId?: string): string {
    const q = [
      `categoryIds=${cid}`,
      `eventPhase=${fase}`,
      'eventSortBy=StartDate',
      `pageNumber=${pagina}`,
      // 50 é o platô: acima disso o feed não devolve mais nada (medido 5→50→200).
      'maxMarketCount=50',
      'priceFormats=1',
      'includeOutrights=false',
    ];
    if (competitionId) q.push(`competitionIds=${competitionId}`);
    return `${API}?${q.join('&')}`;
  }

  private fases(): Array<'PreMatch' | 'Live'> {
    return this.cfg.incluirAoVivo ? ['PreMatch', 'Live'] : ['PreMatch'];
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(`🤖 [${this.cfg.nome}] Extração via API própria (/api/sb/v1)${this.cfg.incluirAoVivo ? ' — AO VIVO incluído' : ''}...`);
    const todas: ScrapedOdd[] = [];
    const cids = [...new Set(esportes.map((e) => SPORT_CID[e]).filter((v): v is number => !!v))];
    if (!cids.length) {
      console.log(`   [${this.cfg.nome}] nenhum dos esportes pedidos é ofertado (sem tênis de mesa / e-sports).`);
      return todas;
    }

    for (const cid of cids) {
      for (const fase of this.fases()) {
        const sufixo = fase === 'Live' ? ' (ao vivo)' : '';
        try {
          const antes = todas.length;
          await this.coletarEsporte(cid, fase, todas);
          console.log(`   [${this.cfg.nome}] ${CID_LABEL[cid]}${sufixo}: ${todas.length - antes} odds`);
        } catch (e: any) {
          console.error(`   ⚠️ [${this.cfg.nome}] falha em ${CID_LABEL[cid]}${sufixo}: ${e.message}`);
        }
      }
    }

    const unicas = this.dedupar(todas);
    console.log(
      `✅ [${this.cfg.nome}] Total: ${unicas.length} odds${unicas.length !== todas.length ? ` (${todas.length - unicas.length} duplicadas removidas)` : ''}.`
    );
    return unicas;
  }

  /**
   * Remove ofertas repetidas de (esporte, evento, mercado, linha). Acontece de forma
   * ESPERADA aqui: `MTG2W25` é a vitrine do `MTG2W` na linha 2.5 e vem no mesmo payload
   * apontando para o mesmo `market.id`. Mantém a de odd somada maior (melhor oferta).
   */
  private dedupar(odds: ScrapedOdd[]): ScrapedOdd[] {
    const melhor = new Map<string, ScrapedOdd>();
    for (const o of odds) {
      const k = `${o.esporte}|${o.evento}|${o.mercado}|${o.linha ?? ''}`;
      const at = melhor.get(k);
      if (!at || o.oddA + o.oddB > at.oddA + at.oddB) melhor.set(k, o);
    }
    return [...melhor.values()];
  }

  /** Página do feed já parseada, ou null se a requisição não serviu. */
  private async buscarPagina(
    cid: number,
    pagina: number,
    fase: 'PreMatch' | 'Live',
    label: string,
    competitionId?: string,
    tentativas = 2,
    timeoutMs = 20000
  ): Promise<BsResp['data'] | null> {
    const resp = await fetchTextoComRetry(
      this.url(cid, pagina, fase, competitionId),
      { headers: this.headers() },
      tentativas,
      label,
      timeoutMs
    );
    if (resp.status !== 200) return null;
    try {
      return (JSON.parse(resp.body) as BsResp).data || null;
    } catch {
      return null;
    }
  }

  /**
   * Pagina um esporte até a janela de 48h (ou o teto de páginas). A ordenação é
   * ascendente por data, então o primeiro evento FORA da janela encerra o esporte —
   * sem isso o futebol sozinho custaria 44 requests/varredura para trazer jogos de
   * setembro que o alerta descarta depois.
   */
  private async coletarEsporte(cid: number, fase: 'PreMatch' | 'Live', out: ScrapedOdd[]): Promise<void> {
    const limite = Date.now() + this.cfg.janelaHoras * 60 * 60 * 1000;
    // Ao vivo é uma lista curta (6 eventos no futebol) e o startDate está no PASSADO —
    // a poda por janela não se aplica.
    const maxPaginas = fase === 'Live' ? 3 : this.cfg.maxPaginasPorEsporte;
    let algumaPaginaOk = false;

    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const d = await this.buscarPagina(cid, pagina, fase, `${this.cfg.nome}/${CID_LABEL[cid]}`);
      if (!d) break;
      algumaPaginaOk = true;
      const eventos = d.events || [];
      if (!eventos.length) break;

      this.parsePagina(d, cid, out);

      // Fim da janela: o feed vem ordenado por data, então basta o PRIMEIRO evento da
      // página passar do limite (os seguintes são mais tarde ainda).
      if (fase === 'PreMatch') {
        const t0 = Date.parse(eventos[0].startDate || '');
        if (!isNaN(t0) && t0 > limite) break;
      }
      if (d.totalPages && pagina >= d.totalPages) break;
    }

    // Contrato de falha do projeto (igual Betnacional/Betano): nenhuma página carregou =
    // problema de INFRA → propaga para o gate remover a linha e re-gatear no próximo
    // scan, em vez de fingir "casa sem oferta".
    if (!algumaPaginaOk) throw new Error(`feed indisponível (${CID_LABEL[cid]}/${fase})`);
  }

  /**
   * Parseia uma página inteira: casa selections→markets→events e emite as ScrapedOdd.
   * Público para o teste de unidade poder exercitar o parser com payload fixo (as
   * armadilhas daqui — sinal do handicap, 3-vias disfarçado de 2-vias, odd 1.00 — são
   * de regressão silenciosa e caram).
   */
  public parsePagina(d: NonNullable<BsResp['data']>, cid: number, out: ScrapedOdd[]): void {
    const permitidos = MERCADOS[cid] || {};
    const esporte = CID_LABEL[cid];
    if (!esporte) return;

    // selections são uma lista IRMÃ de markets — indexa por marketId antes de casar.
    const selPorMercado = new Map<string, BsSelection[]>();
    for (const s of d.selections || []) {
      if (!s.marketId) continue;
      if (!selPorMercado.has(s.marketId)) selPorMercado.set(s.marketId, []);
      selPorMercado.get(s.marketId)!.push(s);
    }
    const eventos = new Map<string, BsEvent>();
    for (const e of d.events || []) if (e.id) eventos.set(e.id, e);

    for (const m of d.markets || []) {
      if (m.status !== 'Open') continue;
      const cfg = permitidos[m.marketTemplateId || ''];
      if (!cfg) continue;
      const ev = eventos.get(m.eventId || '');
      if (!ev) continue;

      const dados = this.dadosDoEvento(ev, cid);
      if (!dados) continue;
      const { evento, home, away, dataHora, url } = dados;

      const mid = m.id || `m-${m.eventId}-${m.marketTemplateId}${m.lineValue ? `-${m.lineValue}` : ''}`;
      // odd 1.00 aparece em seleção 'Open' e não é oferta real → exige > 1.
      const sels = (selPorMercado.get(mid) || []).filter((s) => s.status === 'Open' && (s.odds || 0) > 1);
      if (!sels.length) continue;
      const papel = (p: string) => sels.find((s) => s.selectionTemplateId === p);

      if (cfg.tipo === 'TOTAL' || cfg.tipo === 'HANDICAP') {
        // lineValueRaw já é a linha assinada do MANDANTE; lineValue é o par "0 - 1.5",
        // que não serve para conta nenhuma.
        const linha = typeof m.lineValueRaw === 'number' ? m.lineValueRaw : parseFloat(m.lineValue || '');
        if (!Number.isFinite(linha) || !linhaArbitravel(linha)) continue;

        if (cfg.tipo === 'TOTAL') {
          const over = papel('OVER');
          const under = papel('UNDER');
          if (!over || !under) continue;
          out.push({
            esporte, evento, dataHora, mercado: cfg.rotulo, linha,
            opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
            oddA: over.odds!, oddB: under.odds!, url,
          });
        } else {
          // 3 vias (HANDICAPDRAW presente) é handicap COM empate — não é par
          // complementar e não pode sair como handicap asiático.
          if (papel('HANDICAPDRAW')) continue;
          const h = papel('HANDICAPHOME');
          const a = papel('HANDICAPAWAY');
          if (!h || !a) continue;
          const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
          out.push({
            esporte, evento, dataHora, mercado: cfg.rotulo, linha,
            opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
            oddA: h.odds!, oddB: a.odds!, url,
          });
        }
      } else if (cfg.tipo === 'VENCEDOR') {
        // Empate no mercado = 3 vias → fora (o par HOME×AWAY deixaria o empate a
        // descoberto e a "surebet" viraria prejuízo no empate).
        if (papel('DRAW')) continue;
        const h = papel('HOME');
        const a = papel('AWAY');
        if (!h || !a || sels.length !== 2) continue;
        out.push({
          esporte, evento, dataHora, mercado: cfg.rotulo,
          opcaoA: home, opcaoB: away, oddA: h.odds!, oddB: a.odds!, url,
        });
      } else if (cfg.tipo === 'BTTS') {
        const sim = papel('YES');
        const nao = papel('NO');
        if (!sim || !nao) continue;
        out.push({
          esporte, evento, dataHora, mercado: cfg.rotulo,
          opcaoA: 'Sim', opcaoB: 'Não', oddA: sim.odds!, oddB: nao.odds!, url,
        });
      }
    }
  }

  /** Identidade do evento (times na ordem certa, data, link) — null se não servir. */
  private dadosDoEvento(
    ev: BsEvent,
    cid: number
  ): { evento: string; home: string; away: string; dataHora: string; url?: string } | null {
    // Só confronto 1×1 (outright/torneio não tem duas pernas para cruzar).
    const parts = (ev.participants || []).slice().sort((a, b) => (a.sortOrder || a.side || 0) - (b.sortOrder || b.side || 0));
    if (parts.length !== 2) return null;
    const home = (parts[0].label || '').trim();
    const away = (parts[1].label || '').trim();
    if (!home || !away) return null;

    // Sem incluirAoVivo, partida já iniciada sai fora (o scanner de surebets é pré-jogo).
    const t = Date.parse(ev.startDate || '');
    if (!this.cfg.incluirAoVivo && !isNaN(t) && t <= Date.now()) return null;

    const evento = `${home} vs ${away}`;
    // Alimenta o atalho da revalidação: com o campeonato em mão a busca dirigida é
    // 1 request em vez de repaginar o esporte.
    if (ev.competitionId) {
      this.competicaoPorEvento.set(this.chaveEvento(evento), { cid, competitionId: ev.competitionId });
    }
    return {
      evento,
      home,
      away,
      dataHora: ev.startDate || 'Hoje',
      url: ev.slug ? `${BASE}/apostas-esportivas/${ev.slug}` : undefined,
    };
  }

  private chaveEvento(evento: string): string {
    return evento
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /**
   * Busca dirigida de UM evento (revalidação pré-alerta do WhatsApp).
   *
   * Caminho rápido: se a varredura já viu o evento, reconsulta SÓ o campeonato dele
   * (`competitionIds`) — 1 request, ~1s. Caminho lento: pagina o esporte com teto curto
   * e para no primeiro casamento.
   *
   * Contrato de falha (igual Betnacional): `throw` quando NENHUMA requisição serviu
   * (infra → o gate remove a linha e re-gateia), `[]` quando o feed respondeu mas o
   * evento não está lá (ausência genuína → supressão definitiva).
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const cids = esporte && SPORT_CID[esporte] ? [SPORT_CID[esporte]] : [...new Set(Object.values(SPORT_CID))];
    let algumOk = false;

    // ── Caminho rápido: campeonato conhecido.
    const atalho = this.competicaoPorEvento.get(this.chaveEvento(evento));
    if (atalho && (!esporte || cids.includes(atalho.cid))) {
      for (const fase of this.fases()) {
        const d = await this.buscarPagina(
          atalho.cid, 1, fase, `${this.cfg.nome}/reval-comp`, atalho.competitionId, 1, 10000
        );
        if (!d) continue;
        algumOk = true;
        const out: ScrapedOdd[] = [];
        this.parsePagina(d, atalho.cid, out);
        const doEvento = out.filter((o) => areEventsSame(o.evento, evento));
        if (doEvento.length) return this.dedupar(doEvento);
      }
    }

    // ── Fallback paginado (perna sem cache: SureRadar/Telegram, ou reinício do processo).
    const maxPaginas = Math.min(this.cfg.maxPaginasPorEsporte, 8);
    for (const cid of cids) {
      for (const fase of this.fases()) {
        for (let pagina = 1; pagina <= maxPaginas; pagina++) {
          const d = await this.buscarPagina(cid, pagina, fase, `${this.cfg.nome}/reval`, undefined, 1, 10000);
          if (!d) break;
          algumOk = true;
          if (!(d.events || []).length) break;
          const out: ScrapedOdd[] = [];
          this.parsePagina(d, cid, out);
          const doEvento = out.filter((o) => areEventsSame(o.evento, evento));
          if (doEvento.length) return this.dedupar(doEvento);
          if (d.totalPages && pagina >= d.totalPages) break;
        }
      }
    }

    if (!algumOk) throw new Error(`${this.cfg.nome}: feed indisponível na busca dirigida`);
    return [];
  }
}
