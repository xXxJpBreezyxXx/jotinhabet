import { describe, it, expect, beforeEach, vi } from 'vitest';

// Estado controlável do mock, criado via vi.hoisted para poder ser referenciado
// dentro da factory do vi.mock (que é içada acima dos imports).
// Usamos uma função SIMPLES (não vi.fn) de propósito: o rastreamento de
// resultados do vi.fn no vitest v4 emite "unhandled rejection" quando a
// implementação lança/rejeita, mesmo que o código sob teste capture o erro.
const h = vi.hoisted(() => {
  return {
    calls: 0,
    impl: async (_p: string, _s?: string): Promise<{ text: string; provider: string }> => ({
      text: '',
      provider: 'gemini',
    }),
  };
});

vi.mock('../../src/IA/aiProvider', () => ({
  generateWithFallback: (p: string, s?: string) => {
    h.calls++;
    return h.impl(p, s);
  },
}));

import {
  RiskAnalyzer,
  parseVerdict,
  checarConflitoRegras,
  normalizarCasa,
  normalizarEsporte,
} from '../../src/IA/riskAnalyzer';

describe('parseVerdict', () => {
  it('parseia JSON válido', () => {
    const v = parseVerdict('{"nivel_risco":"critico","tipo":"erro_palpavel","motivo":"x","confianca":80}');
    expect(v).not.toBeNull();
    expect(v!.nivel_risco).toBe('critico');
    expect(v!.tipo).toBe('erro_palpavel');
    expect(v!.confianca).toBe(80);
  });

  it('remove cercas de markdown ```json', () => {
    const v = parseVerdict('```json\n{"nivel_risco":"ok","tipo":"ok","motivo":"ok","confianca":50}\n```');
    expect(v).not.toBeNull();
    expect(v!.nivel_risco).toBe('ok');
  });

  it('retorna null quando não há JSON', () => {
    expect(parseVerdict('resposta sem json nenhum')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });

  it('normaliza valores inválidos com fallback seguro', () => {
    const v = parseVerdict('{"nivel_risco":"banana","tipo":"xyz","confianca":999}');
    expect(v).not.toBeNull();
    expect(v!.nivel_risco).toBe('atencao'); // valor inválido -> atencao
    expect(v!.tipo).toBe('ok'); // valor inválido -> ok
    expect(v!.confianca).toBe(100); // clamp 0-100
    expect(v!.motivo).toBe('Sem detalhes.');
  });

  it('clampa confiança negativa para 0', () => {
    const v = parseVerdict('{"nivel_risco":"ok","tipo":"ok","motivo":"m","confianca":-30}');
    expect(v!.confianca).toBe(0);
  });
});

describe('normalizadores', () => {
  it('normalizarCasa remove acento/espaço/pontuação e caixa', () => {
    expect(normalizarCasa('Bet365')).toBe('bet365');
    expect(normalizarCasa('1xBet')).toBe('1xbet');
    expect(normalizarCasa('Super Bet!')).toBe('superbet');
  });

  it('normalizarEsporte mapeia variações', () => {
    expect(normalizarEsporte('Tênis')).toBe('tenis');
    expect(normalizarEsporte('Basquete')).toBe('basquete');
    expect(normalizarEsporte('Futebol')).toBe('futebol');
    expect(normalizarEsporte('soccer')).toBe('futebol');
  });
});

describe('checarConflitoRegras', () => {
  it('detecta conflito no tênis (bet365 resolvida vs betano anulada)', () => {
    const c = checarConflitoRegras('Tênis', 'Bet365', 'Betano');
    expect(c.conflito).toBe(true);
    expect(c.categoria).toBe('walkover');
  });

  it('não acusa conflito entre a mesma casa', () => {
    expect(checarConflitoRegras('Tênis', 'Bet365', 'Bet365').conflito).toBe(false);
  });

  it('não acusa conflito para casa desconhecida', () => {
    expect(checarConflitoRegras('Tênis', 'Bet365', 'CasaInexistente').conflito).toBe(false);
  });

  it('não acusa conflito para esporte não catalogado', () => {
    expect(checarConflitoRegras('Vôlei', 'Bet365', 'Betano').conflito).toBe(false);
  });
});

describe('RiskAnalyzer.analisar', () => {
  const base = {
    evento: 'A vs B',
    mercado: 'Resultado Final',
    esporte: 'Futebol',
    oddA: 2.1,
    oddB: 2.1,
    casaA: 'Betano',
    casaB: 'Bet365',
    lucroGarantidoPerc: 5,
  };

  beforeEach(() => {
    h.calls = 0;
    h.impl = async () => ({ text: '', provider: 'gemini' });
  });

  it('erro palpável (>25%) é determinístico e NÃO chama a IA', async () => {
    const r = await new RiskAnalyzer().analisar({ ...base, lucroGarantidoPerc: 30 });
    expect(r.nivel_risco).toBe('critico');
    expect(r.tipo).toBe('erro_palpavel');
    expect(r.fonte).toBe('deterministico');
    expect(h.calls).toBe(0);
  });

  it('odds que não fecham break-even são críticas e NÃO chamam a IA', async () => {
    const r = await new RiskAnalyzer().analisar({ ...base, oddA: 1.0, oddB: 2.0, lucroGarantidoPerc: 0 });
    expect(r.nivel_risco).toBe('critico');
    expect(r.tipo).toBe('erro_palpavel');
    expect(h.calls).toBe(0);
  });

  it('conflito de regras: usa explicação determinística quando a IA está em mock', async () => {
    h.impl = async () => ({ text: '[Mock Gemini Response] ...', provider: 'gemini' });
    const r = await new RiskAnalyzer().analisar({ ...base, esporte: 'Tênis' });
    expect(r.tipo).toBe('conflito_regras');
    expect(r.nivel_risco).toBe('critico');
    expect(r.motivo).toContain('Conflito de regras');
  });

  it('conflito de regras: usa a explicação real da IA quando disponível', async () => {
    h.impl = async () => ({ text: 'Explicacao real e util da IA.', provider: 'openai' });
    const r = await new RiskAnalyzer().analisar({ ...base, esporte: 'Tênis' });
    expect(r.tipo).toBe('conflito_regras');
    expect(r.motivo).toBe('Explicacao real e util da IA.');
  });

  it('sem sinal determinístico: parseia o veredito estruturado da IA', async () => {
    h.impl = async () => ({
      text: '{"nivel_risco":"ok","tipo":"ok","motivo":"tudo certo","confianca":70}',
      provider: 'gemini',
    });
    const r = await new RiskAnalyzer().analisar(base); // futebol Betano vs Bet365 = sem conflito
    expect(r.nivel_risco).toBe('ok');
    expect(r.fonte).toBe('gemini');
    expect(h.calls).toBe(1);
  });

  it('fallback seguro (atencao) quando a IA retorna algo sem JSON', async () => {
    h.impl = async () => ({ text: 'resposta sem json', provider: 'gemini' });
    const r = await new RiskAnalyzer().analisar(base);
    expect(r.nivel_risco).toBe('atencao');
    expect(r.fonte).toBe('fallback');
  });

  it('fallback seguro quando a IA rejeita (erro de rede/rate limit)', async () => {
    h.impl = async () => {
      throw new Error('rate limit');
    };
    const r = await new RiskAnalyzer().analisar(base);
    expect(r.nivel_risco).toBe('atencao');
    expect(r.fonte).toBe('fallback');
  });
});
