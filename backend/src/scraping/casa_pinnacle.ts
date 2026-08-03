import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';
import { ProxyAgent } from 'undici';

/**
 * A Pinnacle bloqueia por ASN o IP do datacenter da VPS (HTTP 403). PINNACLE_PROXY
 * (ex.: http://jotinhabet_tsproxy:1055) aponta pro sidecar Tailscale que sai por um
 * exit node residencial (celular). O dispatcher é passado SÓ nas requisições da
 * Pinnacle — o resto do backend continua saindo direto.
 */
const PINNACLE_PROXY = process.env.PINNACLE_PROXY || '';
const pinnacleDispatcher = PINNACLE_PROXY ? new ProxyAgent(PINNACLE_PROXY) : undefined;

/**
 * Pinnacle — via API "arcadia" guest (pública, X-API-Key estática do próprio site).
 *
 * Pinnacle é a casa de odds mais afiada (baixa margem, não limita ganhadores), então
 * cruzá-la contra casas "soft" (KTO, Superbet, ...) é a melhor fonte de arbitragem.
 *
 *  - /0.1/sports/{sportId}/matchups            → eventos (id, participants, startTime).
 *  - /0.1/matchups/{id}/markets/related/straight → moneyline / total / spread (period 0 = FT).
 *
 * Odds vêm em formato AMERICANO (ex.: -365, +298) → convertidas para decimal.
 */

const BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
const API_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R'; // guest key pública usada pelo site da Pinnacle

// esporte interno → Pinnacle sportId (descoberto: Soccer=29, Tennis=33, Basketball=4,
// E-Sports=12, Volleyball=34, Baseball=3). Tênis de Mesa NÃO existe na Pinnacle.
const SPORT_ID: Record<string, number> = {
  Futebol: 29,
  Tenis: 33,
  Tênis: 33,
  Basquete: 4,
  Esports: 12,
  'E-Sports': 12,
  Volei: 34,
  'Vôlei': 34,
  Beisebol: 3,
};
const SPORT_LABEL: Record<number, string> = {
  29: 'Futebol', 33: 'Tenis', 4: 'Basquete', 12: 'Esports', 34: 'Volei', 3: 'Beisebol',
};
// Rótulo do total por esporte, para o assunto normalizar certo (gols/games/pontos/mapas).
// Em e-sports o total de jogo completo (period 0) é o total de MAPAS → normaliza p/ TOTAIS_MAPAS.
// VÔLEI (period 0): total e spread são em SETS (linhas 3.5/4.5 e 1.5/2.5 — confirmado
// ao vivo), NÃO em pontos — rotular como pontos cruzaria com mercado errado da Kambi.
const TOTAL_LABEL: Record<number, string> = {
  29: 'Total de Gols',
  33: 'Total de Games',
  4: 'Total de Pontos',
  12: 'Total de Mapas',
  34: 'Total de Sets',
  3: 'Total de Corridas',
};
// Rótulo do spread por esporte (default 'Handicap'; e-sports vira Handicap de Mapas no parser).
const HANDICAP_LABEL: Record<number, string> = {
  34: 'Handicap de Sets',
};

interface PinPrice {
  designation?: string; // home | away | draw | over | under
  points?: number;
  price: number; // americano
}
interface PinMarket {
  matchupId: number;
  type: string; // moneyline | total | spread | team_total
  period: number; // 0 = jogo completo
  side?: string;
  prices: PinPrice[];
  status?: string;
}
interface PinParticipant {
  name: string;
  alignment?: string; // home | away | neutral
}
interface PinMatchup {
  id: number;
  startTime?: string;
  parentId?: number | null;
  participants?: PinParticipant[];
  league?: { name?: string };
  state?: string;
  isLive?: boolean;
  /**
   * Unidade contada pelo matchup. 'Regular' (ou ausente) é a PARTIDA; matchup derivado vem
   * com outra unidade ('Corners', 'Bookings', 'Sets'…) e tem moneyline/total próprios —
   * que não são o resultado nem os gols do jogo.
   */
  units?: string;
  type?: string;
  special?: unknown;
}

export class PinnacleScraper implements OddsScraper {
  private maxEventosPorEsporte = 80;
  /**
   * Quando true, coleta a partida EM ANDAMENTO (Radar Cashout e varredura ao vivo do
   * Agente). O scanner de surebet pré-match constrói SEM esta opção.
   *
   * ATENÇÃO ao modelo de dados da Pinnacle: o jogo ao vivo NÃO é o mesmo matchup do
   * pré-jogo — é um matchup FILHO (`parentId` != null, `isLive: true`, `status: 'started'`),
   * com preço próprio. O matchup PAI continua listado com o preço CONGELADO no apito
   * inicial. Medido em 31/07 (Krasnodar × Rostov): moneyline do pai −404 contra −496 no
   * filho ao vivo. Por isso `filtroMatchup` trata o filho explicitamente e DESCARTA o pai
   * de jogo já começado — ler o pai é pior que não ler nada, porque parece odd válida.
   */
  private incluirAoVivo: boolean;

  constructor(opts?: { incluirAoVivo?: boolean }) {
    this.incluirAoVivo = !!opts?.incluirAoVivo;
  }

  getNome(): string {
    return 'Pinnacle';
  }

  /**
   * O matchup entra na coleta?
   *
   *  - FILHO (`parentId`): só o filho AO VIVO que representa A PARTIDA, e só com
   *    incluirAoVivo. Um jogo ao vivo tem VÁRIOS filhos (medido: ~2,1 por jogo) — os
   *    outros contam escanteios, cartões, sets. Aceitar todos fazia o `parseMercados`
   *    emitir o total de ESCANTEIOS como "Total de Gols" e o moneyline de escanteios como
   *    "Resultado Final" (o guard `mk.matchupId !== ev.id` de lá não protege mais, porque
   *    o derivado passa a ser o próprio `ev`) — falsa arbitragem, o mesmo defeito que o
   *    comentário do parseMercados diz ter corrigido, reaberto por outra porta.
   *  - RAIZ ainda não começada: entra (é o pré-jogo).
   *  - RAIZ já começada: FORA. É o pai com preço congelado no apito inicial.
   *
   * @param liveDoPai por pai: o id do filho ao vivo que é a partida (ver filhosLiveDaPartida).
   * @param paisComFilhoLive pais que têm QUALQUER filho ao vivo — o pai sai da coleta mesmo
   * que nenhum filho tenha passado no filtro de partida-base: preço congelado é pior que
   * ausência, porque tem cara de odd válida.
   */
  private filtroMatchup(
    m: PinMatchup,
    agora: number,
    paisComFilhoLive: Set<number>,
    liveDoPai: Map<number, number>
  ): boolean {
    if ((m.participants?.length || 0) < 2) return false;
    if (m.parentId) return this.incluirAoVivo && liveDoPai.get(m.parentId) === m.id;
    if (paisComFilhoLive.has(m.id)) return false;
    if (m.isLive) return this.incluirAoVivo;
    const t = Date.parse(m.startTime || '');
    return isNaN(t) || t > agora;
  }

  /** Pais que têm QUALQUER filho ao vivo (o pai é sempre descartado — odd congelada). */
  private paisComFilhoLive(matchups: PinMatchup[]): Set<number> {
    const s = new Set<number>();
    if (!this.incluirAoVivo) return s;
    for (const m of matchups) if (m.parentId && m.isLive) s.add(m.parentId);
    return s;
  }

  /**
   * Para cada pai, o ÚNICO filho ao vivo que representa a partida.
   *
   * Dois critérios, de propósito independentes do vocabulário da API (que não pude sondar
   * com o túnel da Pinnacle fora do ar):
   *  1. unidade base — `units` ausente ou 'Regular' e sem `special`. Derivado declara a
   *     unidade que conta ('Corners', 'Bookings', 'Sets'…). Se o campo não vier, este
   *     critério não rejeita nada;
   *  2. um por pai — entre os que passam, fica o de MENOR id (a partida-base é criada antes
   *     dos derivados). É o cinto de segurança para o caso de (1) não discriminar.
   * Pai sem nenhum filho aprovado fica de fora inteiro: melhor perder o jogo ao vivo do que
   * publicar odd de escanteio como odd da partida.
   */
  private filhosLiveDaPartida(matchups: PinMatchup[]): Map<number, number> {
    const escolhido = new Map<number, number>();
    if (!this.incluirAoVivo) return escolhido;
    let vistos = 0;
    for (const m of matchups) {
      if (!m.parentId || !m.isLive || (m.participants?.length || 0) < 2) continue;
      vistos++;
      const unidadeBase = (m.units ?? 'Regular') === 'Regular' && !m.special;
      if (!unidadeBase) continue;
      const atual = escolhido.get(m.parentId);
      if (atual === undefined || m.id < atual) escolhido.set(m.parentId, m.id);
    }
    if (vistos > escolhido.size) {
      console.log(`   [Pinnacle] ao vivo: ${escolhido.size} partida(s) de ${vistos} matchup(s) filho(s) (derivados descartados).`);
    }
    return escolhido;
  }

  private headers() {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'X-API-Key': API_KEY,
      Referer: 'https://www.pinnacle.com/',
      Origin: 'https://www.pinnacle.com',
    };
  }

  /** Init do fetch: headers + dispatcher do proxy (quando PINNACLE_PROXY configurado). */
  private fetchInit(): RequestInit {
    const init: any = { headers: this.headers() };
    if (pinnacleDispatcher) init.dispatcher = pinnacleDispatcher;
    return init as RequestInit;
  }

  /** Odds americanas → decimais. */
  private americanoParaDecimal(price: number): number {
    if (!Number.isFinite(price) || price === 0) return NaN;
    return price > 0 ? price / 100 + 1 : 100 / Math.abs(price) + 1;
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(
      `🤖 [Pinnacle] Extração via API arcadia (guest)${PINNACLE_PROXY ? ` [proxy Tailscale: ${PINNACLE_PROXY}]` : ''}...`
    );
    const todas: ScrapedOdd[] = [];
    for (const esporte of esportes) {
      const sid = SPORT_ID[esporte];
      if (!sid) continue;
      try {
        const odds = await this.extrairEsporte(sid);
        console.log(`   [Pinnacle] ${esporte}: ${odds.length} odds`);
        todas.push(...odds);
      } catch (err: any) {
        console.error(`   ⚠️ [Pinnacle] Falha em ${esporte}: ${err.message}`);
      }
    }
    console.log(`✅ [Pinnacle] Total: ${todas.length} odds.`);
    return todas;
  }


  /**
   * Busca DIRIGIDA (revalidação pré-alerta): odds atuais de UM evento, 2-3 requests
   * (matchups do esporte + markets só do matchup casado). Reusa o parser de produção.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const sids = esporte && SPORT_ID[esporte] ? [SPORT_ID[esporte]] : [...new Set(Object.values(SPORT_ID))];
    for (const sid of sids) {
      try {
        // 1 tentativa/10s: com o túnel morto, o gate não pode pendurar a varredura.
        const rMatch = await fetchTextoComRetry(
          `${BASE}/sports/${sid}/matchups?withSpecials=false&brandId=0`,
          this.fetchInit(), 1, 'Pinnacle/reval', 10000
        );
        if (rMatch.status !== 200) continue;
        const matchups: PinMatchup[] = JSON.parse(rMatch.body);
        const agora = Date.now();
        const pais = this.paisComFilhoLive(matchups);
        const liveDoPai = this.filhosLiveDaPartida(matchups);
        const alvo = matchups
          .filter((m) => {
            if (!this.filtroMatchup(m, agora, pais, liveDoPai)) return false;
            const home = m.participants!.find((p) => p.alignment === 'home')?.name;
            const away = m.participants!.find((p) => p.alignment === 'away')?.name;
            return !!home && !!away && areEventsSame(`${home} vs ${away}`, evento);
          })
          .slice(0, 2);
        const odds: ScrapedOdd[] = [];
        for (const ev of alvo) {
          try { odds.push(...(await this.extrairMercadosEvento(ev, sid))); } catch { /* segue */ }
        }
        if (odds.length) return odds;
      } catch {
        /* tenta o próximo esporte */
      }
    }
    return [];
  }

  private async extrairEsporte(sportId: number): Promise<ScrapedOdd[]> {
    const rMatch = await fetchTextoComRetry(
      `${BASE}/sports/${sportId}/matchups?withSpecials=false&brandId=0`,
      this.fetchInit(),
      3,
      'Pinnacle/match'
    );
    if (rMatch.status !== 200) throw new Error(`matchups HTTP ${rMatch.status}`);
    const matchups: PinMatchup[] = JSON.parse(rMatch.body);

    // Pré-jogo (raiz com início no futuro) e, com incluirAoVivo, o matchup FILHO ao vivo;
    // os mais próximos primeiro. Ver filtroMatchup para o porquê do filho.
    const agora = Date.now();
    const pais = this.paisComFilhoLive(matchups);
    const liveDoPai = this.filhosLiveDaPartida(matchups);
    const eventos = matchups
      .filter((m) => this.filtroMatchup(m, agora, pais, liveDoPai))
      .sort((a, b) => (Date.parse(a.startTime || '') || 0) - (Date.parse(b.startTime || '') || 0))
      .slice(0, this.maxEventosPorEsporte);
    if (eventos.length === 0) return [];

    // BULK: todos os mercados straight do esporte em 1 request. Com o teto de 80
    // eventos, o modelo por-evento seriam ~80 requests por esporte pelo túnel
    // Tailscale; o bulk resolve o esporte inteiro com 2. Se falhar, cai no
    // per-evento (comportamento antigo).
    let porMatchup: Map<number, PinMarket[]> | null = null;
    try {
      const rB = await fetchTextoComRetry(
        `${BASE}/sports/${sportId}/markets/straight?primaryOnly=false&withSpecials=false`,
        this.fetchInit(), 2, 'Pinnacle/bulk', 30000
      );
      if (rB.status === 200) {
        const todos: PinMarket[] = JSON.parse(rB.body);
        porMatchup = new Map();
        for (const mk of todos) {
          const arr = porMatchup.get(mk.matchupId);
          if (arr) arr.push(mk);
          else porMatchup.set(mk.matchupId, [mk]);
        }
      }
    } catch {
      /* bulk indisponível — segue no per-evento */
    }

    const odds: ScrapedOdd[] = [];
    for (const ev of eventos) {
      try {
        const markets = porMatchup ? porMatchup.get(ev.id) || [] : await this.buscarMercadosEvento(ev.id);
        odds.push(...this.parseMercados(ev, sportId, markets));
      } catch {
        /* evento sem mercados — ignora */
      }
    }
    return odds;
  }

  /** Mercados straight de UM matchup (usado na revalidação e no fallback sem bulk). */
  private async buscarMercadosEvento(matchupId: number): Promise<PinMarket[]> {
    const r = await fetchTextoComRetry(
      `${BASE}/matchups/${matchupId}/markets/related/straight`,
      this.fetchInit(),
      2,
      'Pinnacle/mkt'
    );
    if (r.status !== 200) return [];
    return JSON.parse(r.body);
  }

  private async extrairMercadosEvento(ev: PinMatchup, sportId: number): Promise<ScrapedOdd[]> {
    return this.parseMercados(ev, sportId, await this.buscarMercadosEvento(ev.id));
  }

  /** Converte os mercados crus de um matchup em ScrapedOdds (moneyline/total/spread, period 0). */
  private parseMercados(ev: PinMatchup, sportId: number, markets: PinMarket[]): ScrapedOdd[] {
    const home = ev.participants?.find((p) => p.alignment === 'home')?.name;
    const away = ev.participants?.find((p) => p.alignment === 'away')?.name;
    if (!home || !away) return [];

    const esporte = SPORT_LABEL[sportId] || String(sportId);
    const ehEsports = sportId === 12;
    const dataHora = ev.startTime || 'Hoje';
    const eventoStr = `${home} vs ${away}`;
    const dec = (p?: number) => (typeof p === 'number' ? this.americanoParaDecimal(p) : NaN);
    const ok = (n: number) => Number.isFinite(n) && n > 1;
    // Meia-linha (.5) e quarter asiática (.25/.75) — a Pinnacle é a maior fonte de
    // quarters. Inteira segue barrada (push). O piso de lucro da quarter (cenário do
    // meio paga metade) é aplicado no engine, não aqui.
    const out: ScrapedOdd[] = [];

    for (const mk of markets) {
      if (mk.period !== 0 || mk.status === 'closed') continue; // só jogo completo, mercado aberto
      // O endpoint "related/straight" traz mercados de DEZENAS de matchups relacionados
      // (escanteios, especiais, props). Sem este filtro, totais de ESCANTEIOS (linha
      // 9.5/10.5...) eram emitidos como "Total de Gols" e cruzavam com mercados errados
      // de outras casas (ex.: a falsa arb "chutes × escanteios" rotulada de gols).
      if (mk.matchupId !== ev.id) continue;

      if (mk.type === 'moneyline') {
        const h = dec(mk.prices.find((p) => p.designation === 'home')?.price);
        const a = dec(mk.prices.find((p) => p.designation === 'away')?.price);
        const d = dec(mk.prices.find((p) => p.designation === 'draw')?.price);
        if (Number.isFinite(d) && d > 1) {
          // 3-way (futebol) → dupla chance sintética. Diretrizes §5: e-sports não admite
          // 1X2/3-vias (empate de BO2) → não sintetiza (deixa passar só o moneyline 2-vias).
          if (ok(h) && ok(a) && !ehEsports) {
            out.push({
              esporte, evento: eventoStr, dataHora,
              mercado: 'Resultado Final',
              opcaoA: `Vitória ${home}`,
              opcaoB: `${away} ou Empate`,
              oddA: h,
              oddB: 1 / (1 / d + 1 / a),
            });
          }
        } else if (ok(h) && ok(a)) {
          out.push({
            esporte, evento: eventoStr, dataHora,
            mercado: 'Resultado Final',
            opcaoA: home, opcaoB: away, oddA: h, oddB: a,
          });
        }
      } else if (mk.type === 'total') {
        const over = mk.prices.find((p) => p.designation === 'over');
        const under = mk.prices.find((p) => p.designation === 'under');
        const oOver = dec(over?.price);
        const oUnder = dec(under?.price);
        const linha = over?.points;
        if (ok(oOver) && ok(oUnder) && typeof linha === 'number' && linhaArbitravel(linha)) {
          out.push({
            esporte, evento: eventoStr, dataHora,
            mercado: TOTAL_LABEL[sportId] || 'Total',
            linha,
            opcaoA: rotuloOver(linha),
            opcaoB: rotuloUnder(linha),
            oddA: oOver, oddB: oUnder,
          });
        }
      } else if (mk.type === 'spread') {
        const hp = mk.prices.find((p) => p.designation === 'home');
        const ap = mk.prices.find((p) => p.designation === 'away');
        const oH = dec(hp?.price);
        const oA = dec(ap?.price);
        const linha = hp?.points;
        // SPREAD 0 = EMPATE ANULA (Draw No Bet): com handicap 0 o empate devolve as duas
        // pernas, que é exatamente a liquidação do DNB — mesmo mercado, mesmo risco.
        // `linhaArbitravel(0)` é false (linha inteira → push), então todo spread 0 era
        // descartado em silêncio. Aqui isso pesa mais que nas outras casas: a Pinnacle é a
        // casa SHARP, e o DNB é o mercado com a melhor taxa de arb medida do sistema
        // (574 clusters com 2+ casas numa varredura de 8 casas). A Pinnacle não tem
        // mercado de DNB próprio no feed — só moneyline/total/spread —, então sem esta
        // conversão ela simplesmente não participa do melhor mercado que temos.
        // Emitido no formato dos outros emissores de DNB (rótulo 'Empate Anula', nomes dos
        // times, SEM linha) para o canônico bater em DNB_FT e cruzar de verdade.
        // Só a linha EXATAMENTE 0 vira DNB; os outros inteiros seguem fora (em -1 o push é
        // "mandante vence por 1" e não há mercado equivalente com que cruzar).
        // SÓ no futebol (sportId 29): é o único esporte que mapeamos onde a partida pode
        // terminar EMPATADA e o handicap 0 dar push. Em tênis/basquete(incl. OT)/vôlei/
        // beisebol não existe empate, então handicap 0 ali é o PRÓPRIO vencedor da partida
        // — carimbá-lo 'Empate Anula' colocaria um Resultado Final no canônico DNB_FT.
        if (ok(oH) && ok(oA) && linha === 0 && sportId === 29) {
          out.push({
            esporte, evento: eventoStr, dataHora,
            mercado: 'Empate Anula',
            opcaoA: home, opcaoB: away, oddA: oH, oddB: oA,
          });
          continue;
        }
        if (ok(oH) && ok(oA) && typeof linha === 'number' && linhaArbitravel(linha)) {
          const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
          out.push({
            esporte, evento: eventoStr, dataHora,
            // Em e-sports o spread de jogo completo é handicap de MAPAS → normaliza p/ HANDICAP_MAPAS;
            // no vôlei é handicap de SETS (HANDICAP_LABEL).
            mercado: ehEsports ? 'Handicap de Mapas' : HANDICAP_LABEL[sportId] || 'Handicap',
            linha,
            opcaoA: `${home} (${sinal(linha)})`,
            opcaoB: `${away} (${sinal(-linha)})`,
            oddA: oH, oddB: oA,
          });
        }
      }
    }
    return out;
  }
}
