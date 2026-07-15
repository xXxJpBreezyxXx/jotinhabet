import { ScrapedOdd, OddsScraper } from './scraper_base';
import { rotuloOver, rotuloUnder } from '../arbitrage/markets';
import { fetchTextoComRetry } from '../utils/http';

/**
 * Scraper genérico para casas na plataforma Kambi (ex.: KTO, BetWarrior).
 *
 * Consome a Offering API pública da Kambi (sem login), descoberta via recon:
 *  - listView/{esporte}.json → lista de eventos (id, nomes, início) com o mercado principal.
 *  - betoffer/event/{ids}     → TODOS os mercados dos eventos (Total, Handicap, etc.),
 *                               que é onde as surebets de fato aparecem.
 *
 * Convenções: odds e linhas vêm em inteiro ×1000 (6250 = 6.25; line 500 = 0.5).
 * Os tipos de outcome (OT_OVER/OT_UNDER/OT_ONE/OT_TWO/OT_CROSS) são independentes de
 * idioma — o parser se baseia neles, não no rótulo em português.
 */

interface KambiConfig {
  nome: string;
  offering: string; // ex: 'ktobr'
  host?: string; // default us.offering-api.kambicdn.com
  referer: string; // ex: 'https://www.kto.bet.br/'
  maxEventosPorEsporte?: number; // limita o custo (default 60)
}

interface KambiOutcome {
  label: string;
  type: string;
  odds?: number;
  line?: number;
  participant?: string;
}
interface KambiBetOffer {
  criterion?: { label?: string };
  betOfferType?: { name?: string };
  eventId: number;
  outcomes: KambiOutcome[];
}
interface KambiEvent {
  id: number;
  name: string;
  homeName?: string;
  awayName?: string;
  start?: string;
  sport?: string;
}

// esporte interno → path da Kambi
const SPORT_PATHS: Record<string, string> = {
  Futebol: 'football',
  Basquete: 'basketball',
  Tenis: 'tennis',
  Tênis: 'tennis',
};

const SPORT_LABEL: Record<string, string> = {
  football: 'Futebol',
  basketball: 'Basquete',
  tennis: 'Tenis',
};

export class KambiScraper implements OddsScraper {
  private cfg: Required<KambiConfig>;

  constructor(cfg: KambiConfig) {
    this.cfg = {
      host: 'us.offering-api.kambicdn.com',
      maxEventosPorEsporte: 60,
      ...cfg,
    };
  }

  getNome(): string {
    return this.cfg.nome;
  }

  private base(): string {
    return `https://${this.cfg.host}/offering/v2018/${this.cfg.offering}`;
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
    console.log(`🤖 [${this.cfg.nome}] Extração via Kambi Offering API...`);
    const todas: ScrapedOdd[] = [];

    for (const esporte of esportes) {
      const sportPath = SPORT_PATHS[esporte];
      if (!sportPath) continue;
      try {
        const odds = await this.extrairEsporte(sportPath);
        console.log(`   [${this.cfg.nome}] ${esporte}: ${odds.length} odds`);
        todas.push(...odds);
      } catch (err: any) {
        console.error(`   ⚠️ [${this.cfg.nome}] Falha em ${esporte}: ${err.message}`);
      }
    }

    console.log(`✅ [${this.cfg.nome}] Total: ${todas.length} odds.`);
    return todas;
  }

  private async extrairEsporte(sportPath: string): Promise<ScrapedOdd[]> {
    // 1) Lista de eventos (para obter IDs + nomes + horários).
    const lvUrl = `${this.base()}/listView/${sportPath}.json?lang=pt_BR&market=BR`;
    const lv = await fetchTextoComRetry(lvUrl, { headers: this.headers() }, 3, `${this.cfg.nome}/list`);
    if (lv.status !== 200) throw new Error(`listView HTTP ${lv.status}`);
    const lvJson = JSON.parse(lv.body);
    const eventos: KambiEvent[] = (lvJson.events || [])
      .map((e: any) => e.event)
      .filter(Boolean)
      // Descarta partidas VIRTUAIS/e-soccer (FIFA): o nome do time traz o handle do
      // jogador entre parênteses (ex.: "Tottenham (zoyir)"). São voláteis e geram
      // "arbs" de odd travada, não reais.
      .filter((ev: KambiEvent) => !/\([^)]+\)/.test(ev.homeName || '') && !/\([^)]+\)/.test(ev.awayName || ''))
      // Só PRÉ-JOGO: descarta partidas já iniciadas/ao vivo (start no passado).
      .filter((ev: KambiEvent) => {
        const t = Date.parse(ev.start || '');
        return isNaN(t) || t > Date.now();
      });

    const eventosLimitados = eventos.slice(0, this.cfg.maxEventosPorEsporte);
    const mapaEventos = new Map<number, KambiEvent>();
    for (const ev of eventosLimitados) mapaEventos.set(ev.id, ev);
    if (eventosLimitados.length === 0) return [];

    // 2) Todos os mercados dos eventos, em lotes de 25 IDs.
    const odds: ScrapedOdd[] = [];
    const ids = eventosLimitados.map((e) => e.id);
    for (let i = 0; i < ids.length; i += 25) {
      const lote = ids.slice(i, i + 25);
      const boUrl = `${this.base()}/betoffer/event/${lote.join(',')}?lang=pt_BR&market=BR&includeParticipants=false&onlyMain=false`;
      let resp;
      try {
        resp = await fetchTextoComRetry(boUrl, { headers: this.headers() }, 2, `${this.cfg.nome}/bo`);
      } catch (e: any) {
        console.warn(`   ⚠️ [${this.cfg.nome}] lote de betOffers falhou: ${e.message}`);
        continue;
      }
      if (resp.status !== 200) continue;
      const j = JSON.parse(resp.body);

      // Preenche eventos que vieram só nesta resposta (garante nomes/horários).
      for (const e of j.events || []) {
        if (e?.id && !mapaEventos.has(e.id)) mapaEventos.set(e.id, e);
      }

      for (const bo of (j.betOffers || []) as KambiBetOffer[]) {
        const ev = mapaEventos.get(bo.eventId);
        if (!ev || !ev.homeName || !ev.awayName) continue;
        const scraped = this.parseBetOffer(bo, ev, sportPath);
        if (scraped) odds.push(scraped);
      }
    }
    return odds;
  }

  /** Converte um betOffer da Kambi numa ScrapedOdd (2 pernas), quando o mercado é arbitrável. */
  private parseBetOffer(bo: KambiBetOffer, ev: KambiEvent, sportPath: string): ScrapedOdd | null {
    const evento = `${ev.homeName} vs ${ev.awayName}`;
    const esporte = SPORT_LABEL[sportPath] || sportPath;
    const dataHora = ev.start || 'Hoje';
    const url = undefined;
    const o = (n?: number) => (typeof n === 'number' ? n / 1000 : NaN);

    const byType = (t: string) => bo.outcomes.find((x) => x.type === t);

    const over = byType('OT_OVER');
    const under = byType('OT_UNDER');
    const one = byType('OT_ONE');
    const cross = byType('OT_CROSS');
    const two = byType('OT_TWO');

    // Rótulo real do mercado (ex.: "Total de gols", "Total de escanteios") — preserva
    // o ASSUNTO para a normalização não confundir gols com escanteios/cartões.
    const criterio = bo.criterion?.label || '';

    // Só meia-linha (.5) forma arbitragem 2-way limpa: linha inteira tem push (reembolso)
    // e quarto de linha (.25/.75) divide a aposta. Ambas quebram o cálculo de surebet.
    const ehMeiaLinha = (l: number) => Math.abs(l % 1) === 0.5;

    // --- TOTAL (Over/Under) ---
    if (over && under && typeof over.line === 'number') {
      // Só o total DA PARTIDA cruza de forma confiável. Exclui total por-time
      // ("Total de gols do X", "Total de Escanteio por Y") e asiático/quarter-line —
      // a normalização não distingue o time, então cruzariam subjects diferentes.
      if (/ do | por |asi[aá]tic/i.test(criterio)) return null;
      const linha = over.line / 1000;
      if (!ehMeiaLinha(linha)) return null;
      const oddA = o(over.odds);
      const oddB = o(under.odds);
      if (!this.oddOk(oddA) || !this.oddOk(oddB)) return null;
      return {
        esporte, evento, dataHora, url,
        mercado: criterio || 'Total de gols',
        linha,
        opcaoA: rotuloOver(linha),
        opcaoB: rotuloUnder(linha),
        oddA, oddB,
      };
    }

    // --- HANDICAP ASIÁTICO 2-way (Desvantagem): OT_ONE/OT_TWO com line, SEM empate ---
    // Exclui handicap europeu (3-way, tem empate-handicap) e linhas não-meias (push).
    if (one && two && !cross && typeof one.line === 'number' && !/europ/i.test(criterio)) {
      const linha = one.line / 1000;
      if (!ehMeiaLinha(linha)) return null;
      const oddA = o(one.odds);
      const oddB = o(two.odds);
      if (!this.oddOk(oddA) || !this.oddOk(oddB)) return null;
      const sinal = (v: number) => `${v > 0 ? '+' : ''}${v}`;
      return {
        esporte, evento, dataHora, url,
        mercado: /handicap|desvantagem/i.test(criterio) ? criterio : `Handicap ${criterio}`.trim(),
        linha,
        opcaoA: `${ev.homeName} (${sinal(linha)})`,
        opcaoB: `${ev.awayName} (${sinal(-linha)})`,
        oddA, oddB,
      };
    }

    // --- RESULTADO FINAL (Jogo) ---
    if (one && two && !one.line) {
      const oddHome = o(one.odds);
      const oddAway = o(two.odds);
      // 3-way (futebol com empate) → dupla chance sintética (mesma técnica da Blaze).
      if (cross && this.oddOk(o(cross.odds))) {
        const oddX = o(cross.odds);
        if (!this.oddOk(oddHome) || !this.oddOk(oddAway)) return null;
        // Emite só a primeira perna de dupla chance; a inversão é redundante para 2-way arb.
        return {
          esporte, evento, dataHora, url,
          mercado: 'Resultado Final',
          opcaoA: `Vitória ${ev.homeName}`,
          opcaoB: `${ev.awayName} ou Empate`,
          oddA: oddHome,
          oddB: 1 / (1 / oddX + 1 / oddAway),
        };
      }
      // 2-way (tênis/basquete): direto.
      if (this.oddOk(oddHome) && this.oddOk(oddAway)) {
        return {
          esporte, evento, dataHora, url,
          mercado: 'Resultado Final',
          opcaoA: ev.homeName!,
          opcaoB: ev.awayName!,
          oddA: oddHome,
          oddB: oddAway,
        };
      }
    }

    return null; // mercado não arbitrável em 2 pernas (correct score, ímpar/par, etc.)
  }

  private oddOk(n: number): boolean {
    return Number.isFinite(n) && n > 1;
  }
}

/** KTO — Kambi offering "ktobr". */
export class KtoScraper extends KambiScraper {
  constructor() {
    super({ nome: 'KTO', offering: 'ktobr', referer: 'https://www.kto.bet.br/' });
  }
}

/** BetWarrior — Kambi offering "bwpe" (descoberto no HTML do site; host EU responde). */
export class BetWarriorScraper extends KambiScraper {
  constructor() {
    super({
      nome: 'BetWarrior',
      offering: 'bwpe',
      host: 'eu.offering-api.kambicdn.com',
      referer: 'https://apostas.betwarrior.bet.br/',
    });
  }
}
