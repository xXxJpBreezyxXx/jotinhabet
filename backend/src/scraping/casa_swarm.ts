import WebSocket from 'ws';
import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';

/**
 * Scraper genérico para casas na plataforma BetConstruct "Swarm" (WebSocket JSON) —
 * ex.: SeuBet (eu-swarm-springre.trexname.com, site_id 18749911). A Vbet usa o MESMO
 * protocolo (wss://eu-swarm-newm.vbet.bet.br/) — integrável só com config.
 *
 * Protocolo (descoberto via captura Playwright + probes em 17/07/2026):
 *  - {"command":"request_session","params":{language,site_id,source:42},"rid"} → sid.
 *    A sessão anuncia Turnstile, mas ele NÃO bloqueia leitura pública de odds.
 *  - {"command":"get","params":{source:"betting", what:{game,market,event: [campos]},
 *     where:{sport:{id}, game:{is_live:0}, market:{type:{"@in":[...]}}}, subscribe:false}}
 *    → árvore { game: { id: { market: { id: { event: {...} } } } } }.
 *  - SEM filtro de market.type a resposta explode (Soccer tem 851 mercados/jogo) —
 *    sempre filtrar pelos tipos da whitelist.
 *  - is_live é BUCKET, não estado: 0 = pré-jogo, 1 = ao vivo (mas com jogos "notstarted"
 *    prestes a começar). O estado real está em game.info (current_game_state/score1/score2/
 *    current_game_time), pedido só quando incluirAoVivo. Tipos de mercado ao vivo = os mesmos.
 *
 * Convenções do feed (validadas em jogos reais):
 *  - Totais: market.base = linha; events type_1 Over/Under (mesmo base).
 *  - Handicaps: CADA EVENTO carrega seu base; a linha do MANDANTE é o base do evento
 *    Home (market.base às vezes é o lado oposto — visto no tênis) — NUNCA usar market.base.
 *  - Vencedor 2-vias: type "P1P2", events type_1 W1/W2.
 *  - P1XP2 (3-vias) fica FORA: futebol 1X2 é proibido nas Diretrizes e no basquete o
 *    3-vias é "tempo regular" (liquidação diferente do vencedor incl. OT das outras casas).
 *  - Mercados de estatística (Shots:Total, CornersOverUnder, Faltas...) têm TYPES
 *    próprios → a whitelist por tipo já os exclui (fail-closed).
 */

interface SwarmConfig {
  nome: string;
  wsUrl: string;
  siteId: number;
  origin: string;
  // Varredura ao vivo (agente/cashout): quando true o `where` pede is_live @in [0,1] e o
  // parser NÃO exige início no futuro — o scanner de surebet pré-match constrói SEM esta
  // opção e continua vendo exatamente os mesmos jogos de antes.
  incluirAoVivo?: boolean;
}

interface SwarmEventOdd { id: number; price?: number; base?: number; type_1?: string; }
interface SwarmMarket { id: number; type?: string; name?: string; base?: number; event?: Record<string, SwarmEventOdd>; }
/** info só vem quando incluirAoVivo (pedido a mais no `what.game`); traz estado/placar/tempo. */
interface SwarmGameInfo { current_game_state?: string; current_game_time?: string; score1?: string; score2?: string; }
interface SwarmGame {
  id: number; team1_name?: string; team2_name?: string; start_ts?: number; is_blocked?: number;
  is_live?: number; info?: SwarmGameInfo;
  market?: Record<string, SwarmMarket>;
}

// esporte interno → sport ids do Swarm (BetConstruct). Beisebol não existe no SeuBet.
const ESPORTE_SPORTS: Record<string, number[]> = {
  Futebol: [1],
  Basquete: [3],
  Tenis: [4],
  Tênis: [4],
  Volei: [5],
  'Vôlei': [5],
  TenisDeMesa: [41],
  'Tenis de Mesa': [41],
  'Tênis de Mesa': [41],
  Esports: [75, 76, 77, 208], // CS, Dota 2, LoL, Valorant (whitelist Diretrizes §5)
  'E-Sports': [75, 76, 77, 208],
};
const SPORT_LABEL: Record<number, string> = {
  1: 'Futebol', 3: 'Basquete', 4: 'Tenis', 5: 'Volei', 41: 'Tenis de Mesa',
  75: 'Esports', 76: 'Esports', 77: 'Esports', 208: 'Esports',
};

/** Whitelist de tipos de mercado por sport id, com rótulo canônico (assunto correto). */
interface TipoCfg { modo: 'rf' | 'total' | 'handicap'; label?: string; }
const TIPOS_POR_SPORT: Record<number, Record<string, TipoCfg>> = {
  1: {
    OverUnder: { modo: 'total', label: 'Total de Gols' },
    AsianHandicap: { modo: 'handicap', label: 'Handicap' },
  },
  3: {
    P1P2: { modo: 'rf' }, // 2-vias sem empate → inclui prorrogação (o "tempo regular" é o P1XP2)
    MatchTotal: { modo: 'total', label: 'Total de Pontos' },
    MatchHandicap: { modo: 'handicap', label: 'Handicap' },
  },
  4: {
    P1P2: { modo: 'rf' },
    'TotalGamesOver/Under': { modo: 'total', label: 'Total de Games' },
    Handicap: { modo: 'handicap', label: 'Handicap' }, // games (GERAL, como a Pinnacle)
    'Sets Handicap': { modo: 'handicap', label: 'Handicap de Sets' },
  },
  5: {
    P1P2: { modo: 'rf' },
    'TotalPointsOver/Under': { modo: 'total', label: 'Total de Pontos' },
    TotalbySets: { modo: 'total', label: 'Total de Sets' },
    MatchPointHandicap: { modo: 'handicap', label: 'Handicap de Pontos' },
  },
  41: {
    P1P2: { modo: 'rf' },
    'TotalPointsOver/Under': { modo: 'total', label: 'Total de Pontos' },
    MatchPointHandicap: { modo: 'handicap', label: 'Handicap de Pontos' },
  },
};
const TIPOS_ESPORTS: Record<string, TipoCfg> = {
  P1P2: { modo: 'rf' },
  MapsTotal: { modo: 'total', label: 'Total de Mapas' },
  MapsHandicap: { modo: 'handicap', label: 'Handicap de Mapas' },
};

function tiposDoSport(sportId: number): Record<string, TipoCfg> {
  return SPORT_LABEL[sportId] === 'Esports' ? TIPOS_ESPORTS : TIPOS_POR_SPORT[sportId] || {};
}

/** Conexão Swarm de vida curta: request/response por rid, com timeout por comando. */
class SwarmClient {
  private ws: WebSocket;
  private pend = new Map<string, (j: any) => void>();
  private rid = 0;
  private aberto: Promise<void>;

  constructor(cfg: SwarmConfig) {
    this.ws = new WebSocket(cfg.wsUrl, {
      headers: {
        Origin: cfg.origin,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    this.aberto = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', (e) => rej(e));
      this.ws.once('unexpected-response', (_r, resp) => rej(new Error(`handshake HTTP ${resp.statusCode}`)));
      setTimeout(() => rej(new Error('timeout de conexão')), 15000);
    });
    this.ws.on('message', (d) => {
      let j: any;
      try { j = JSON.parse(d.toString()); } catch { return; }
      const cb = j?.rid && this.pend.get(j.rid);
      if (cb) {
        this.pend.delete(j.rid);
        cb(j);
      }
    });
  }

  async conectar(siteId: number): Promise<void> {
    await this.aberto;
    const ses = await this.send('request_session', { language: 'pt-br', site_id: siteId, source: 42 });
    if (ses?.code !== 0) throw new Error(`request_session code ${ses?.code}`);
  }

  send(command: string, params: any, timeoutMs = 25000): Promise<any> {
    return new Promise((res, rej) => {
      const id = `r${++this.rid}`;
      this.pend.set(id, res);
      try {
        this.ws.send(JSON.stringify({ command, params, rid: id }));
      } catch (e) {
        this.pend.delete(id);
        return rej(e);
      }
      setTimeout(() => {
        if (this.pend.delete(id)) rej(new Error(`timeout em ${command}`));
      }, timeoutMs);
    });
  }

  fechar(): void {
    try { this.ws.close(); } catch { /* já fechado */ }
  }
}

export class SwarmScraper implements OddsScraper {
  private cfg: SwarmConfig;
  private maxEventosPorEsporte = 150;
  private incluirAoVivo: boolean;

  constructor(cfg: SwarmConfig) {
    this.cfg = cfg;
    this.incluirAoVivo = !!cfg.incluirAoVivo;
  }

  getNome(): string {
    return this.cfg.nome;
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(`🤖 [${this.cfg.nome}] Extração via BetConstruct Swarm (WebSocket)...`);
    const sportIds = new Set<number>();
    for (const e of esportes) (ESPORTE_SPORTS[e] || []).forEach((s) => sportIds.add(s));
    if (sportIds.size === 0) return [];

    const cli = new SwarmClient(this.cfg);
    const todas: ScrapedOdd[] = [];
    try {
      await cli.conectar(this.cfg.siteId);
      for (const sid of sportIds) {
        try {
          const odds = await this.extrairSport(cli, sid);
          if (odds.length) console.log(`   [${this.cfg.nome}] ${SPORT_LABEL[sid]} (sport ${sid}): ${odds.length} odds`);
          todas.push(...odds);
        } catch (e: any) {
          console.error(`   ⚠️ [${this.cfg.nome}] Falha em sport ${sid}: ${e.message}`);
        }
      }
    } catch (e: any) {
      console.error(`   ⚠️ [${this.cfg.nome}] WS indisponível: ${e.message}`);
    } finally {
      cli.fechar();
    }
    console.log(`✅ [${this.cfg.nome}] Total: ${todas.length} odds.`);
    return todas;
  }

  /** Busca DIRIGIDA (revalidação pré-alerta): re-busca só o(s) sport(s) do esporte e filtra o evento. */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const sportIds = esporte && ESPORTE_SPORTS[esporte] ? ESPORTE_SPORTS[esporte] : Object.keys(SPORT_LABEL).map(Number);
    const cli = new SwarmClient(this.cfg);
    try {
      await cli.conectar(this.cfg.siteId);
      for (const sid of sportIds) {
        const odds = await this.extrairSport(cli, sid, 12000);
        const doEvento = odds.filter((o) => areEventsSame(o.evento, evento));
        if (doEvento.length) return doEvento;
      }
    } catch {
      /* melhor esforço — sem confirmação, o gate não alerta */
    } finally {
      cli.fechar();
    }
    return [];
  }

  private async extrairSport(cli: SwarmClient, sportId: number, timeoutMs = 25000): Promise<ScrapedOdd[]> {
    const tipos = Object.keys(tiposDoSport(sportId));
    if (tipos.length === 0) return [];
    // O servidor filtra por bucket: is_live 0 = pré-jogo, 1 = ao vivo. Ao vivo pedimos os
    // DOIS (@in) — o bucket live traz jogos ainda "notstarted" perto do kickoff, então
    // quem manda no "está rolando?" é info.current_game_state, não o bucket. Sem a flag o
    // request fica idêntico ao de sempre (nem is_live/info no what) → mesmo resultado.
    const r = await cli.send(
      'get',
      {
        source: 'betting',
        what: {
          game: this.incluirAoVivo
            ? ['id', 'team1_name', 'team2_name', 'start_ts', 'is_blocked', 'is_live', 'info']
            : ['id', 'team1_name', 'team2_name', 'start_ts', 'is_blocked'],
          market: ['id', 'type', 'name', 'base'],
          event: ['id', 'price', 'base', 'type_1'],
        },
        where: {
          sport: { id: sportId },
          game: this.incluirAoVivo ? { is_live: { '@in': [0, 1] } } : { is_live: 0 },
          market: { type: { '@in': tipos } },
        },
        subscribe: false,
      },
      timeoutMs
    );
    if (r?.code !== 0) throw new Error(`get code ${r?.code}`);
    const games: Record<string, SwarmGame> = r?.data?.data?.game || {};
    return this.parseGames(Object.values(games), sportId);
  }

  /** Converte a árvore de jogos do Swarm em ScrapedOdds (público p/ teste unitário). */
  parseGames(games: SwarmGame[], sportId: number): ScrapedOdd[] {
    const esporte = SPORT_LABEL[sportId];
    const tipos = tiposDoSport(sportId);
    const agora = Date.now();
    const out: ScrapedOdd[] = [];
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
    const okOdd = (n: any) => typeof n === 'number' && Number.isFinite(n) && n > 1;

    const lista = games
      .filter((g) => {
        if (!g.team1_name || !g.team2_name || g.is_blocked) return false;
        if (this.incluirAoVivo) return true; // ao vivo: mantém partida em andamento + pré-jogo
        const t = (g.start_ts || 0) * 1000;
        return t > agora; // só PRÉ-JOGO
      })
      // ao vivo primeiro (start_ts no passado ordena antes) — o teto por esporte não corta jogo rolando.
      .sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0))
      .slice(0, this.maxEventosPorEsporte);

    for (const g of lista) {
      const home = g.team1_name!.trim();
      const away = g.team2_name!.trim();
      const evento = `${home} vs ${away}`;
      const dataHora = new Date((g.start_ts || 0) * 1000).toISOString();

      for (const m of Object.values(g.market || {})) {
        const cfg = m.type ? tipos[m.type] : undefined;
        if (!cfg) continue;
        const evs = Object.values(m.event || {});

        if (cfg.modo === 'rf') {
          const w1 = evs.find((e) => e.type_1 === 'W1');
          const w2 = evs.find((e) => e.type_1 === 'W2');
          if (!w1 || !w2 || !okOdd(w1.price) || !okOdd(w2.price)) continue;
          out.push({
            esporte, evento, dataHora, mercado: 'Resultado Final',
            opcaoA: home, opcaoB: away, oddA: w1.price!, oddB: w2.price!,
          });
        } else if (cfg.modo === 'total') {
          const over = evs.find((e) => e.type_1 === 'Over');
          const under = evs.find((e) => e.type_1 === 'Under');
          const linha = typeof m.base === 'number' ? m.base : over?.base;
          if (!over || !under || !okOdd(over.price) || !okOdd(under.price)) continue;
          if (typeof linha !== 'number' || !linhaArbitravel(linha)) continue;
          out.push({
            esporte, evento, dataHora, mercado: cfg.label!, linha,
            opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha),
            oddA: over.price!, oddB: under.price!,
          });
        } else {
          // handicap: a linha do MANDANTE é o base do EVENTO Home (não o do mercado).
          const h = evs.find((e) => e.type_1 === 'Home');
          const a = evs.find((e) => e.type_1 === 'Away');
          if (!h || !a || !okOdd(h.price) || !okOdd(a.price)) continue;
          const linha = typeof h.base === 'number' ? h.base : undefined;
          // HANDICAP 0 = EMPATE ANULA (Draw No Bet): o empate devolve as duas pernas
          // (push), que é exatamente a liquidação do DNB. `linhaArbitravel(0)` é false
          // (linha inteira), então todo handicap 0 era descartado em silêncio — e o DNB é
          // um dos mercados de maior cobertura cruzada do sistema (574 clusters com 2+ casas
          // numa varredura de 8 casas). Nem SeuBet nem Vbet têm mercado de DNB
          // próprio no feed, então sem isto elas não participam do melhor mercado.
          // Emitido no formato dos outros emissores ('Empate Anula', nomes dos times, SEM
          // linha) para o canônico bater em DNB_FT.
          // SÓ no futebol (sportId 1): é o único esporte aqui em que a partida pode
          // EMPATAR. Em tênis/basquete/vôlei/mesa handicap 0 é o próprio vencedor da
          // partida, e rotulá-lo DNB carimbaria o mercado errado.
          if (linha === 0 && sportId === 1) {
            out.push({
              esporte, evento, dataHora, mercado: 'Empate Anula',
              opcaoA: home, opcaoB: away, oddA: h.price!, oddB: a.price!,
            });
            continue;
          }
          if (typeof linha !== 'number' || !linhaArbitravel(linha)) continue;
          out.push({
            esporte, evento, dataHora, mercado: cfg.label!, linha,
            opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
            oddA: h.price!, oddB: a.price!,
          });
        }
      }
    }
    return out;
  }
}

/** SeuBet — Swarm da BetConstruct em seu.bet.br (site_id capturado do próprio site). */
export class SeuBetScraper extends SwarmScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({
      nome: 'SeuBet',
      wsUrl: 'wss://eu-swarm-springre.trexname.com/',
      siteId: 18749911,
      origin: 'https://www.seu.bet.br',
      incluirAoVivo: opts?.incluirAoVivo,
    });
  }
}

/**
 * Vbet — Swarm da BetConstruct em vbet.bet.br (site_id 692, capturado do
 * request_session da própria página em 17/07/2026). Tipos de mercado idênticos
 * aos do SeuBet (inventário validado ao vivo). Tênis: Grupo A de W.O. desde
 * 17/07/2026 (regra publicada anula partida não concluída — ver VBET.md, que
 * inclui o endpoint do CMS p/ re-verificação e as ressalvas de DQ/1ª liquidação).
 */
export class VbetScraper extends SwarmScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({
      nome: 'Vbet',
      wsUrl: 'wss://eu-swarm-newm.vbet.bet.br/',
      siteId: 692,
      origin: 'https://www.vbet.bet.br',
      incluirAoVivo: opts?.incluirAoVivo,
    });
  }
}
