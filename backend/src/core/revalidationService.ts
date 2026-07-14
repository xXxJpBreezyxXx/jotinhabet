import { supabase } from '../db/client';
import { SureRadarScraper } from '../scraping/casa_sureradar';
import { ArbitrageOpportunity } from '../arbitrage/engine';
import { areEventsSame, areTeamsSame } from '../arbitrage/matcher';
import { generateWithFallback } from '../IA/aiProvider';

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
  fonte: 'sureradar' | 'nao_suportado';
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
  private cache: { at: number; ops: ArbitrageOpportunity[] } | null = null;
  private inFlight: Promise<ArbitrageOpportunity[]> | null = null;
  private readonly CACHE_MS = 60_000;

  /**
   * Retorna a lista atual de surebets do SureRadar.
   * - Deduplica requisições em voo (uma única extração serve chamadas concorrentes).
   * - NÃO cacheia resultados vazios (um [] costuma ser falha do scraper, não "sem surebets").
   */
  private async getSureRadarFresh(): Promise<ArbitrageOpportunity[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.CACHE_MS && this.cache.ops.length > 0) {
      return this.cache.ops;
    }
    if (this.inFlight) return this.inFlight;

    const scraper = new SureRadarScraper();
    this.inFlight = scraper
      .extrairOportunidades()
      .then((ops) => {
        if (ops && ops.length > 0) this.cache = { at: Date.now(), ops };
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

    // Só o SureRadar é suportado para revalidação nesta versão.
    if (!this.norm(opp.url).includes('sureradar')) {
      const res: RevalidacaoResultado = {
        ...base,
        fonte: 'nao_suportado',
        status: 'nao_suportado',
        movimento: {
          tipo: 'nao_suportado',
          explicacao: 'Revalidação automática disponível apenas para oportunidades do SureRadar nesta versão.',
        },
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

    // Lista vazia => provável indisponibilidade da fonte (site fora, cookies expirados).
    // NÃO tratar como 'expirada' (isso faria descartar surebets válidas por engano).
    if (!fresh || fresh.length === 0) {
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
