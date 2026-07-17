import { supabase } from '../db/client';
import { SureRadarScraper } from '../scraping/casa_sureradar';
import { ArbitrageOpportunity } from '../arbitrage/engine';
import { areEventsSame, areTeamsSame } from '../arbitrage/matcher';
import { mesmaOferta } from '../arbitrage/markets';
import { generateWithFallback } from '../IA/aiProvider';
import { ScrapedOdd } from '../scraping/scraper_base';
import { KtoScraper, BetWarriorScraper } from '../scraping/casa_kambi';
import { SuperbetScraper } from '../scraping/casa_superbet';
import { Aposta1Scraper } from '../scraping/casa_altenar';
import { PinnacleScraper } from '../scraping/casa_pinnacle';

/** Casas com scraper próprio que sabem re-buscar UM evento (oddsDoEvento). */
const SCRAPER_FACTORY: Record<string, () => { oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]> }> = {
  kto: () => new KtoScraper(),
  betwarrior: () => new BetWarriorScraper(),
  superbet: () => new SuperbetScraper(),
  aposta1: () => new Aposta1Scraper(),
  pinnacle: () => new PinnacleScraper(),
};

/** Resultado da checagem ao vivo das duas pernas (gate pré-alerta). */
export interface PernasFrescas {
  ok: boolean;            // surebet segue de pé (ROI > 0) com odds atuais
  oddA: number | null;
  oddB: number | null;
  roiAtual: number | null;
  motivo: string;
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

  /** Última linha numérica de um rótulo de opção ("Mais de 2.5" → 2.5), ou null. */
  private linhaDaOpcao(s: string): number | null {
    const nums = (s || '').match(/[+-]?\d+(?:\.\d+)?/g);
    return nums && nums.length ? Math.abs(parseFloat(nums[nums.length - 1])) : null;
  }

  /**
   * A opção fresca é a MESMA seleção da armazenada? Nome de time ignora o sinal do
   * handicap, então quando ambas embutem linha ("K27 (+1.5)" vs "K27 (-1.5)"), o valor
   * COM SINAL também tem que bater — lição do pareamento sign-aware do motor.
   */
  private opcaoIgual(fresca: string, salva: string): boolean {
    if (this.norm(fresca) === this.norm(salva)) return true;
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
    const linhaAlvo = linha ?? this.linhaDaOpcao(opcao) ?? null;
    for (const o of odds) {
      if (!mesmaOferta(o.mercado, o.linha ?? this.linhaDaOpcao(o.opcaoA), mercado, linhaAlvo)) continue;
      if (this.opcaoIgual(o.opcaoA, opcao)) return o.oddA;
      if (this.opcaoIgual(o.opcaoB, opcao)) return o.oddB;
    }
    return null;
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
  }): Promise<PernasFrescas> {
    // --- Fonte SureRadar: reconsulta a lista (casas de lá não têm scraper próprio) ---
    if (this.norm(opp.url).includes('sureradar')) {
      try {
        const fresh = await this.getSureRadarFresh();
        if ((!fresh || fresh.length === 0) && this.ultimaFonteFresh !== 'api') {
          return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: 'SureRadar indisponível agora (fonte degradada)' };
        }
        const match = fresh.find(
          (o) =>
            areEventsSame(String(o.evento || ''), String(opp.evento || '')) &&
            [this.norm(o.casaA), this.norm(o.casaB)].sort().join('|') === [this.norm(opp.casaA), this.norm(opp.casaB)].sort().join('|') &&
            this.norm(o.mercado) === this.norm(opp.mercado)
        );
        if (!match) return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: 'não está mais na lista do SureRadar' };
        const alinhado = this.norm(match.casaA) === this.norm(opp.casaA);
        const oddA = alinhado ? match.oddA : match.oddB;
        const oddB = alinhado ? match.oddB : match.oddA;
        const roi = this.roiVerdadeiro(oddA, oddB);
        return { ok: roi !== null && roi > 0, oddA, oddB, roiAtual: roi, motivo: roi === null ? 'odds inválidas' : `confirmada no SureRadar (ROI ${roi}%)` };
      } catch (e: any) {
        return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: `falha ao reconsultar SureRadar: ${e?.message || e}` };
      }
    }

    // --- Motor próprio: re-busca cada perna na casa de origem ---
    const fabA = SCRAPER_FACTORY[this.norm(opp.casaA)];
    const fabB = SCRAPER_FACTORY[this.norm(opp.casaB)];
    if (!fabA || !fabB) {
      return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: `casa sem scraper próprio (${!fabA ? opp.casaA : opp.casaB})` };
    }
    try {
      const [oddsA, oddsB] = await Promise.all([
        fabA().oddsDoEvento(opp.evento, opp.esporte),
        fabB().oddsDoEvento(opp.evento, opp.esporte),
      ]);
      const oddA = this.acharPerna(oddsA, opp.mercado, opp.linha, opp.opcaoA);
      const oddB = this.acharPerna(oddsB, opp.mercado, opp.linha, opp.opcaoB);
      if (oddA === null || oddB === null) {
        const faltou = [oddA === null ? opp.casaA : null, oddB === null ? opp.casaB : null].filter(Boolean).join(' e ');
        return { ok: false, oddA, oddB, roiAtual: null, motivo: `perna não encontrada agora em ${faltou} (linha removida/movida?)` };
      }
      const roi = this.roiVerdadeiro(oddA, oddB);
      return { ok: roi !== null && roi > 0, oddA, oddB, roiAtual: roi, motivo: roi === null ? 'odds inválidas' : `odds atuais ${oddA}/${oddB} (ROI ${roi}%)` };
    } catch (e: any) {
      return { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: `falha ao re-buscar pernas: ${e?.message || e}` };
    }
  }

  async revalidar(id: string): Promise<RevalidacaoResultado> {
    const { data: opp, error } = await supabase.from('oportunidades').select('*').eq('id', id).single();
    if (error || !opp) throw new Error('Oportunidade não encontrada');

    // Baseline calculado das MESMAS odds armazenadas (apples-to-apples com roiAtual),
    // caindo para o roi_pct só se as odds não estiverem disponíveis.
    const roiAnterior =
      this.roiVerdadeiro(Number(opp.odd_casa_1), Number(opp.odd_casa_2)) ?? (Number(opp.roi_pct) || 0);

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
