import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder, linhaArbitravel } from '../arbitrage/markets';
import { areEventsSame, splitEvento } from '../arbitrage/matcher';
import { fetchTextoComRetry } from '../utils/http';
import { comLimite } from '../utils/concorrencia';

/**
 * Plataforma NGX / "BetPlus" (host sb-loterias.ngbras.com) — MULTI-TENANT: várias marcas
 * brasileiras servem o MESMO backend e são separadas apenas pelo header `Origin`.
 * Por isso esta é uma classe-base (igual ao AltenarWidgetScraper) com uma subclasse por
 * marca; a primeira é a MarjoSports.
 *
 * API PÚBLICA (recon 31/07/2026): sem login, sem token, sem browser. O ÚNICO header
 * obrigatório é o `Origin` da marca — o host valida contra uma whitelist de tenants
 * (sem Origin → HTTP 400; Origin inventada → HTTP 400; Origin da marca → 200).
 *
 * Dois endpoints, ambos devolvendo o MESMO formato de evento (por isso um único parser):
 *  - GET /event?type=<ENUM>             → catálogo do esporte, 1 request, só NOT_STARTED.
 *    Já traz o mercado principal (1x2 no futebol), a DUPLA CHANCE PRONTA, o BTTS e — em
 *    basquete/vôlei/beisebol — a linha principal de total/handicap.
 *    + `&status=LIVE`                   → só as partidas EM ANDAMENTO (ver incluirAoVivo).
 *    + `&external_championship_id=sr:tournament:N` → filtra por liga (o alias
 *      `championshipId` NÃO filtra). Alavanca alternativa de custo, não usada aqui.
 *  - GET /event/<_id>                   → DETALHE do evento: é onde vivem Total e
 *    Handicap do futebol/tênis e as demais linhas dos outros esportes.
 *
 * CUSTO é o problema desta casa: o detalhe cresce com a oferta (medido: 3 KB num jogo só
 * com 1x2, 128 KB num jogo médio, 1,3 MB num clássico) e a janela de 48h do futebol tem
 * ~750 jogos. Varrer tudo seriam centenas de MB por rodada numa VPS de 1 core. Os freios
 * são os mesmos do casa_superbet.ts: janela de horas, teto de eventos, teto SEPARADO de
 * detalhes e piso de `valid_odds` (o campo conta as odds ativas do evento — abaixo de
 * ~10 o detalhe não tem total/handicap nenhum, então o request seria desperdício).
 *
 * Becos sem saída já descartados no recon (não repetir): api.marjosports.com.br,
 * api.ngbras.com e api.ngx.bet respondem HTTP 530/1016; paths same-origin (/api, /graphql)
 * devolvem o index.html do SPA.
 */

const HOST = 'https://sb-loterias.ngbras.com';

// esporte do scanner → enum `type` do NGX. e-sports fica FORA: o feed só tem "ESoccer"
// (futebol virtual, odd travada), a mesma exclusão que a BetBoom faz.
const NGX_TYPE: Record<string, string> = {
  Futebol: 'SOCCER',
  Basquete: 'BASKETBALL',
  Tenis: 'TENNIS',
  'Tênis': 'TENNIS',
  TenisDeMesa: 'TABLE_TENNIS',
  'Tenis de Mesa': 'TABLE_TENNIS',
  'Tênis de Mesa': 'TABLE_TENNIS',
  Volei: 'VOLLEY',
  'Vôlei': 'VOLLEY',
  Beisebol: 'BASEBALL',
};

// `__t` do payload → rótulo interno. Rotula pelo esporte REAL do evento (não pelo `type`
// pedido), como o casa_altenar.ts faz com o sportId.
const LABEL_POR_T: Record<string, string> = {
  Soccer: 'Futebol',
  Basketball: 'Basquete',
  Tennis: 'Tenis',
  TableTennis: 'Tenis de Mesa',
  Volley: 'Volei',
  Baseball: 'Beisebol',
};

interface MercadoCfg {
  /**
   * Grupo de odds onde vive o mercado DA PARTIDA INTEIRA. Varia por esporte e a escolha
   * errada cruzaria mercados de liquidação diferente:
   *  - futebol/tênis/tênis de mesa → `full_time`;
   *  - basquete/vôlei/beisebol     → `full_match`.
   * No basquete o `full_time` é o resultado do TEMPO REGULAMENTAR (confirmado no payload:
   * traz `draw` ativo a 17.0, ou seja 3 vias sem prorrogação) e as Diretrizes proíbem
   * cruzar "sem prorrogação" com o vencedor incl. OT das outras casas. O `full_match`
   * é o 2 vias com prorrogação — é ele que casa com Pinnacle/NSoft/BetBoom. Mesma lógica
   * no beisebol: `full_match` = inclui innings extra, `full_time` = 3 vias de 9 innings.
   */
  grupo: string;
  totalKey?: string;
  totalLabel?: string;
  hcpKey?: string;
  hcpLabel?: string;
  /** Handicap de SETS (tênis/vôlei): mercado distinto do de games/pontos → rótulo próprio. */
  hcpSetsKey?: string;
  /** 3 vias (futebol): o principal NÃO sai cru, sai como dupla chance. */
  tresVias?: boolean;
  btts?: boolean;
  dnb?: boolean;
}

// Os rótulos abaixo são os MESMOS que Pinnacle/Altenar/Swarm/NSoft já emitem por esporte
// (conferidos um a um pelo normalizarMercado). Rótulo diferente = mercado que nunca cruza.
const CFG_POR_T: Record<string, MercadoCfg> = {
  Soccer: {
    grupo: 'full_time',
    totalKey: 'goals_over_under', totalLabel: 'Total de Gols',
    hcpKey: 'asian_handicap', hcpLabel: 'Handicap',
    tresVias: true, btts: true, dnb: true,
  },
  Basketball: {
    grupo: 'full_match',
    totalKey: 'points_over_under', totalLabel: 'Total de Pontos',
    hcpKey: 'points_handicap', hcpLabel: 'Handicap',
  },
  Tennis: {
    grupo: 'full_time',
    totalKey: 'games_over_under', totalLabel: 'Total de Games',
    hcpKey: 'games_handicap', hcpLabel: 'Handicap', // handicap de GAMES = o geral do tênis
    hcpSetsKey: 'sets_handicap',
  },
  TableTennis: {
    grupo: 'full_time',
    totalKey: 'points_over_under', totalLabel: 'Total de Pontos',
    hcpKey: 'points_handicap', hcpLabel: 'Handicap de Pontos',
  },
  Volley: {
    grupo: 'full_match',
    totalKey: 'points_over_under', totalLabel: 'Total de Pontos',
    hcpKey: 'points_handicap', hcpLabel: 'Handicap de Pontos',
    hcpSetsKey: 'sets_handicap',
  },
  Baseball: {
    grupo: 'full_match',
    totalKey: 'runs_over_under', totalLabel: 'Total de Corridas',
    hcpKey: 'runs_handicap', hcpLabel: 'Handicap',
  },
};

interface NgxOdd {
  value?: number;
  enable?: boolean;
  status?: string; // ACTIVE | SUSPENDED | DEACTIVATED
  header?: string | null; // OVER | UNDER (totais)
  team?: string | null; // HOME | AWAY (handicaps)
  name?: string | null; // linha, JÁ COM SINAL no handicap ("-1.0")
}
interface NgxCompetitor { pt_br?: string; en?: string; is_virtual?: boolean }
interface NgxEvent {
  _id?: string;
  __t?: string;
  status?: string; // NOT_STARTED | LIVE
  start_date?: string; // ISO-8601 com Z
  valid_odds?: number;
  home_team?: string;
  away_team?: string;
  home_competitor?: NgxCompetitor;
  away_competitor?: NgxCompetitor;
  external_championship_id?: string;
  odds?: Record<string, Record<string, NgxOdd | NgxOdd[]>>;
}

export interface NgxConfig {
  nome: string;
  /** Origin da marca, SEM barra final (ex.: 'https://www.marjosports.com.br'). */
  origin: string;
  /** Janela de kickoff considerada (default 48h, igual à do casa_superbet.ts). */
  janelaHoras?: number;
  /** Teto de eventos por esporte lidos do catálogo (parse local, barato). */
  maxEventosPorEsporte?: number;
  /** Teto de requests de DETALHE por esporte — é este que controla o tráfego. */
  maxDetalhesPorEsporte?: number;
  /** Paralelismo dos detalhes. Medido seguro até ~8; default conservador na VPS de 1 core. */
  concorrenciaDetalhe?: number;
  /** Só com incluirAoVivo: até quanto tempo depois do kickoff um evento LIVE ainda vale (default 6h). */
  recuoAoVivoHoras?: number;
  /**
   * Agente/Radar ao vivo: quando true SOMA o catálogo `&status=LIVE` ao pré-jogo e mantém
   * a partida em andamento. Aqui a flag TROCA/soma o feed (não só relaxa o filtro) porque
   * o catálogo padrão simplesmente não lista jogo iniciado — probe 31/07: /event?type=SOCCER
   * devolveu 1041 eventos, TODOS NOT_STARTED, e as 38 partidas ao vivo só aparecem com
   * status=LIVE. O scanner de surebets constrói SEM a opção e segue 100% pré-jogo.
   */
  incluirAoVivo?: boolean;
}

/** Piso de odds ativas para valer o request de detalhe (abaixo disso não há total/handicap). */
const MIN_VALID_ODDS_DETALHE = 10;

/** Carência (min) para NOT_STARTED com kickoff passado quando incluirAoVivo — ver eventoElegivel. */
const CARENCIA_ATRASO_MIN = 45;

export class NgxScraper implements OddsScraper {
  protected cfg: Required<NgxConfig>;

  constructor(cfg: NgxConfig) {
    this.cfg = {
      janelaHoras: 48,
      maxEventosPorEsporte: 120,
      maxDetalhesPorEsporte: 40,
      concorrenciaDetalhe: 5,
      recuoAoVivoHoras: 6,
      incluirAoVivo: false,
      ...cfg,
    };
  }

  getNome(): string {
    return this.cfg.nome;
  }

  private headers() {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      // Único header obrigatório: o host casa a Origin com o tenant da marca.
      Origin: this.cfg.origin,
      Referer: `${this.cfg.origin}/`,
    };
  }

  async executarCrawler(esportes: string[], _datas: string[], _headless = true): Promise<ScrapedOdd[]> {
    console.log(
      `🤖 [${this.cfg.nome}] Extração via feed NGX (${HOST})${this.cfg.incluirAoVivo ? ' — com AO VIVO' : ''}...`
    );
    const todas: ScrapedOdd[] = [];
    const tipos = [...new Set(esportes.map((e) => NGX_TYPE[e]).filter(Boolean))];
    for (const tipo of tipos) {
      try {
        const odds = await this.extrairTipo(tipo);
        console.log(`   [${this.cfg.nome}] ${tipo}: ${odds.length} odds`);
        todas.push(...odds);
      } catch (err: any) {
        console.error(`   ⚠️ [${this.cfg.nome}] Falha em ${tipo}: ${err.message}`);
      }
    }
    console.log(`✅ [${this.cfg.nome}] Total: ${todas.length} odds.`);
    return todas;
  }

  /**
   * Busca DIRIGIDA (revalidação pré-alerta / skills do agente): localiza o evento e baixa
   * SÓ o detalhe dele — 2 requests e ~30 KB no caso comum (ver candidatos()). Sem `esporte`
   * varre os 6 tipos até achar, então vale sempre passar o esporte.
   */
  async oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const tipos = esporte && NGX_TYPE[esporte] ? [NGX_TYPE[esporte]] : [...new Set(Object.values(NGX_TYPE))];
    for (const tipo of tipos) {
      try {
        const casados = await this.candidatos(tipo, evento);
        if (!casados.length) continue;
        const out: ScrapedOdd[] = [];
        for (const ev of casados.slice(0, 3)) {
          out.push(...this.mesclar(ev, (await this.detalhe(ev._id!, 1, 12000)) || undefined));
        }
        if (out.length) return out;
      } catch {
        /* melhor esforço */
      }
    }
    return [];
  }

  /**
   * Eventos do `tipo` que casam com o nome pedido, do mais barato ao mais caro:
   *  1) só com a flag de ao vivo: o catálogo LIVE inteiro (o do futebol, o maior, tem
   *     ~110 KB contra 4,8 MB do pré-jogo) — o `search` NÃO alcança partida em andamento,
   *     porque o feed padrão só lista NOT_STARTED;
   *  2) `&search=<termo>`: substring (case-insensitive, mas SENSÍVEL a acento) sobre o nome
   *     dos times — troca os 4,8 MB do catálogo por ~5-15 KB;
   *  3) catálogo inteiro. O fallback é obrigatório: o termo vem do nome que OUTRA casa usa e
   *     a busca erra por acento/grafia ("Japao" não acha "Japão"). Falso negativo aqui
   *     abortaria um alerta bom, o que é pior do que gastar tráfego.
   */
  private async candidatos(tipo: string, evento: string): Promise<NgxEvent[]> {
    const casa = (lista: NgxEvent[]) =>
      lista.filter((ev) => {
        const par = this.competidores(ev);
        return par && ev._id && areEventsSame(`${par[0]} vs ${par[1]}`, evento);
      });
    if (this.cfg.incluirAoVivo) {
      try {
        const hits = casa(await this.listar(`${HOST}/event?type=${tipo}&status=LIVE`, 1, 15000));
        if (hits.length) return hits;
      } catch {
        /* segue para a busca por nome */
      }
    }
    for (const termo of this.termosDeBusca(evento)) {
      try {
        const url = `${HOST}/event?type=${tipo}&search=${encodeURIComponent(termo)}`;
        const hits = casa(await this.listar(url, 1, 12000));
        if (hits.length) return hits;
      } catch {
        /* tenta o próximo termo */
      }
    }
    return casa(await this.listar(`${HOST}/event?type=${tipo}`, 1, 30000));
  }

  /**
   * Termos de busca em ordem de especificidade: nome cheio do mandante, depois a palavra
   * mais longa de cada lado (>=4 letras). A palavra isolada cobre o caso comum de sufixo
   * divergente entre casas ("Cruz Azul" × "Cruz Azul FC").
   */
  private termosDeBusca(evento: string): string[] {
    const par = splitEvento(evento);
    if (!par) return [];
    const termos: string[] = [par[0]];
    for (const lado of par) {
      const palavra = lado
        .split(/[\s,./]+/)
        .filter((p) => p.replace(/[^\p{L}\p{N}]/gu, '').length >= 4)
        .sort((a, b) => b.length - a.length)[0];
      if (palavra && !termos.includes(palavra)) termos.push(palavra);
    }
    return termos.slice(0, 3);
  }

  /** Uma listagem de eventos (catálogo, filtro de status ou busca). */
  private async listar(url: string, tentativas = 2, timeoutMs = 30000): Promise<NgxEvent[]> {
    // O catálogo do futebol tem ~4,8 MB: timeout folgado para não abortar o corpo.
    const r = await fetchTextoComRetry(url, { headers: this.headers() }, tentativas, `${this.cfg.nome}/lista`, timeoutMs);
    if (r.status !== 200) throw new Error(`lista HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    return Array.isArray(j) ? j : [];
  }

  /** Catálogo de um `type`: pré-jogo sempre; + o feed LIVE quando incluirAoVivo. */
  private async catalogo(tipo: string): Promise<NgxEvent[]> {
    const eventos = await this.listar(`${HOST}/event?type=${tipo}`);
    if (this.cfg.incluirAoVivo) eventos.push(...(await this.listar(`${HOST}/event?type=${tipo}&status=LIVE`)));
    return eventos;
  }

  private async detalhe(id: string, tentativas = 2, timeoutMs = 20000): Promise<NgxEvent | null> {
    try {
      const r = await fetchTextoComRetry(`${HOST}/event/${id}`, { headers: this.headers() }, tentativas, `${this.cfg.nome}/ev`, timeoutMs);
      if (r.status !== 200) return null;
      const j = JSON.parse(r.body);
      return Array.isArray(j) ? j[0] || null : j;
    } catch {
      return null; // evento sem detalhe não pode derrubar o esporte
    }
  }

  private async extrairTipo(tipo: string): Promise<ScrapedOdd[]> {
    const brutos = await this.catalogo(tipo);
    const agora = Date.now();
    const limite = agora + this.cfg.janelaHoras * 3600 * 1000;

    const naJanela = brutos.filter((ev) => {
      if (!this.eventoElegivel(ev, agora)) return false;
      const t = Date.parse(ev.start_date || '');
      // Partida em andamento tem kickoff no PASSADO: ela passa pelo teto de janela e é
      // aceita só quando a flag está ligada (o eventoElegivel já cuidou do status).
      return t <= limite;
    });

    // Ordem por kickoff (mais próximo primeiro), como BetBoom/Superbet — o jogo iminente é
    // o que interessa ao alerta. Com a flag, o ao vivo (kickoff no passado) fica na frente e
    // ganharia as vagas do pré-jogo, então recebe orçamento EXTRA em vez de roubar (sem a
    // flag o extra é 0 e o corte fica idêntico).
    naJanela.sort((a, b) => Date.parse(a.start_date || '') - Date.parse(b.start_date || ''));
    const extra = this.cfg.incluirAoVivo ? naJanela.filter((ev) => ev.status === 'LIVE').length : 0;
    const eventos = naJanela.slice(0, this.cfg.maxEventosPorEsporte + extra);

    // Alvos de detalhe: os primeiros do corte que TÊM oferta suficiente. O piso de
    // valid_odds evita gastar request em jogo que só publica 1x2 (nada de total/handicap).
    const alvos = eventos
      .filter((ev) => (ev.valid_odds || 0) >= MIN_VALID_ODDS_DETALHE && ev._id)
      .slice(0, Math.min(60, this.cfg.maxDetalhesPorEsporte + extra));
    const detalhados = new Map<string, NgxEvent>();
    if (alvos.length) {
      const res = await comLimite(alvos, this.cfg.concorrenciaDetalhe, (ev) => this.detalhe(ev._id!));
      res.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) detalhados.set(alvos[i]._id!, r.value);
      });
    }

    const out: ScrapedOdd[] = [];
    for (const ev of eventos) {
      out.push(...this.mesclar(ev, detalhados.get(ev._id || '')));
    }
    return out;
  }

  /**
   * Junta catálogo + detalhe do MESMO evento sem duplicar mercado: o detalhe manda (é o
   * snapshot mais novo e o único com Total/Handicap) e o catálogo só preenche a chave
   * mercado+linha que o detalhe não trouxe.
   *
   * A mesclagem existe porque o detalhe NÃO é superconjunto garantido: mercado ao vivo
   * suspende e volta a cada bola, e o probe pegou um tênis LIVE com home/away ACTIVE na
   * lista e DEACTIVATED no detalhe pedido segundos depois. Trocar cego pelo detalhe fazia
   * o feed ao vivo perder o mercado principal de 9 dos 11 jogos de tênis em andamento.
   */
  private mesclar(lista: NgxEvent, detalhe?: NgxEvent): ScrapedOdd[] {
    const daLista = this.parseEvento(lista);
    if (!detalhe) return daLista;
    const doDetalhe = this.parseEvento(detalhe);
    const chave = (o: ScrapedOdd) => `${o.mercado}|${o.linha ?? ''}`;
    const vistos = new Set(doDetalhe.map(chave));
    return [...doDetalhe, ...daLista.filter((o) => !vistos.has(chave(o)))];
  }

  /** Pré-jogo válido, ou em andamento quando a flag permite. */
  private eventoElegivel(ev: NgxEvent, agora: number): boolean {
    if (!LABEL_POR_T[ev.__t || '']) return false;
    if (ev.home_competitor?.is_virtual || ev.away_competitor?.is_virtual) return false;
    if (ev.status !== 'NOT_STARTED' && ev.status !== 'LIVE') return false; // encerrado/adiado
    const t = Date.parse(ev.start_date || '');
    if (!Number.isFinite(t)) return false; // sem kickoff confiável não entra (nunca inventar data)
    // Sem a flag: PRÉ-JOGO puro. O feed padrão já devolve só NOT_STARTED, mas o kickoff no
    // passado é reforço — o catálogo mantém registro pendurado (probe: 8 jogos de futebol
    // "NOT_STARTED" com kickoff de 2 dias antes) e ele não pode virar oferta pré-jogo.
    if (!this.cfg.incluirAoVivo) return ev.status === 'NOT_STARTED' && t > agora;
    // Com a flag, kickoff no passado só é aceito com PISO, e o piso depende do status:
    //  - LIVE: partida realmente em andamento → recuo largo (cobre atraso/prorrogação), só
    //    para barrar o registro pendurado de dias atrás, que entraria com odd congelada e
    //    ainda roubaria o orçamento de detalhes por ser o mais antigo da ordenação.
    //  - NOT_STARTED atrasado: só uma CARÊNCIA curta. Tênis e tênis de mesa entram por ordem
    //    de quadra e ficam NOT_STARTED alguns minutos depois da hora marcada (legítimo), mas
    //    o feed também publica futebol "NOT_STARTED" com 4h+ de atraso e 392 odds ativas
    //    (visto em 31/07) — jogo que nunca virou LIVE nessa altura é registro furado, e o
    //    horário errado ainda quebraria o pareamento por kickoff do motor.
    const piso = ev.status === 'LIVE'
      ? agora - this.cfg.recuoAoVivoHoras * 3600 * 1000
      : agora - CARENCIA_ATRASO_MIN * 60 * 1000;
    return t > piso;
  }

  private competidores(ev: NgxEvent): [string, string] | null {
    const home = (ev.home_competitor?.pt_br || ev.home_team || '').trim();
    const away = (ev.away_competitor?.pt_br || ev.away_team || '').trim();
    return home && away ? [home, away] : null;
  }

  /**
   * Converte UM evento (item de catálogo OU detalhe — mesmo formato) em ScrapedOdds.
   * Público para o teste unitário exercitar o parser sem rede.
   */
  parseEvento(ev: NgxEvent, agora = Date.now()): ScrapedOdd[] {
    if (!this.eventoElegivel(ev, agora)) return [];
    const esporte = LABEL_POR_T[ev.__t || ''];
    const cfg = CFG_POR_T[ev.__t || ''];
    const par = this.competidores(ev);
    if (!esporte || !cfg || !par) return [];
    const [home, away] = par;
    const g = ev.odds?.[cfg.grupo];
    if (!g) return [];

    const evento = `${home} vs ${away}`;
    const dataHora = new Date(Date.parse(ev.start_date!)).toISOString();
    const base = { esporte, evento, dataHora };
    const out: ScrapedOdd[] = [];
    const dict = (k: string): NgxOdd | undefined => {
      const v = g[k];
      return v && !Array.isArray(v) ? v : undefined;
    };
    const arr = (k?: string): NgxOdd[] => {
      if (!k) return [];
      const v = g[k];
      return Array.isArray(v) ? v : [];
    };
    const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;

    // --- Mercado principal ---
    const oH = dict('home');
    const oD = dict('draw');
    const oA = dict('away');
    if (cfg.tresVias) {
      // Futebol: 1X2 NÃO sai cru (Diretrizes) e também não pode sair como "home vs away"
      // 2 vias — o empate existe e nenhuma das duas pernas o cobre. Só o recorte de DUPLA
      // CHANCE (mandante × visitante-ou-empate), o mesmo que Altenar/Superbet emitem.
      // A dupla chance vem PRONTA no feed (`draw_or_away`): usa-se a odd real em vez da
      // sintética porque é UMA aposta só — sem risco de executar metade do lado B. A
      // sintética fica como reserva para os ~15% de jogos sem o mercado pronto.
      const dc = dict('draw_or_away');
      let oddB = NaN;
      if (this.ativa(dc)) oddB = dc!.value!;
      else if (this.ativa(oD) && this.ativa(oA)) oddB = 1 / (1 / oD!.value! + 1 / oA!.value!);
      // Odd combinada <= 1 é impossível de arbitrar (apostar nos dois lados custa mais do
      // que retorna) — mesmo descarte do casa_altenar.ts.
      if (this.ativa(oH) && oddB > 1) {
        out.push({
          ...base, mercado: 'Resultado Final',
          opcaoA: `Vitória ${home}`, opcaoB: `${away} ou Empate`,
          oddA: oH!.value!, oddB,
        });
      }
    } else if (this.ativa(oH) && this.ativa(oA)) {
      out.push({ ...base, mercado: 'Resultado Final', opcaoA: home, opcaoB: away, oddA: oH!.value!, oddB: oA!.value! });
    }

    // --- BTTS (só catálogo/detalhe do futebol) ---
    if (cfg.btts) {
      const sim = dict('both_teams_to_score_yes');
      const nao = dict('both_teams_to_score_no');
      if (this.ativa(sim) && this.ativa(nao)) {
        out.push({
          ...base, mercado: 'Ambas equipes marcam',
          opcaoA: 'Sim', opcaoB: 'Não', oddA: sim!.value!, oddB: nao!.value!,
        });
      }
    }

    // --- DNB / Empate Anula (só no detalhe) ---
    if (cfg.dnb) {
      const dH = dict('home_draw_no_bet');
      const dA = dict('away_draw_no_bet');
      if (this.ativa(dH) && this.ativa(dA)) {
        out.push({ ...base, mercado: 'Empate Anula', opcaoA: home, opcaoB: away, oddA: dH!.value!, oddB: dA!.value! });
      }
    }

    // --- Totais (Over/Under) ---
    if (cfg.totalKey && cfg.totalLabel) {
      for (const [linha, p] of this.paresTotal(arr(cfg.totalKey))) {
        out.push({
          ...base, mercado: cfg.totalLabel, linha,
          opcaoA: rotuloOver(linha), opcaoB: rotuloUnder(linha), oddA: p.over, oddB: p.under,
        });
      }
    }

    // --- Handicaps (mandante × visitante, linha com sinal do MANDANTE) ---
    const handicaps: [string | undefined, string][] = [
      [cfg.hcpKey, cfg.hcpLabel || 'Handicap'],
      [cfg.hcpSetsKey, 'Handicap de Sets'],
    ];
    for (const [key, label] of handicaps) {
      for (const [linha, p] of this.paresHandicap(arr(key))) {
        out.push({
          ...base, mercado: label, linha,
          opcaoA: `${home} (${sinal(linha)})`, opcaoB: `${away} (${sinal(-linha)})`,
          oddA: p.casa, oddB: p.fora,
        });
      }
    }

    return out;
  }

  /**
   * Odd utilizável. O feed usa DOIS placeholders para linha fora do ar: status
   * SUSPENDED/DEACTIVATED com `value` 1 (basquete) ou 0 (futebol ao vivo) — e `enable`
   * segue true nos dois casos, então status é o gate principal.
   */
  private ativa(o?: NgxOdd): boolean {
    return !!o && o.status === 'ACTIVE' && o.enable !== false && typeof o.value === 'number' && o.value > 1;
  }

  /** Agrupa o array de totais por linha e devolve só os pares Over+Under arbitráveis. */
  private paresTotal(lista: NgxOdd[]): [number, { over: number; under: number }][] {
    const porLinha = new Map<number, { over?: number; under?: number }>();
    for (const o of lista) {
      if (!this.ativa(o) || o.team) continue; // `team` preenchido = total POR TIME, outro mercado
      const linha = parseFloat(o.name || '');
      if (!Number.isFinite(linha) || !linhaArbitravel(linha)) continue;
      const slot = porLinha.get(linha) || {};
      if (o.header === 'OVER' && slot.over === undefined) slot.over = o.value!;
      else if (o.header === 'UNDER' && slot.under === undefined) slot.under = o.value!;
      porLinha.set(linha, slot);
    }
    const out: [number, { over: number; under: number }][] = [];
    for (const [linha, s] of porLinha) {
      if (s.over !== undefined && s.under !== undefined) out.push([linha, { over: s.over, under: s.under }]);
    }
    return out;
  }

  /**
   * Pareia handicap por sinal: o `name` JÁ VEM COM SINAL e o par é HOME(L) × AWAY(-L)
   * (confirmado no payload: HOME "-1.0" e AWAY "1.0" formam a mesma linha). Casar por
   * |L| seria errado — o tênis publica +1.5 E -1.5 do mandante no mesmo array, e o
   * pareamento cego juntaria pernas do MESMO lado.
   */
  private paresHandicap(lista: NgxOdd[]): [number, { casa: number; fora: number }][] {
    const casa = new Map<number, number>();
    const fora = new Map<number, number>();
    for (const o of lista) {
      if (!this.ativa(o)) continue;
      const linha = parseFloat(o.name || '');
      if (!Number.isFinite(linha)) continue;
      const alvo = o.team === 'HOME' ? casa : o.team === 'AWAY' ? fora : null;
      if (alvo && !alvo.has(linha)) alvo.set(linha, o.value!);
    }
    const out: [number, { casa: number; fora: number }][] = [];
    for (const [linha, oddCasa] of casa) {
      if (!linhaArbitravel(linha)) continue; // linha inteira dá push → "arb" de lucro zero
      const oddFora = fora.get(-linha);
      if (oddFora !== undefined) out.push([linha, { casa: oddCasa, fora: oddFora }]);
    }
    return out;
  }
}

/**
 * MarjoSports — tenant NGX confirmado em 31/07/2026 pela Origin
 * `https://www.marjosports.com.br` (o feed responde 400 sem ela e 400 com Origin
 * inventada, ou seja é whitelist de tenant, não CORS decorativo). Operador com preço
 * próprio → serve como fonte do scanner e para revalidação.
 */
export class MarjoSportsScraper extends NgxScraper {
  constructor(opts?: { incluirAoVivo?: boolean }) {
    super({ nome: 'MarjoSports', origin: 'https://www.marjosports.com.br', incluirAoVivo: opts?.incluirAoVivo });
  }
}
