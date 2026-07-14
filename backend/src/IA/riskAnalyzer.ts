import { generateWithFallback } from './aiProvider';
import { REGRAS_CASAS, PoliticaVoid } from './regrasCasas';

/**
 * RiskAnalyzer — auditor de risco de surebets.
 *
 * Substitui o antigo ai/analyzer.ts. Produz um VEREDITO ESTRUTURADO
 * (não texto livre) para que o frontend possa pintar um badge de risco.
 *
 * Ordem de decisão (determinístico primeiro, IA só quando agrega):
 *   1. Erro palpável (#2): lucro > 25% ⇒ crítico, sem chamar LLM.
 *   2. Sanidade de break-even (regra.md): totalPerc >= 1 ⇒ não é surebet real.
 *   3. Conflito de regras (#1): comparação determinística via REGRAS_CASAS;
 *      a IA apenas EXPLICA a divergência.
 *   4. Caso nenhum sinal determinístico: pede um veredito estruturado ao LLM.
 */

export type NivelRisco = 'ok' | 'atencao' | 'critico';
export type TipoRisco = 'conflito_regras' | 'erro_palpavel' | 'ok';

export interface RiskVerdict {
  nivel_risco: NivelRisco;
  tipo: TipoRisco;
  motivo: string;
  /** 0-100: confiança do veredito. */
  confianca: number;
  /** Preenchido pelo serviço: 'gemini' | 'openai' | 'deterministico' | 'fallback'. */
  fonte?: string;
}

export interface RiskInput {
  evento: string;
  mercado: string;
  esporte?: string;
  oddA: number;
  oddB: number;
  casaA: string;
  casaB: string;
  lucroGarantidoPerc: number;
}

const LIMITE_ERRO_PALPAVEL = 25.0;

/** Normaliza nome de casa: minúsculas, sem acentos/espaços/pontuação. */
export function normalizarCasa(nome: string): string {
  return (nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Normaliza esporte para as chaves de REGRAS_CASAS. */
export function normalizarEsporte(esporte?: string): string {
  const e = normalizarCasa(esporte || '');
  if (e.includes('tenis')) return 'tenis';
  if (e.includes('basquete') || e.includes('basket')) return 'basquete';
  if (e.includes('futebol') || e.includes('soccer') || e.includes('football')) return 'futebol';
  return e;
}

export interface ConflitoRegras {
  conflito: boolean;
  categoria?: 'walkover' | 'abandono';
  politicaA?: PoliticaVoid;
  politicaB?: PoliticaVoid;
  descricao?: string;
}

/**
 * Compara deterministicamente as políticas de void das duas casas para o esporte.
 * Só reporta conflito quando ambas as políticas são conhecidas e divergem.
 */
export function checarConflitoRegras(esporte: string | undefined, casaA: string, casaB: string): ConflitoRegras {
  const chaveEsporte = normalizarEsporte(esporte);
  const regras = REGRAS_CASAS[chaveEsporte];
  if (!regras) return { conflito: false };

  const polA = regras.casas[normalizarCasa(casaA)];
  const polB = regras.casas[normalizarCasa(casaB)];
  if (!polA || !polB) return { conflito: false };

  const categorias: Array<'walkover' | 'abandono'> = ['walkover', 'abandono'];
  for (const cat of categorias) {
    const a = polA[cat];
    const b = polB[cat];
    if (a !== 'desconhecida' && b !== 'desconhecida' && a !== b) {
      return { conflito: true, categoria: cat, politicaA: a, politicaB: b, descricao: regras.descricao };
    }
  }
  return { conflito: false };
}

/**
 * Extrai e valida um RiskVerdict de uma resposta (possivelmente "suja") do LLM.
 * Retorna null se não for possível parsear um JSON válido.
 */
export function parseVerdict(raw: string): RiskVerdict | null {
  if (!raw) return null;
  // Remove cercas de markdown e tenta isolar o primeiro objeto JSON.
  const semFence = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const inicio = semFence.indexOf('{');
  const fim = semFence.lastIndexOf('}');
  if (inicio === -1 || fim === -1 || fim <= inicio) return null;

  let obj: any;
  try {
    obj = JSON.parse(semFence.slice(inicio, fim + 1));
  } catch {
    return null;
  }

  const niveis: NivelRisco[] = ['ok', 'atencao', 'critico'];
  const tipos: TipoRisco[] = ['conflito_regras', 'erro_palpavel', 'ok'];
  const nivel_risco: NivelRisco = niveis.includes(obj.nivel_risco) ? obj.nivel_risco : 'atencao';
  const tipo: TipoRisco = tipos.includes(obj.tipo) ? obj.tipo : 'ok';
  const motivo = typeof obj.motivo === 'string' && obj.motivo.trim() ? obj.motivo.trim() : 'Sem detalhes.';
  let confianca = Number(obj.confianca);
  if (!Number.isFinite(confianca)) confianca = 0;
  confianca = Math.max(0, Math.min(100, Math.round(confianca)));

  return { nivel_risco, tipo, motivo, confianca };
}

export class RiskAnalyzer {
  /**
   * Analisa uma oportunidade e retorna um veredito de risco estruturado.
   * Nunca lança: qualquer falha vira um veredito de fallback 'atencao'.
   */
  async analisar(input: RiskInput): Promise<RiskVerdict> {
    const { evento, mercado, esporte, oddA, oddB, casaA, casaB, lucroGarantidoPerc } = input;

    // 1. Erro palpável (determinístico, sem LLM) — mantém o guard do analyzer antigo.
    if (lucroGarantidoPerc > LIMITE_ERRO_PALPAVEL) {
      return {
        nivel_risco: 'critico',
        tipo: 'erro_palpavel',
        motivo:
          `Lucro garantido de ${lucroGarantidoPerc}% excede ${LIMITE_ERRO_PALPAVEL}%. ` +
          `Forte indício de "Palpable Error" (odd digitada errada / linha invertida). ` +
          `Alta chance de anulação pós-jogo.`,
        confianca: 90,
        fonte: 'deterministico',
      };
    }

    // 2. Sanidade de break-even (regra.md): se não fecha surebet, sinaliza.
    if (!(oddA > 1) || !(oddB > 1) || (1 / oddA + 1 / oddB) >= 1) {
      return {
        nivel_risco: 'critico',
        tipo: 'erro_palpavel',
        motivo:
          'As odds não satisfazem a inequação de break-even (1/oddA + 1/oddB < 1). ' +
          'Não há arbitragem matemática garantida — provável dado inválido/desatualizado.',
        confianca: 95,
        fonte: 'deterministico',
      };
    }

    // 3. Conflito de regras (determinístico + IA explica).
    const conflito = checarConflitoRegras(esporte, casaA, casaB);
    if (conflito.conflito) {
      const base =
        `Conflito de regras (${conflito.categoria}) entre ${casaA} (${conflito.politicaA}) e ` +
        `${casaB} (${conflito.politicaB}) para ${esporte || 'este esporte'}. ` +
        `Se o evento for interrompido, você pode ficar descoberto em uma das pernas.`;
      let motivo = base;
      try {
        const prompt =
          `Evento: ${evento} | Mercado: ${mercado} | Esporte: ${esporte || 'n/d'}.\n` +
          `As casas divergem na política de ${conflito.categoria}: ` +
          `${casaA} = "${conflito.politicaA}", ${casaB} = "${conflito.politicaB}".\n` +
          `Em no máximo 2 frases, explique de forma direta por que essa divergência ameaça a surebet.`;
        const sys = 'Você é um auditor de risco de arbitragem esportiva. Responda em português, objetivo, sem markdown.';
        const { text } = await generateWithFallback(prompt, sys);
        // Só usa a explicação da IA se não vier em mock-mode.
        if (text && !text.startsWith('[Mock')) motivo = text.trim();
      } catch {
        /* mantém a explicação determinística */
      }
      return { nivel_risco: 'critico', tipo: 'conflito_regras', motivo, confianca: 85, fonte: 'deterministico+ia' };
    }

    // 4. Sem sinal determinístico: pede veredito estruturado ao LLM.
    try {
      const sys =
        'Você é um auditor de risco de arbitragem esportiva (surebets). ' +
        'Responda ESTRITAMENTE em JSON válido, sem markdown, no formato exato: ' +
        '{"nivel_risco":"ok|atencao|critico","tipo":"conflito_regras|erro_palpavel|ok","motivo":"<ate 2 frases em pt-BR>","confianca":<0-100>}.';
      const prompt =
        `Avalie riscos que possam QUEBRAR esta surebet (regras de anulação/void divergentes por esporte — ` +
        `ex.: desistência no tênis, prorrogação no basquete — e indícios de erro de cotação).\n` +
        `- Evento: ${evento}\n- Mercado: ${mercado}\n- Esporte: ${esporte || 'n/d'}\n` +
        `- Casa A: ${casaA} @ ${oddA}\n- Casa B: ${casaB} @ ${oddB}\n- Lucro garantido: ${lucroGarantidoPerc}%`;
      const { text, provider } = await generateWithFallback(prompt, sys);
      const parsed = parseVerdict(text);
      if (parsed) return { ...parsed, fonte: provider };
      // Parse falhou (ex.: mock-mode ou resposta fora de formato) → fallback seguro.
      return {
        nivel_risco: 'atencao',
        tipo: 'ok',
        motivo: 'Não foi possível obter uma análise estruturada da IA; confira as regras das casas manualmente.',
        confianca: 0,
        fonte: 'fallback',
      };
    } catch {
      return {
        nivel_risco: 'atencao',
        tipo: 'ok',
        motivo: 'IA indisponível no momento (erro de conexão/API). Verifique as regras das casas manualmente.',
        confianca: 0,
        fonte: 'fallback',
      };
    }
  }
}
