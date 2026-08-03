import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';

/**
 * BetEsporte (betesporte.bet.br) — plataforma própria "SA Esportes"/SA Online (ASP.NET)
 * com feed de dados da Sportradar. API REST PÚBLICA same-origin: GET, SEM auth/cookie/
 * token (curl cru responde 200). Odds em DECIMAL. Recon completo em 31/07/2026.
 *
 * Fluxo em 2 FASES (mesmo espírito do casa_altenar.ts):
 *  1. LISTA por janela: GET /api/PreMatch/GetEventsByDate?sportId=&startDate=&endDate=
 *     → data.countries[].tournaments[].events[]. Vem 1 request por esporte e já traz o
 *     mercado PRINCIPAL de cada evento (futebol: 1x2; demais: o vencedor 2-vias), ou
 *     seja: resultado final de TODO o catálogo de graça (708 eventos de futebol em 48h).
 *  2. DETALHE (é onde vive handicap/total): GET /api/PreMatch/GetEventDetail?eventId=
 *     &sportId=&tournamentId=&countryId= → MESMA forma da lista, ~130 mercados. Os 4
 *     params são OBRIGATÓRIOS, então a tripla (evento, torneio, país) é guardada na fase 1.
 *     1 request por evento → NÃO se puxa detalhe de todos (ver maxEventosDetalhePorEsporte).
 *
 * AO VIVO: GET /api/Live/GetEvents (1 request, TODOS os esportes de uma vez, com
 * homeScore/period/time) + /api/Live/GetEventDetail com os mesmos 4 params.
 *
 * PACER (medido): concorrência 1 e ~4 req/s. Concorrência 4 já devolveu 429 no recon,
 * por isso NÃO se usa comLimite aqui — os requests são sequenciais com intervalo mínimo
 * (a VPS é 1-core, então serializar também é o que ela aguenta). 429 é tratado como
 * CIRCUIT BREAKER: loga o retry-after, marca a casa como bloqueada no ciclo e devolve o
 * que já foi coletado, sem insistir na chamada.
 *
 * Limites públicos da casa (GET /api/config/getConfig): minBetAmount 1.00,
 * maxBetAmount 4000.00 — relevante para a calculadora de stake, não para o parser.
 */

const HOST = 'https://betesporte.bet.br';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// sportId da casa → rótulo interno do esporte. Os rótulos são os MESMOS que Altenar/
// BetBoom/NSoft emitem (o engine agrupa por esporte sem normalizar nada além de acento,
// então "Tenis de Mesa" ≠ "TenisDeMesa" na hora de cruzar).
// FORA de propósito: 29=Futsal e 16=Futebol Americano (existem no feed, mas NENHUMA casa
// já integrada cobre esses esportes — só virariam peso morto no motor) e 137/201
// (eSoccer/eFootball, odd de virtual).
const SPORT_LABEL: Record<number, string> = {
  1: 'Futebol',
  2: 'Basquete',
  5: 'Tenis',
  20: 'Tenis de Mesa',
  23: 'Volei',
  3: 'Beisebol',
  205: 'Esports', // CS2
  203: 'Esports', // League of Legends
  209: 'Esports', // Dota 2
  207: 'Esports', // Valorant
};

// esporte do scanner → sportIds da casa. Aceita as grafias que o scanner_v2 usa e as
// acentuadas (mesma tolerância do casa_altenar.ts).
const ESPORTE_SPORTS: Record<string, number[]> = {
  Futebol: [1],
  Basquete: [2],
  Tenis: [5],
  'Tênis': [5],
  TenisDeMesa: [20],
  'Tenis de Mesa': [20],
  'Tênis de Mesa': [20],
  Volei: [23],
  'Vôlei': [23],
  Beisebol: [3],
  Esports: [205, 203, 209, 207],
  'E-Sports': [205, 203, 209, 207],
};

/**
 * WHITELIST DE MERCADOS POR sportId, mapeada pelo `type` NUMÉRICO (nunca pelo nome, que
 * a casa localiza/reescreve). Todos os types abaixo foram VISTOS no feed real em 31/07.
 *
 * Nos esportes Sportradar o `type` é o market id do UOF — os mesmos números que o
 * casa_betboom.ts já usa (16/18 futebol, 186/187/188/189 tênis, 219/223/225 basquete,
 * 237/238 pontos, 251/256/258 beisebol). E-sports vêm de OUTRO provedor (externalId
 * "od:player:..."), com numeração PRÓPRIA e conflitante — daí a chave 'ES' separada.
 *
 * Ficam FORA de propósito:
 *  - 1601 "1x2 (Pagamento antecipado)": promoção de pagamento antecipado (123 dos 709
 *    eventos de futebol trazem SÓ ela na lista). Não é o 1x2 padrão e não liquida igual.
 *  - 19/20/227/228/260/261/190/191 (total por-time), 165/166 (escanteios), 66/68/90 e
 *    tudo com "1ª/2ª parte" (períodos), 202/203 (por set), 126/127/162/169 (por time/
 *    jogador em e-sports): mercados que nenhuma casa já integrada emite ou que exigem
 *    ler a linha do nome sem campo `line` — não valem o risco de pareamento agora.
 *  - 235 "Nº quarto - 1x2" e afins: 3 vias por período.
 */
type Tipo =
  | 'rf2' // vencedor 2-vias da partida
  | 'dc3' // 1x2 de 3 vias → dupla chance SINTÉTICA (futebol)
  | 'total'
  | 'handicap'
  | 'btts'
  | 'dnb'
  | 'mapa_vencedor'
  | 'mapa_total'
  | 'mapa_handicap';

interface MercadoCfg {
  tipo: Tipo;
  label?: string;
  /**
   * Guarda por NOME quando o `type` sozinho é ambíguo. Em e-sports o type 6 traz tanto
   * "Vencedor do Mapa 1 - (incluindo OT)" (2 vias) quanto "Vencedor do Mapa 1 - 1x2"
   * (3 vias), e os types 11/24 precisam do número do mapa que só existe no nome.
   */
  nome?: RegExp;
}

const MERCADOS: Record<string, Record<number, MercadoCfg>> = {
  // --- Futebol ---
  '1': {
    1: { tipo: 'dc3' }, // 1x2 → dupla chance sintética
    16: { tipo: 'handicap', label: 'Handicap' },
    18: { tipo: 'total', label: 'Total de Gols' },
    11: { tipo: 'dnb', label: 'Empate Anula' }, // "Empate devolve aposta", 2 vias limpas
    29: { tipo: 'btts', label: 'Ambas equipes marcam' },
  },
  // --- Basquete: SÓ as versões "(incluindo prolongamento)". Cruzar mercado sem
  // prorrogação com o "incl. OT" de outra casa é liquidação diferente = proibido. ---
  '2': {
    219: { tipo: 'rf2' },
    223: { tipo: 'handicap', label: 'Handicap' },
    225: { tipo: 'total', label: 'Total de Pontos' },
  },
  // --- Tênis: 187/189 são de GAMES (o handicap/total "geral" do tênis, convenção que já
  // vale na Pinnacle/BetBoom/NSoft); 188 é de SETS e sai com rótulo próprio. ---
  '5': {
    186: { tipo: 'rf2' },
    187: { tipo: 'handicap', label: 'Handicap' },
    189: { tipo: 'total', label: 'Total de Games' },
    188: { tipo: 'handicap', label: 'Handicap de Sets' },
  },
  // --- Tênis de mesa e vôlei: handicap/total de PONTOS (rótulo com assunto, para nunca
  // colidir com handicap de SETS de outra casa). ---
  '20': {
    186: { tipo: 'rf2' },
    237: { tipo: 'handicap', label: 'Handicap de Pontos' },
    238: { tipo: 'total', label: 'Total de Pontos' },
  },
  '23': {
    186: { tipo: 'rf2' },
    237: { tipo: 'handicap', label: 'Handicap de Pontos' },
    238: { tipo: 'total', label: 'Total de Pontos' },
  },
  // --- Beisebol: versões "(incluindo innings extra)", que é o padrão MLB das outras casas. ---
  '3': {
    251: { tipo: 'rf2' },
    256: { tipo: 'handicap', label: 'Handicap' },
    258: { tipo: 'total', label: 'Total de Corridas' },
  },
  // --- E-sports (numeração do provedor de e-sports, NÃO do Sportradar) ---
  ES: {
    1: { tipo: 'rf2' }, // "Vencedor da Partida - (incluindo OT)"
    2: { tipo: 'handicap', label: 'Handicap de Mapas', nome: /^handicap da partida$/i },
    3: { tipo: 'total', label: 'Total de Mapas', nome: /^total de mapas$/i },
    6: { tipo: 'mapa_vencedor' }, // "Vencedor do Mapa N - (incluindo OT)"
    24: { tipo: 'mapa_total', nome: /^total de rounds\s*-\s*mapa\s*(\d+)$/i },
    11: { tipo: 'mapa_handicap', nome: /^handicap de rounds\s*-\s*mapa\s*(\d+)$/i },
  },
};

/**
 * externalId de cada perna, por NAMESPACE de provedor. Validado no feed real de 31/07
 * (454 mercados de e-sports e 189 do Sportradar conferidos): a ORDEM do array `options`
 * VARIA entre eventos, então a perna é escolhida SEMPRE pelo externalId, nunca por índice.
 */
const OUT_SR = {
  home: '4', away: '5', // vencedor 2-vias e DNB
  casa: '1', empate: '2', fora: '3', // 1x2
  over: '12', under: '13',
  hHome: '1714', hAway: '1715',
  sim: '74', nao: '76',
};
const OUT_ES = {
  home: '1', away: '2',
  over: '5', under: '4',
  hHome: '1', hAway: '2',
  empate: '3', // só existe na variante 1x2, que é descartada
};

interface BeOption {
  id?: number; name?: string; odd?: number; externalId?: string;
  locked?: boolean; blocked?: boolean; hide?: boolean;
}
interface BeMarket {
  id?: number; name?: string; type?: number; locked?: boolean;
  line?: string | null; options?: BeOption[];
}
interface BeEvent {
  id: number; homeTeamName?: string; awayTeamName?: string; date?: string;
  optionsCount?: number; markets?: BeMarket[]; blocked?: boolean;
  // presentes só no feed /api/Live (não usados: o consumidor deduz "ao vivo" pelo
  // dataHora no passado e ScrapedOdd é tipo compartilhado)
  homeScore?: number; awayScore?: number; period?: string; time?: string;
}
interface BeTournament { id: number; name?: string; events?: BeEvent[]; blocked?: boolean; }
interface BeCountry { id: number; name?: string; tournaments?: BeTournament[]; blocked?: boolean; }
interface BeSportNode { id: number; name?: string; countries?: BeCountry[]; }

/** Evento + a tripla de ids que o GetEventDetail exige. */
export interface BeRef {
  ev: BeEvent;
  sportId: number;
  tournamentId: number;
  countryId: number;
}

export class BetEsporteScraper implements OddsScraper {
  /**
   * Agente/Radar ao vivo: quando true a coleta TROCA de feed (/api/Live/*) e MANTÉM
   * partida em andamento. Igual ao casa_altenar.ts, a flag troca o endpoint em vez de só
   * relaxar o filtro porque o GetEventsByDate filtra por `date` na janela [agora, +48h] —
   * jogo já iniciado simplesmente não aparece nele. O scanner de surebet constrói SEM a
   * opção e continua percorrendo o mesmo caminho pré-jogo.
   */
  private incluirAoVivo: boolean;
  /** Janela do pré-jogo. 48h é a mesma do resto do projeto (prematch-melhorias). */
  private janelaHoras: number;
  /**
   * Teto de DETALHES por esporte. É o análogo do maxCampeonatosPorEsporte do Altenar:
   * cada detalhe é 1 request e só o futebol tem ~708 eventos em 48h, o que a 4 req/s
   * levaria 3 min só nele. Os escolhidos são os de maior `optionsCount` (proxy direto de
   * profundidade de mercado: 785 opções num jogo de liga grande × 20 num de tênis de
   * mesa), então cada request gasto rende o máximo de linhas arbitráveis.
   */
  private maxEventosDetalhePorEsporte: number;
  /** Intervalo mínimo entre requests (≈3,8 req/s). Concorrência 4 devolveu 429 no recon. */
  private readonly intervaloMs = 260;
  private ultimoReq = 0;
  /** Circuit breaker: 429 desliga a casa pelo resto do ciclo. */
  private bloqueada = false;

  constructor(opts?: {
    incluirAoVivo?: boolean;
    maxEventosDetalhePorEsporte?: number;
    janelaHoras?: number;
  }) {
    this.incluirAoVivo = !!opts?.incluirAoVivo;
    this.maxEventosDetalhePorEsporte = opts?.maxEventosDetalhePorEsporte ?? 20;
    this.janelaHoras = opts?.janelaHoras ?? 48;
  }

  getNome(): string {
    return 'BetEsporte';
  }

  private headers() {
    return {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: `${HOST}/`,
      Origin: HOST,
    };
  }

  /** Serializa e espaça os requests (pacer do recon: concorrência 1, ~4 req/s). */
  private async pace(): Promise<void> {
    const espera = this.ultimoReq + this.intervaloMs - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    this.ultimoReq = Date.now();
  }

  /**
   * GET + JSON com pacer e circuit breaker. Devolve null em qualquer falha (a casa é
   * best-effort dentro do ciclo); 429 marca `bloqueada` para parar de insistir.
   */
  private async getJson(url: string, tag: string, rapido = false): Promise<any | null> {
    if (this.bloqueada) return null;
    await this.pace();
    let resp;
    try {
      resp = await fetchTextoComRetry(
        url, { headers: this.headers() }, rapido ? 1 : 2, `BetEsporte/${tag}`, rapido ? 10000 : 20000
      );
    } catch {
      return null;
    }
    if (resp.status === 429) {
      // Não reenvia: o recon mostrou que a casa corta por taxa. Para a casa no ciclo e
      // devolve o que já foi coletado (o próximo ciclo começa limpo).
      const ra = resp.headers['retry-after'] || '?';
      console.warn(`   ⚠️ [BetEsporte] 429 em ${tag} (retry-after: ${ra}) — casa pausada neste ciclo.`);
      this.bloqueada = true;
      return null;
    }
    if (resp.status !== 200) return null;
    try {
      return JSON.parse(resp.body);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Fase 1 — lista
  // -------------------------------------------------------------------------

  /**
   * Baixa a lista dos esportes pedidos. No pré-jogo é 1 request por sportId; ao vivo é
   * UM request só (/api/Live/GetEvents devolve todos os esportes de uma vez).
   */
  private async listar(sportIds: number[], rapido = false): Promise<BeSportNode[]> {
    if (this.incluirAoVivo) {
      const j = await this.getJson(`${HOST}/api/Live/GetEvents`, 'live', rapido);
      const nodes: BeSportNode[] = Array.isArray(j?.data) ? j.data : [];
      const alvo = new Set(sportIds);
      return nodes.filter((n) => alvo.has(n?.id));
    }
    const agora = Date.now();
    const inicio = new Date(agora).toISOString();
    const fim = new Date(agora + this.janelaHoras * 3600_000).toISOString();
    const nodes: BeSportNode[] = [];
    for (const sid of sportIds) {
      if (this.bloqueada) break;
      const j = await this.getJson(
        `${HOST}/api/PreMatch/GetEventsByDate?sportId=${sid}` +
          `&startDate=${encodeURIComponent(inicio)}&endDate=${encodeURIComponent(fim)}&searchNextDays=false`,
        `lista/${sid}`,
        rapido
      );
      // A janela é interpretada em UTC (conferido: os `date` devolvidos ficam dentro dela),
      // o mesmo fuso em que o projeto trata dataHora.
      if (j?.data?.countries) nodes.push(j.data as BeSportNode);
    }
    return nodes;
  }

  /**
   * Achata countries→tournaments→events guardando a tripla de ids, descartando o que
   * está bloqueado e aplicando a regra de pré-jogo. Público para o teste de unidade.
   */
  public refsElegiveis(nodes: BeSportNode[], sportIdsAlvo: Set<number>, agora = Date.now()): BeRef[] {
    const refs: BeRef[] = [];
    const vistos = new Set<number>();
    for (const node of nodes || []) {
      const sportId = node?.id;
      if (!sportIdsAlvo.has(sportId) || !SPORT_LABEL[sportId]) continue;
      for (const c of node.countries || []) {
        if (c.blocked) continue;
        for (const t of c.tournaments || []) {
          if (t.blocked) continue;
          for (const ev of t.events || []) {
            if (!ev || ev.blocked) continue;
            if (vistos.has(ev.id)) continue;
            if (!ev.homeTeamName || !ev.awayTeamName) continue;
            const t0 = Date.parse(ev.date || '');
            if (!Number.isFinite(t0)) continue; // sem kickoff confiável não se emite nada
            // Sem a flag: SÓ pré-jogo. Com ela, mantém a partida em andamento.
            if (!this.incluirAoVivo && t0 <= agora) continue;
            vistos.add(ev.id);
            refs.push({ ev, sportId, tournamentId: t.id, countryId: c.id });
          }
        }
      }
    }
    return refs;
  }

  // -------------------------------------------------------------------------
  // Fase 2 — detalhe
  // -------------------------------------------------------------------------

  /** Mercados completos de UM evento (~130 no futebol). Os 4 params são obrigatórios. */
  private async detalhe(ref: BeRef, rapido = false): Promise<BeMarket[] | null> {
    const rota = this.incluirAoVivo ? 'Live' : 'PreMatch';
    const j = await this.getJson(
      `${HOST}/api/${rota}/GetEventDetail?eventId=${ref.ev.id}&sportId=${ref.sportId}` +
        `&tournamentId=${ref.tournamentId}&countryId=${ref.countryId}`,
      `detalhe/${ref.sportId}`,
      rapido
    );
    // O detalhe repete a MESMA árvore da lista, com 1 país/1 torneio/1 evento.
    const ev = j?.data?.countries?.[0]?.tournaments?.[0]?.events?.[0];
    const mercados = ev?.markets;
    return Array.isArray(mercados) && mercados.length ? mercados : null;
  }

  // -------------------------------------------------------------------------
  // Coleta
  // -------------------------------------------------------------------------

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(
      `🤖 [BetEsporte] Extração via API própria (SA Esportes)${this.incluirAoVivo ? ' — AO VIVO' : ''}...`
    );
    this.bloqueada = false;
    const sportIds: number[] = [];
    for (const e of esportes) for (const sid of ESPORTE_SPORTS[e] || []) if (!sportIds.includes(sid)) sportIds.push(sid);
    if (!sportIds.length) return [];

    const nodes = await this.listar(sportIds);
    const refs = this.refsElegiveis(nodes, new Set(sportIds));
    if (!refs.length) {
      console.log(`✅ [BetEsporte] Total: 0 odds (nenhum evento na janela).`);
      return [];
    }

    // Quem ganha detalhe: os de maior optionsCount, com o teto POR ESPORTE (os 4 sportIds
    // de e-sports compartilham o rótulo "Esports" e, portanto, o mesmo teto).
    const porEsporte = new Map<string, BeRef[]>();
    for (const r of refs) {
      const esp = SPORT_LABEL[r.sportId];
      const lista = porEsporte.get(esp) || [];
      lista.push(r);
      porEsporte.set(esp, lista);
    }
    const comDetalhe = new Set<number>();
    for (const lista of porEsporte.values()) {
      [...lista]
        .sort((a, b) => (b.ev.optionsCount || 0) - (a.ev.optionsCount || 0))
        .slice(0, this.maxEventosDetalhePorEsporte)
        .forEach((r) => comDetalhe.add(r.ev.id));
    }

    const todas: ScrapedOdd[] = [];
    for (const ref of refs) {
      // O detalhe é SUPERSET da lista (traz o mercado principal também), então quando ele
      // vem não se parseia a lista — senão a mesma oferta entraria 2x.
      let mercados = ref.ev.markets || [];
      if (comDetalhe.has(ref.ev.id) && !this.bloqueada) {
        const det = await this.detalhe(ref);
        if (det) mercados = det;
      }
      todas.push(...this.parseEvento(ref, mercados));
    }

    const porRotulo: Record<string, number> = {};
    for (const o of todas) porRotulo[o.esporte] = (porRotulo[o.esporte] || 0) + 1;
    for (const [esp, n] of Object.entries(porRotulo)) console.log(`   [BetEsporte] ${esp}: ${n} odds`);
    console.log(`✅ [BetEsporte] Total: ${todas.length} odds (${refs.length} eventos).`);
    return todas;
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta / skills do agente): lista o esporte, casa o
   * nome com areEventsSame e puxa o DETALHE só do evento achado — 2 requests quando o
   * esporte é conhecido (a lista já é filtrada pela janela pela própria API).
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    this.bloqueada = false;
    try {
      const sportIds =
        esporte && ESPORTE_SPORTS[esporte]
          ? ESPORTE_SPORTS[esporte]
          : [...new Set(Object.values(ESPORTE_SPORTS).flat())];
      const nodes = await this.listar(sportIds, true);
      const refs = this.refsElegiveis(nodes, new Set(sportIds)).filter((r) =>
        areEventsSame(`${r.ev.homeTeamName} vs ${r.ev.awayTeamName}`, evento)
      );
      const out: ScrapedOdd[] = [];
      // Mais de 1 casamento é raro (homônimos em torneios distintos); 2 é teto de custo.
      for (const ref of refs.slice(0, 2)) {
        const det = await this.detalhe(ref, true);
        out.push(...this.parseEvento(ref, det || ref.ev.markets || []));
      }
      return out;
    } catch {
      return []; // melhor esforço: revalidação sem resposta cai no fallback do chamador
    }
  }

  // -------------------------------------------------------------------------
  // Parser
  // -------------------------------------------------------------------------

  /** Odd realmente apostável: sem trava e maior que 1 (odd travada vem com odd 0). */
  private ativa(o?: BeOption): boolean {
    return !!o && !o.locked && !o.blocked && !o.hide && typeof o.odd === 'number' && o.odd > 1;
  }

  /** Linha de handicap embutida no rótulo: "Casa (-2.5)" (Sportradar) ou "FURIA +2.5" (e-sports). */
  private linhaDoRotuloHandicap(nome?: string): number | null {
    const s = (nome || '').trim();
    const m = s.match(/\(([+-]?\d+(?:[.,]\d+)?)\)\s*$/) || s.match(/([+-]\d+(?:[.,]\d+)?)\s*$/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /** Linha de total embutida no rótulo: "Mais de 2.5" / "menos de 21.5". */
  private linhaDoRotuloTotal(nome?: string): number | null {
    const m = (nome || '').match(/(?:mais|menos|acima|abaixo)\s+de\s+([+-]?\d+(?:[.,]\d+)?)/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Linha final do mercado. O campo `line` só vem preenchido em ALGUNS types (futebol
   * 16/18); no resto a linha existe apenas no rótulo da opção. Quando os dois existem e
   * DIVERGEM, descarta: divergência aqui significaria sinal/valor errado, e handicap com
   * sinal trocado já foi fonte de ROI fabricado neste projeto.
   */
  private resolverLinha(m: BeMarket, doRotulo: number | null): number | null {
    const doCampo = m.line != null && m.line !== '' ? parseFloat(String(m.line).replace(',', '.')) : NaN;
    const temCampo = Number.isFinite(doCampo);
    if (doRotulo === null) return temCampo ? doCampo : null;
    if (temCampo && Math.abs(doCampo - doRotulo) > 1e-9) return null;
    return doRotulo;
  }

  /**
   * Converte os mercados de UM evento em ScrapedOdds. Público para o teste de unidade
   * (fixture inline, sem rede).
   */
  public parseEvento(ref: BeRef, mercados: BeMarket[]): ScrapedOdd[] {
    const esporte = SPORT_LABEL[ref.sportId];
    if (!esporte) return [];
    const cfgMercados = MERCADOS[esporte === 'Esports' ? 'ES' : String(ref.sportId)];
    if (!cfgMercados) return [];
    const home = (ref.ev.homeTeamName || '').trim();
    const away = (ref.ev.awayTeamName || '').trim();
    if (!home || !away) return [];
    const evento = `${home} vs ${away}`;
    const dataHora = ref.ev.date || '';
    if (!Number.isFinite(Date.parse(dataHora))) return []; // nunca inventar kickoff
    const ehEsports = esporte === 'Esports';
    const ID = ehEsports ? OUT_ES : OUT_SR;
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
    const out: ScrapedOdd[] = [];
    // A casa repete o mesmo par (mercado, linha) em torneios/blocos diferentes de vez em
    // quando; emitir 2x a mesma oferta polui o cluster do motor sem adicionar nada.
    const emitidos = new Set<string>();
    const emitir = (o: ScrapedOdd) => {
      const chave = `${o.mercado}|${o.linha ?? ''}`;
      if (emitidos.has(chave)) return;
      emitidos.add(chave);
      out.push(o);
    };

    for (const m of mercados || []) {
      const cfg = m?.type != null ? cfgMercados[m.type] : undefined;
      if (!cfg || m.locked) continue;
      const mNome = cfg.nome ? (m.name || '').trim().match(cfg.nome) : null;
      if (cfg.nome && !mNome) continue;
      const porId = new Map<string, BeOption>();
      for (const o of m.options || []) if (o?.externalId) porId.set(o.externalId, o);
      const op = (id: string) => {
        const o = porId.get(id);
        return this.ativa(o) ? o! : undefined;
      };

      switch (cfg.tipo) {
        // --- 1x2 de 3 vias → DUPLA CHANCE SINTÉTICA (dividir a mão entre empate e fora),
        //     mesma convenção de Altenar/Pinnacle/Kambi/Superbet. 3 vias cru não entra. ---
        case 'dc3': {
          const oCasa = op(OUT_SR.casa);
          const oEmpate = op(OUT_SR.empate);
          const oFora = op(OUT_SR.fora);
          if (!oCasa || !oEmpate || !oFora) continue;
          const oddDC = 1 / (1 / oEmpate.odd! + 1 / oFora.odd!);
          // Mandante zebra extrema + margem alta faz a combinada cair abaixo de 1.0:
          // apostar nos dois lados custaria mais do que retorna, nunca compõe arbitragem.
          if (!(oddDC > 1)) continue;
          emitir({
            esporte, evento, dataHora, mercado: 'Resultado Final',
            opcaoA: `Vitória ${home}`, opcaoB: `${away} ou Empate`,
            oddA: oCasa.odd!, oddB: oddDC,
          });
          break;
        }

        // --- Vencedor 2 vias da partida ---
        case 'rf2': {
          // Em e-sports o MESMO type traz a variante 1x2 (com empate no externalId 3):
          // 3 vias em e-sports é proibido pelas Diretrizes, e o descarte é ESTRUTURAL
          // (presença do empate), não por nome — nome a casa reescreve, id não.
          if (ehEsports && porId.has(OUT_ES.empate!)) continue;
          const oH = op(ID.home);
          const oA = op(ID.away);
          if (!oH || !oA) continue;
          emitir({
            esporte, evento, dataHora, mercado: 'Resultado Final',
            opcaoA: home, opcaoB: away, oddA: oH.odd!, oddB: oA.odd!,
          });
          break;
        }

        // --- Empate anula (DNB): 2 vias, empate reembolsa ---
        case 'dnb': {
          const oH = op(OUT_SR.home);
          const oA = op(OUT_SR.away);
          if (!oH || !oA) continue;
          emitir({
            esporte, evento, dataHora, mercado: cfg.label!,
            opcaoA: home, opcaoB: away, oddA: oH.odd!, oddB: oA.odd!,
          });
          break;
        }

        // --- Ambas marcam: Sim/Não ---
        case 'btts': {
          const sim = op(OUT_SR.sim);
          const nao = op(OUT_SR.nao);
          if (!sim || !nao) continue;
          emitir({
            esporte, evento, dataHora, mercado: cfg.label!,
            opcaoA: 'Sim', opcaoB: 'Não', oddA: sim.odd!, oddB: nao.odd!,
          });
          break;
        }

        // --- Totais (partida e por mapa) ---
        case 'total':
        case 'mapa_total': {
          const over = op(ID.over);
          const under = op(ID.under);
          if (!over || !under) continue;
          const linha = this.resolverLinha(m, this.linhaDoRotuloTotal(over.name));
          // Meia-linha e quarter asiática; linha INTEIRA fica fora (push = lucro zero).
          if (linha === null || !linhaArbitravel(linha)) continue;
          const mercado =
            cfg.tipo === 'mapa_total' ? `Mapa ${mNome![1]} - Total de rodadas` : cfg.label!;
          emitir({
            esporte, evento, dataHora, mercado, linha,
            opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
            oddA: over.odd!, oddB: under.odd!,
          });
          break;
        }

        // --- Handicaps (partida e por mapa): linha na perspectiva do MANDANTE ---
        case 'handicap':
        case 'mapa_handicap': {
          const oH = op(ID.hHome);
          const oA = op(ID.hAway);
          if (!oH || !oA) continue;
          const linha = this.resolverLinha(m, this.linhaDoRotuloHandicap(oH.name));
          if (linha === null || !linhaArbitravel(linha)) continue;
          const mercado =
            cfg.tipo === 'mapa_handicap' ? `Mapa ${mNome![1]} - Handicap de rodadas` : cfg.label!;
          emitir({
            esporte, evento, dataHora, mercado, linha,
            opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
            oddA: oH.odd!, oddB: oA.odd!,
          });
          break;
        }

        // --- Vencedor de MAPA específico (e-sports): mercado distinto do da partida ---
        case 'mapa_vencedor': {
          if (porId.has(OUT_ES.empate!)) continue; // variante 1x2 do mesmo type
          const n = (m.name || '').match(/mapa\s*(\d+)/i);
          if (!n) continue;
          const oH = op(OUT_ES.home);
          const oA = op(OUT_ES.away);
          if (!oH || !oA) continue;
          emitir({
            esporte, evento, dataHora, mercado: `Mapa ${n[1]}`,
            opcaoA: home, opcaoB: away, oddA: oH.odd!, oddB: oA.odd!,
          });
          break;
        }
      }
    }
    return out;
  }
}
