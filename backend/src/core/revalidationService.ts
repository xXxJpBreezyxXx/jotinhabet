import { supabase } from '../db/client';
import { SureRadarScraper } from '../scraping/casa_sureradar';
import { ArbitrageOpportunity } from '../arbitrage/engine';
import { areEventsSame, areTeamsSame, jaroWinkler, parseKickoff } from '../arbitrage/matcher';
import { mesmaOferta, ehLinhaQuarter } from '../arbitrage/markets';
import { generateWithFallback } from '../IA/aiProvider';
import { ScrapedOdd } from '../scraping/scraper_base';
import { KtoScraper, BetWarriorScraper } from '../scraping/casa_kambi';
import { SuperbetScraper } from '../scraping/casa_superbet';
import { Aposta1Scraper } from '../scraping/casa_altenar';
import { PinnacleScraper } from '../scraping/casa_pinnacle';
import { BetBoomScraper } from '../scraping/casa_betboom';
import { SeuBetScraper, VbetScraper } from '../scraping/casa_swarm';
import { EsportesDaSorteScraper } from '../scraping/casa_esportesdasorte';

/** Casas com scraper próprio que sabem re-buscar UM evento (oddsDoEvento). */
const SCRAPER_FACTORY: Record<string, () => { oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> }> = {
  kto: () => new KtoScraper(),
  betwarrior: () => new BetWarriorScraper(),
  superbet: () => new SuperbetScraper(),
  aposta1: () => new Aposta1Scraper(),
  pinnacle: () => new PinnacleScraper(),
  betboom: () => new BetBoomScraper(),
  seubet: () => new SeuBetScraper(),
  vbet: () => new VbetScraper(),
  esportesdasorte: () => new EsportesDaSorteScraper(),
};

/** True se a casa tem scraper próprio capaz de re-buscar um evento (oddsDoEvento). */
export function casaTemScraper(casa: string): boolean {
  return !!SCRAPER_FACTORY[(casa || '').toString().trim().toLowerCase()];
}

/** Resultado da checagem ao vivo das duas pernas (gate pré-alerta). */
export interface PernasFrescas {
  ok: boolean;            // surebet segue de pé (ROI > 0) com odds atuais
  oddA: number | null;
  oddB: number | null;
  roiAtual: number | null;
  motivo: string;
  /** Sinal externo (telegram) com casa sem scraper: não dá pra confirmar —
   *  o chamador decide alertar com tag ⚠️ em vez de suprimir. */
  naoRevalidavel?: boolean;
}

export type RevalStatus =
  | 'ok'
  | 'reduzida'
  | 'melhorou'
  | 'expirada'
  | 'nao_encontrada'
  | 'nao_suportado'
  | 'erro';

export interface RevalidacaoResultado {
  checado_em: string;
  fonte: 'sureradar' | 'casas' | 'nao_suportado';
  odd_a: number | null;
  odd_b: number | null;
  roi_anterior: number;
  roi_atual: number | null;
  status: RevalStatus;
  movimento: { tipo: string; explicacao: string } | null;
}

/**
 * Revalidação de odds (§6 do kickoff): reconsulta a cotação atual e recalcula a
 * surebet, para não confiar na odd congelada no scan. Cobre a fonte que roda em
 * produção (SureRadar); fontes de scraper próprio ficam como 'nao_suportado'.
 */
export class RevalidationService {
  private cache: { at: number; ops: ArbitrageOpportunity[]; fonte: string } | null = null;
  private inFlight: Promise<ArbitrageOpportunity[]> | null = null;
  private readonly CACHE_MS = 60_000;
  /** Fonte do último resultado fresco ('api' | 'browser' | 'none') — ver SureRadarScraper.ultimaFonte. */
  private ultimaFonteFresh: string = 'none';

  /**
   * Retorna a lista atual de surebets do SureRadar.
   * - Deduplica requisições em voo (uma única extração serve chamadas concorrentes).
   * - Cacheia [] apenas quando a fonte foi a API (autoritativa: "zero surebets agora" é
   *   estado válido). [] vindo de falha/fallback não é cacheado, para retentar em seguida.
   */
  private async getSureRadarFresh(): Promise<ArbitrageOpportunity[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.CACHE_MS && (this.cache.ops.length > 0 || this.cache.fonte === 'api')) {
      this.ultimaFonteFresh = this.cache.fonte;
      return this.cache.ops;
    }
    if (this.inFlight) return this.inFlight;

    const scraper = new SureRadarScraper();
    this.inFlight = scraper
      .extrairOportunidades()
      .then((ops) => {
        this.ultimaFonteFresh = scraper.ultimaFonte;
        if (ops && (ops.length > 0 || scraper.ultimaFonte === 'api')) {
          this.cache = { at: Date.now(), ops, fonte: scraper.ultimaFonte };
        }
        return ops || [];
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private norm(s: any): string {
    return (s || '').toString().trim().toLowerCase();
  }

  /**
   * Semeia o cache do SureRadar com a extração feita pela PRÓPRIA varredura — o gate
   * pré-alerta reusa a mesma lista em vez de re-extrair tudo (2ª extração completa
   * por scan, incluindo chromium no modo fallback).
   */
  seedSureRadarCache(ops: ArbitrageOpportunity[], fonte: string): void {
    if (ops && (ops.length > 0 || fonte === 'api')) {
      this.cache = { at: Date.now(), ops, fonte };
      this.ultimaFonteFresh = fonte;
    }
  }

  /** Memo por varredura das odds re-buscadas (casa|evento|esporte → odds, TTL 60s). */
  private memoOdds = new Map<string, { at: number; odds: ScrapedOdd[] }>();
  private async oddsDoEventoMemo(casa: string, evento: string, esporte?: string): Promise<ScrapedOdd[]> {
    const key = `${this.norm(casa)}|${this.norm(evento)}|${this.norm(esporte)}`;
    const hit = this.memoOdds.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.odds;
    const fab = SCRAPER_FACTORY[this.norm(casa)];
    if (!fab) return [];
    const odds = await fab().oddsDoEvento(evento, esporte);
    this.memoOdds.set(key, { at: Date.now(), odds });
    // higiene: não deixa o memo crescer sem limite entre varreduras
    if (this.memoOdds.size > 200) this.memoOdds.clear();
    return odds;
  }

  /**
   * Data/hora (ISO) do início do evento, buscada no feed da PRIMEIRA casa com
   * scraper que conhecer o evento. Usada pelos sinais do Telegram: o print da
   * calculadora não traz horário, mas se qualquer perna tem scraper, o feed da
   * casa é a fonte mais confiável (melhor que abrir link).
   */
  async dataHoraDoEvento(casas: string[], evento: string, esporte?: string): Promise<string | null> {
    for (const casa of casas) {
      if (!casaTemScraper(casa)) continue;
      try {
        const odds = await this.oddsDoEventoMemo(casa, evento, esporte);
        for (const o of odds) {
          if (o.dataHora && parseKickoff(o.dataHora) !== null) return o.dataHora;
        }
      } catch { /* tenta a próxima casa */ }
    }
    return null;
  }

  /** True se o par de casas do card fresco é o mesmo da oportunidade salva. */
  private casasBatem(fresh: ArbitrageOpportunity, opp: any): boolean {
    const a = [this.norm(fresh.casaA), this.norm(fresh.casaB)].sort();
    const b = [this.norm(opp.casa_a_nome), this.norm(opp.casa_b_nome)].sort();
    return a[0] === b[0] && a[1] === b[1] && !!a[0];
  }

  /** True se as opções (seleções) do card batem com as da oportunidade (em qualquer ordem). */
  private opcoesBatem(fresh: ArbitrageOpportunity, opp: any): boolean {
    if (!opp.opcao_a || !opp.opcao_b) return true; // sem info armazenada, não bloqueia
    const fa = this.norm(fresh.opcaoA);
    const fb = this.norm(fresh.opcaoB);
    const oa = this.norm(opp.opcao_a);
    const ob = this.norm(opp.opcao_b);
    return (fa === oa && fb === ob) || (fa === ob && fb === oa);
  }

  /** Alinha as odds frescas às opções/casas armazenadas (oddA↔opcao_a, oddB↔opcao_b). */
  private alinharOdds(fresh: ArbitrageOpportunity, opp: any): { oddA: number; oddB: number } {
    if (opp.casa_a_nome && this.norm(fresh.casaA) === this.norm(opp.casa_a_nome)) {
      return { oddA: fresh.oddA, oddB: fresh.oddB };
    }
    if (opp.casa_a_nome && this.norm(fresh.casaB) === this.norm(opp.casa_a_nome)) {
      return { oddA: fresh.oddB, oddB: fresh.oddA };
    }
    if (opp.opcao_a && areTeamsSame(String(fresh.opcaoA), String(opp.opcao_a))) {
      return { oddA: fresh.oddA, oddB: fresh.oddB };
    }
    if (opp.opcao_a && areTeamsSame(String(fresh.opcaoB), String(opp.opcao_a))) {
      return { oddA: fresh.oddB, oddB: fresh.oddA };
    }
    return { oddA: fresh.oddA, oddB: fresh.oddB };
  }

  /** ROI "verdadeiro" (lucro/investimento) a partir de duas odds — mesma convenção do SureRadar. */
  private roiVerdadeiro(oddA: number, oddB: number): number | null {
    if (!(oddA > 1) || !(oddB > 1)) return null;
    const totalPerc = 1 / oddA + 1 / oddB;
    return Number(((1 / totalPerc - 1) * 100).toFixed(2));
  }

  /** Handicap COM SINAL embutido no rótulo ("Time A (-1.5)"), ou null. */
  private linhaEmbutida(s: string): number | null {
    const m = (s || '').match(/\(([+-]?\d+(?:\.\d+)?)\)\s*$/);
    return m ? parseFloat(m[1]) : null;
  }

  /**
   * Linha de um rótulo de opção, SÓ quando ele a carrega explicitamente:
   * handicap embutido "Time (-1.5)" → 1.5; total "Mais de 2.5" → 2.5; senão null.
   * (Regex genérico de dígitos pegava número de NOME DE TIME — "Philadelphia 76ers"
   * virava linha 76 e a perna ficava inencontrável.)
   */
  private linhaDaOpcao(s: string): number | null {
    const emb = this.linhaEmbutida(s);
    if (emb !== null) return Math.abs(emb);
    const m = (s || '').match(/\b(?:mais de|menos de|over|under|acima de|abaixo de)\s+([+-]?\d+(?:\.\d+)?)/i);
    return m ? Math.abs(parseFloat(m[1])) : null;
  }

  /** Direção over/under de um rótulo de total, ou null quando não é total. */
  private direcaoTotal(s: string): 'over' | 'under' | null {
    const n = this.norm(s);
    if (/^(mais de|over|acima)/.test(n)) return 'over';
    if (/^(menos de|under|abaixo)/.test(n)) return 'under';
    return null;
  }

  /**
   * A opção fresca é a MESMA seleção da armazenada? Duas guardas antes do fuzzy:
   *  - direções over/under opostas nunca casam ("Mais de X" × "Menos de X" tem
   *    Jaro-Winkler ~0.86 e enganava o areTeamsSame — devolvia a odd da perna ERRADA);
   *  - handicap embutido com valor COM SINAL diferente nunca casa (lição sign-aware).
   */
  private opcaoIgual(fresca: string, salva: string): boolean {
    if (this.norm(fresca) === this.norm(salva)) return true;
    const df = this.direcaoTotal(fresca);
    const ds = this.direcaoTotal(salva);
    if ((df || ds) && df !== ds) return false;
    const lf = this.linhaEmbutida(fresca);
    const ls = this.linhaEmbutida(salva);
    if (lf !== null && ls !== null && Math.abs(lf - ls) > 1e-9) return false;
    return areTeamsSame(String(fresca), String(salva));
  }

  /** Acha a odd atual da SELEÇÃO salva dentro das odds frescas da casa (mercado + linha + opção). */
  private acharPerna(
    odds: ScrapedOdd[],
    mercado: string,
    linha: number | null | undefined,
    opcao: string
  ): number | null {
    // Sem linha armazenada (coluna não existe no banco), deriva do rótulo da opção.
    // Comparação por MÓDULO nos dois lados: ScrapedOdd.linha de handicap é assinada
    // (-1.5) e a derivada do rótulo é absoluta — sem abs, handicap negativo dava
    // 'expirada' falsa. A identidade da seleção continua sign-aware via opcaoIgual.
    const alvoRaw = linha ?? this.linhaDaOpcao(opcao) ?? null;
    const linhaAlvo = alvoRaw === null ? null : Math.abs(alvoRaw);
    for (const o of odds) {
      const lo = o.linha ?? this.linhaDaOpcao(o.opcaoA);
      if (!mesmaOferta(o.mercado, lo == null ? null : Math.abs(lo), mercado, linhaAlvo)) continue;
      // Igualdade EXATA primeiro nas duas opções (os parsers usam rótulos canônicos,
      // então o exato resolve totais); o fuzzy fica só p/ variação de nome de time.
      if (this.norm(o.opcaoA) === this.norm(opcao)) return o.oddA;
      if (this.norm(o.opcaoB) === this.norm(opcao)) return o.oddB;
      // Fase fuzzy com DESAMBIGUAÇÃO: compara só a parte do TIME (sem a linha) e só o
      // lado que casa MELHOR pode decidir — o sinal daquele lado é a palavra final.
      // Sem isso, times de nomes parecidos ("Atletico GO"/"Atletico MG") deixavam a
      // perna espelhada (+1.5 do outro time) responder pela seleção buscada.
      const alvoTime = this.norm(this.semLinha(opcao));
      const simA = jaroWinkler(this.norm(this.semLinha(o.opcaoA)), alvoTime);
      const simB = jaroWinkler(this.norm(this.semLinha(o.opcaoB)), alvoTime);
      if (simA >= simB) {
        if (this.opcaoIgual(o.opcaoA, opcao)) return o.oddA;
      } else if (this.opcaoIgual(o.opcaoB, opcao)) {
        return o.oddB;
      }
    }
    return null;
  }

  /** Rótulo de opção sem a linha embutida no fim ("Time A (-1.5)" → "Time A"). */
  private semLinha(s: string): string {
    return (s || '').replace(/\(([+-]?\d+(?:\.\d+)?)\)\s*$/, '').trim();
  }

  /**
   * GATE PRÉ-ALERTA: re-busca as DUAS pernas na casa de origem AGORA e recalcula o ROI.
   * Cobre todas as fontes de alerta: casas com scraper próprio re-buscam o evento
   * (oddsDoEvento) e SureRadar reconsulta a lista curada. Em falha, responde ok:false
   * (conservador: sem confirmação, sem alerta).
   */
  async checarPernasAoVivo(opp: {
    evento: string;
    mercado: string;
    linha?: number | null;
    esporte?: string;
    casaA: string;
    casaB: string;
    opcaoA: string;
    opcaoB: string;
    url?: string;
    fonte?: string;
  }): Promise<PernasFrescas> {
    // --- Fonte SureRadar: reconsulta a lista (casas de lá não têm scraper próprio) ---
    if (this.norm(opp.url).includes('sureradar')) {
      try {
        const fresh = await this.getSureRadarFresh();
        if ((!fresh || fresh.length === 0) && this.ultimaFonteFresh !== 'api') {
          return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: 'SureRadar indisponível agora (fonte degradada)' };
        }
        // Confere também as OPÇÕES (em qualquer ordem) — sem isso, um card do mesmo
        // evento/mercado com LINHA diferente validava a oportunidade errada.
        const match = fresh.find(
          (o) =>
            areEventsSame(String(o.evento || ''), String(opp.evento || '')) &&
            [this.norm(o.casaA), this.norm(o.casaB)].sort().join('|') === [this.norm(opp.casaA), this.norm(opp.casaB)].sort().join('|') &&
            this.norm(o.mercado) === this.norm(opp.mercado) &&
            ((this.opcaoIgual(o.opcaoA, opp.opcaoA) && this.opcaoIgual(o.opcaoB, opp.opcaoB)) ||
              (this.opcaoIgual(o.opcaoA, opp.opcaoB) && this.opcaoIgual(o.opcaoB, opp.opcaoA)))
        );
        if (!match) return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: 'não está mais na lista do SureRadar' };
        // Alinha as odds à SELEÇÃO salva (não só à casa): opcaoA salva ↔ odd da mesma opção.
        const alinhado = this.opcaoIgual(match.opcaoA, opp.opcaoA);
        const oddA = alinhado ? match.oddA : match.oddB;
        const oddB = alinhado ? match.oddB : match.oddA;
        const roi = this.roiVerdadeiro(oddA, oddB);
        return { ok: roi !== null && roi > 0, oddA, oddB, roiAtual: roi, motivo: roi === null ? 'odds inválidas' : `confirmada no SureRadar (ROI ${roi}%)` };
      } catch (e: any) {
        return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: `falha ao reconsultar SureRadar: ${e?.message || e}` };
      }
    }

    // --- Motor próprio: re-busca cada perna na casa de origem ---
    // (Sinais fonte='telegram' com par revalidável caem aqui de propósito.)
    const fabA = SCRAPER_FACTORY[this.norm(opp.casaA)];
    const fabB = SCRAPER_FACTORY[this.norm(opp.casaB)];
    if (!fabA || !fabB) {
      // Rede de segurança p/ sinal externo: sem scraper não é "arb morreu", é
      // "inconfirmável" — o pipeline do Telegram alerta com tag ⚠️ NÃO REVALIDADO.
      if (this.norm(opp.fonte) === 'telegram') {
        return {
          ok: false, naoRevalidavel: true, oddA: null, oddB: null, roiAtual: null,
          motivo: `casa sem scraper próprio (${!fabA ? opp.casaA : opp.casaB}) — sinal externo, alertar sem revalidar`,
        };
      }
      return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: `casa sem scraper próprio (${!fabA ? opp.casaA : opp.casaB})` };
    }
    try {
      const [oddsA, oddsB] = await Promise.all([
        this.oddsDoEventoMemo(opp.casaA, opp.evento, opp.esporte),
        this.oddsDoEventoMemo(opp.casaB, opp.evento, opp.esporte),
      ]);
      const oddA = this.acharPerna(oddsA, opp.mercado, opp.linha, opp.opcaoA);
      const oddB = this.acharPerna(oddsB, opp.mercado, opp.linha, opp.opcaoB);
      if (oddA === null || oddB === null) {
        const faltou = [oddA === null ? opp.casaA : null, oddB === null ? opp.casaB : null].filter(Boolean).join(' e ');
        return { ok: false, oddA, oddB, roiAtual: null, motivo: `perna não encontrada agora em ${faltou} (linha removida/movida?)` };
      }
      let roi = this.roiVerdadeiro(oddA, oddB);
      // QUARTER-LINE (.25/.75): o ROI garantido é o PISO (o cenário do meio devolve
      // metade de cada perna → lucro = metade do nominal) — MESMA convenção do
      // engine.enriquecer, senão o alerta diria "revalidado 3%" para um piso de 1.5%.
      // Sem linha armazenada (revalidação via banco), deriva do rótulo da opção.
      const linhaEfetiva = opp.linha ?? this.linhaDaOpcao(opp.opcaoA) ?? this.linhaDaOpcao(opp.opcaoB);
      if (roi !== null && linhaEfetiva != null && ehLinhaQuarter(linhaEfetiva)) {
        roi = Number((roi / 2).toFixed(2));
      }
      return { ok: roi !== null && roi > 0, oddA, oddB, roiAtual: roi, motivo: roi === null ? 'odds inválidas' : `odds atuais ${oddA}/${oddB} (ROI garantido ${roi}%)` };
    } catch (e: any) {
      return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: `falha ao re-buscar pernas: ${e?.message || e}` };
    }
  }

  async revalidar(id: string): Promise<RevalidacaoResultado> {
    const { data: opp, error } = await supabase.from('oportunidades').select('*').eq('id', id).single();
    if (error || !opp) throw new Error('Oportunidade não encontrada');

    // Baseline calculado das MESMAS odds armazenadas (apples-to-apples com roiAtual),
    // caindo para o roi_pct só se as odds não estiverem disponíveis.
    let roiAnterior =
      this.roiVerdadeiro(Number(opp.odd_casa_1), Number(opp.odd_casa_2)) ?? (Number(opp.roi_pct) || 0);
    // Quarter-line no MOTOR próprio: o roiAtual do checarPernasAoVivo é o PISO, então
    // o baseline precisa ser o piso também — senão odds inalteradas viravam 'reduzida'.
    // (No SureRadar os dois lados seguem nominais → consistente sem ajuste.)
    if (!this.norm(opp.url).includes('sureradar')) {
      const linhaDb = this.linhaDaOpcao(String(opp.opcao_a || '')) ?? this.linhaDaOpcao(String(opp.opcao_b || ''));
      if (linhaDb != null && ehLinhaQuarter(linhaDb)) roiAnterior = Number((roiAnterior / 2).toFixed(2));
    }

    const base: RevalidacaoResultado = {
      checado_em: new Date().toISOString(),
      fonte: 'sureradar',
      odd_a: null,
      odd_b: null,
      roi_anterior: roiAnterior,
      roi_atual: null,
      status: 'nao_suportado',
      movimento: null,
    };

    // Motor próprio: re-busca as pernas nas casas de origem (KTO/BetWarrior/Superbet/
    // Aposta1/Pinnacle). Casas fora do registry seguem 'nao_suportado'.
    if (!this.norm(opp.url).includes('sureradar')) {
      const vivo = await this.checarPernasAoVivo({
        evento: String(opp.evento || ''),
        mercado: String(opp.mercado || ''),
        esporte: opp.esporte || undefined,
        casaA: String(opp.casa_a_nome || ''),
        casaB: String(opp.casa_b_nome || ''),
        opcaoA: String(opp.opcao_a || ''),
        opcaoB: String(opp.opcao_b || ''),
        url: opp.url || undefined,
      });

      let status: RevalStatus;
      if (/casa sem scraper/.test(vivo.motivo)) status = 'nao_suportado';
      else if (/falha ao/.test(vivo.motivo)) status = 'erro';
      else if (vivo.oddA === null || vivo.oddB === null) status = 'expirada';
      else if (!vivo.ok || (vivo.roiAtual ?? 0) <= 0) status = 'expirada';
      else if ((vivo.roiAtual ?? 0) < roiAnterior - 0.1) status = 'reduzida';
      else if ((vivo.roiAtual ?? 0) > roiAnterior + 0.1) status = 'melhorou';
      else status = 'ok';

      const movimento =
        status === 'nao_suportado' || status === 'erro'
          ? { tipo: status, explicacao: vivo.motivo }
          : await this.classificarMovimento(opp, vivo.oddA ?? 0, vivo.oddB ?? 0, roiAnterior, vivo.roiAtual ?? 0, status);

      const res: RevalidacaoResultado = {
        ...base,
        fonte: status === 'nao_suportado' ? 'nao_suportado' : 'casas',
        odd_a: vivo.oddA,
        odd_b: vivo.oddB,
        roi_atual: vivo.roiAtual,
        status,
        movimento,
      };
      await this.persist(id, res);
      return res;
    }

    let fresh: ArbitrageOpportunity[];
    try {
      fresh = await this.getSureRadarFresh();
    } catch (e: any) {
      const res: RevalidacaoResultado = {
        ...base,
        status: 'erro',
        movimento: { tipo: 'desconhecido', explicacao: `Falha ao reconsultar o SureRadar: ${e?.message || e}` },
      };
      await this.persist(id, res);
      return res;
    }

    // Lista vazia com fonte NÃO-autoritativa => provável indisponibilidade (site fora,
    // cookies expirados). NÃO tratar como 'expirada' (descartaria surebets válidas).
    // Com fonte 'api', lista vazia é real ("zero surebets agora") e segue para o
    // match abaixo, que corretamente resultará em 'expirada'.
    if ((!fresh || fresh.length === 0) && this.ultimaFonteFresh !== 'api') {
      const res: RevalidacaoResultado = {
        ...base,
        status: 'erro',
        movimento: {
          tipo: 'desconhecido',
          explicacao: 'Não foi possível reconsultar o SureRadar agora (fonte vazia/indisponível). Tente novamente em instantes.',
        },
      };
      await this.persist(id, res);
      return res;
    }

    // Casa por evento + par de casas + mercado + opções (evita casar mercado errado do mesmo jogo).
    const match = fresh.find(
      (o) =>
        areEventsSame(String(o.evento || ''), String(opp.evento || '')) &&
        this.casasBatem(o, opp) &&
        (!opp.mercado || this.norm(o.mercado) === this.norm(opp.mercado)) &&
        this.opcoesBatem(o, opp)
    );

    if (!match) {
      // Sem match com fonte NÃO-autoritativa (fallback browser não enxerga as VIP/locked):
      // não dá para afirmar 'expirada' — a surebet pode estar viva e apenas oculta na lista parcial.
      if (this.ultimaFonteFresh !== 'api') {
        const res: RevalidacaoResultado = {
          ...base,
          status: 'erro',
          movimento: {
            tipo: 'desconhecido',
            explicacao:
              'Não foi possível confirmar esta surebet agora (a fonte respondeu por caminho degradado, com lista parcial). Tente novamente em instantes.',
          },
        };
        await this.persist(id, res);
        return res;
      }
      const res: RevalidacaoResultado = {
        ...base,
        status: 'expirada',
        movimento: {
          tipo: 'expirada',
          explicacao: 'Esta surebet não aparece mais na lista atual do SureRadar — provavelmente expirou ou a odd foi corrigida.',
        },
      };
      await this.persist(id, res);
      return res;
    }

    const { oddA, oddB } = this.alinharOdds(match, opp);
    const totalPerc = 1 / oddA + 1 / oddB;
    // ROI "verdadeiro" (lucro/investimento) — MESMA convenção que o SureRadar grava em roi_pct.
    const roiAtual = Number(((1 / totalPerc - 1) * 100).toFixed(2));

    let status: RevalStatus;
    if (!(oddA > 1) || !(oddB > 1) || totalPerc >= 1) status = 'expirada';
    else if (roiAtual < roiAnterior - 0.1) status = 'reduzida';
    else if (roiAtual > roiAnterior + 0.1) status = 'melhorou';
    else status = 'ok';

    const movimento = await this.classificarMovimento(opp, oddA, oddB, roiAnterior, roiAtual, status);

    const res: RevalidacaoResultado = {
      ...base,
      odd_a: oddA,
      odd_b: oddB,
      roi_atual: roiAtual,
      status,
      movimento,
    };
    await this.persist(id, res);
    return res;
  }

  /** (D) Classifica o movimento da odd: estável / normal / correção de erro, com explicação da IA. */
  private async classificarMovimento(
    opp: any,
    oddA: number,
    oddB: number,
    roiAnt: number,
    roiAtual: number,
    status: RevalStatus
  ): Promise<{ tipo: string; explicacao: string }> {
    const oldA = Number(opp.odd_casa_1) || 0;
    const oldB = Number(opp.odd_casa_2) || 0;
    const quedaMaxPct =
      Math.max(oldA > 0 ? (oldA - oddA) / oldA : 0, oldB > 0 ? (oldB - oddB) / oldB : 0) * 100;

    let tipo: string;
    if (status === 'expirada') tipo = 'expirada';
    else if (quedaMaxPct >= 12) tipo = 'correcao_erro';
    else if (Math.abs(oddA - oldA) < 1e-9 && Math.abs(oddB - oldB) < 1e-9) tipo = 'estavel';
    else tipo = 'normal';

    const explicacoesPadrao: Record<string, string> = {
      expirada: 'A surebet não existe mais nas cotações atuais.',
      correcao_erro: `Queda acentuada de odd (~${quedaMaxPct.toFixed(0)}%) — típico de correção de erro de cotação pela casa. Cuidado com anulação.`,
      estavel: 'As odds continuam iguais às do scan.',
      normal: `Movimento normal de mercado. ROI foi de ${roiAnt.toFixed(2)}% para ${roiAtual.toFixed(2)}%.`,
    };
    let explicacao = explicacoesPadrao[tipo] || 'Sem detalhes.';

    // Enriquecimento opcional pela IA (seguro em mock-mode: mantém o texto padrão).
    try {
      const sys =
        'Você é um auditor de risco de arbitragem esportiva. Em 1 frase objetiva (pt-BR, sem markdown), ' +
        'explique o que a mudança de odd sugere (movimento normal de mercado vs. correção de erro) e o risco prático.';
      const prompt =
        `Evento: ${opp.evento}. Odds no scan: ${oldA} / ${oldB} (ROI ${roiAnt.toFixed(2)}%). ` +
        `Odds agora: ${oddA} / ${oddB} (ROI ${roiAtual.toFixed(2)}%). Status: ${status}.`;
      const { text } = await generateWithFallback(prompt, sys);
      if (text && !text.startsWith('[Mock')) explicacao = text.trim();
    } catch {
      /* mantém a explicação determinística */
    }

    return { tipo, explicacao };
  }

  private async persist(id: string, res: RevalidacaoResultado): Promise<void> {
    try {
      const { error } = await supabase
        .from('oportunidades')
        .update({ revalidado_em: res.checado_em, revalidacao: res })
        .eq('id', id);
      if (error) {
        if (error.code === 'PGRST204' || /column|schema cache/i.test(error.message || '')) {
          console.warn(
            '⚠️ [Revalidation] Colunas de revalidação ausentes — aplique a migration 006. O resultado NÃO foi persistido (mas foi calculado e retornado).'
          );
        } else {
          console.error('⚠️ [Revalidation] Erro ao persistir revalidação:', error.message);
        }
      }
    } catch (e: any) {
      console.error('⚠️ [Revalidation] Erro de rede ao persistir revalidação:', e?.message || e);
    }
  }
}
