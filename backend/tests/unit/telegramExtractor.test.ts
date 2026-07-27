import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock do provedor de visão — mesma técnica do riskAnalyzer.test.ts (função
// simples via vi.hoisted, não vi.fn, para não gerar unhandled rejection).
const h = vi.hoisted(() => {
  return {
    impl: async (): Promise<{ text: string; provider: string }> => ({ text: '', provider: 'gemini' }),
  };
});

vi.mock('../../src/IA/aiProvider', () => ({
  generateFromImageWithFallback: () => h.impl(),
  generateWithFallback: () => h.impl(),
}));

import {
  extrairSinalDeImagem,
  validarSinal,
  normalizarDataHora,
} from '../../src/IA/extractors/telegramSignalExtractor';

const SINAL_VALIDO = {
  eh_sinal: true,
  confianca: 95,
  evento: 'Flamengo x Palmeiras',
  esporte: 'Futebol',
  mercado: 'Total de Gols',
  linha: 2.5,
  opcaoA: 'Mais de 2.5',
  opcaoB: 'Menos de 2.5',
  oddA: 2.1,
  oddB: 2.1,
  casaA: 'KTO',
  casaB: 'Superbet',
  dataHora: '18/07/2026 16:00',
};

beforeEach(() => {
  delete process.env.TELEGRAM_MIN_CONFIANCA;
});

describe('extrairSinalDeImagem', () => {
  it('extrai um sinal válido de JSON limpo', async () => {
    h.impl = async () => ({ text: JSON.stringify(SINAL_VALIDO), provider: 'gemini' });
    const r = await extrairSinalDeImagem('base64', 'image/jpeg');
    expect(r.motivoDescarte).toBeUndefined();
    expect(r.sinal).not.toBeNull();
    expect(r.sinal!.evento).toBe('Flamengo x Palmeiras');
    expect(r.sinal!.oddA).toBe(2.1);
    expect(r.provider).toBe('gemini');
  });

  it('parseia JSON com cercas de markdown', async () => {
    h.impl = async () => ({ text: '```json\n' + JSON.stringify(SINAL_VALIDO) + '\n```', provider: 'openai' });
    const r = await extrairSinalDeImagem('base64', 'image/jpeg');
    expect(r.sinal).not.toBeNull();
    expect(r.provider).toBe('openai');
  });

  it('descarta em mock-mode sem lançar', async () => {
    h.impl = async () => ({ text: '[Mock Gemini Response] sem chave configurada', provider: 'gemini' });
    const r = await extrairSinalDeImagem('base64', 'image/jpeg');
    expect(r.sinal).toBeNull();
    expect(r.motivoDescarte).toBe('mock_mode');
  });

  it('descarta resposta sem JSON', async () => {
    h.impl = async () => ({ text: 'não consegui ler a imagem', provider: 'gemini' });
    const r = await extrairSinalDeImagem('base64', 'image/jpeg');
    expect(r.motivoDescarte).toBe('json_invalido');
  });

  it('descarta imagem que não é sinal', async () => {
    h.impl = async () => ({ text: '{"eh_sinal": false, "confianca": 0}', provider: 'gemini' });
    const r = await extrairSinalDeImagem('base64', 'image/jpeg');
    expect(r.motivoDescarte).toBe('nao_e_sinal');
  });

  it('print de casa vira contexto (casa, evento, dataHora normalizada)', async () => {
    h.impl = async () => ({
      text: JSON.stringify({
        tipo: 'print_casa',
        eh_sinal: false,
        confianca: 90,
        evento: 'Flamengo x Palmeiras',
        casaA: 'Novibet',
        dataHora: '18/07 21:30',
      }),
      provider: 'gemini',
    });
    const r = await extrairSinalDeImagem('base64', 'image/jpeg');
    expect(r.sinal).toBeNull();
    expect(r.motivoDescarte).toBe('print_casa');
    expect(r.contexto).toEqual({
      casa: 'Novibet',
      evento: 'Flamengo x Palmeiras',
      dataHora: `18/07/${new Date().getFullYear()} 21:30`,
    });
  });

  it('print de casa ilegível vira contexto com campos nulos', async () => {
    h.impl = async () => ({
      text: '{"tipo":"print_casa","eh_sinal":false,"confianca":30,"dataHora":"amanhã"}',
      provider: 'gemini',
    });
    const r = await extrairSinalDeImagem('base64', 'image/jpeg');
    expect(r.motivoDescarte).toBe('print_casa');
    expect(r.contexto).toEqual({ casa: null, evento: null, dataHora: null });
  });

  it('descarta sinal que falha na validação (com motivo)', async () => {
    h.impl = async () => ({ text: JSON.stringify({ ...SINAL_VALIDO, oddA: 1.0 }), provider: 'gemini' });
    const r = await extrairSinalDeImagem('base64', 'image/jpeg');
    expect(r.sinal).toBeNull();
    expect(r.motivoDescarte).toMatch(/^validacao: odds inválidas/);
  });
});

describe('validarSinal', () => {
  it('aceita o sinal de referência', () => {
    const v = validarSinal(SINAL_VALIDO);
    expect(v.ok).toBe(true);
    expect(v.sinal!.linha).toBe(2.5);
    expect(v.sinal!.dataHora).toBe('18/07/2026 16:00');
  });

  it('rejeita campo obrigatório vazio', () => {
    const v = validarSinal({ ...SINAL_VALIDO, evento: '  ' });
    expect(v.ok).toBe(false);
    expect(v.motivo).toContain('evento');
  });

  it('rejeita odds não numéricas e odds <= 1', () => {
    expect(validarSinal({ ...SINAL_VALIDO, oddA: 'abc' }).ok).toBe(false);
    expect(validarSinal({ ...SINAL_VALIDO, oddB: 1.0 }).ok).toBe(false);
  });

  it('rejeita quando não há break-even (não é surebet)', () => {
    // 1/2.0 + 1/2.0 = 1.0 → sem arb
    const v = validarSinal({ ...SINAL_VALIDO, oddA: 2.0, oddB: 2.0 });
    expect(v.ok).toBe(false);
    expect(v.motivo).toContain('não é surebet');
  });

  it('rejeita ROI > 25% (provável erro de OCR)', () => {
    // 3.0/3.0 → totalPerc 0.667 → ROI 50%
    const v = validarSinal({ ...SINAL_VALIDO, oddA: 3.0, oddB: 3.0 });
    expect(v.ok).toBe(false);
    expect(v.motivo).toContain('erro de OCR');
  });

  it('rejeita confiança abaixo do piso (default 70)', () => {
    const v = validarSinal({ ...SINAL_VALIDO, confianca: 50 });
    expect(v.ok).toBe(false);
    expect(v.motivo).toContain('abaixo do piso');
  });

  it('respeita TELEGRAM_MIN_CONFIANCA do ambiente', () => {
    process.env.TELEGRAM_MIN_CONFIANCA = '40';
    expect(validarSinal({ ...SINAL_VALIDO, confianca: 50 }).ok).toBe(true);
  });

  it('deriva a linha do rótulo quando o campo vem nulo', () => {
    const v = validarSinal({ ...SINAL_VALIDO, linha: null });
    expect(v.ok).toBe(true);
    expect(v.sinal!.linha).toBe(2.5);
  });

  it('não inventa linha de número em nome de time', () => {
    const v = validarSinal({
      ...SINAL_VALIDO,
      mercado: 'Vencedor',
      linha: null,
      opcaoA: 'Philadelphia 76ers',
      opcaoB: 'Boston Celtics',
    });
    expect(v.ok).toBe(true);
    expect(v.sinal!.linha).toBeNull();
  });
});

describe('normalizarDataHora', () => {
  it('mantém DD/MM/AAAA HH:MM', () => {
    expect(normalizarDataHora('18/07/2026 16:00')).toBe('18/07/2026 16:00');
  });

  it('completa o ano corrente em DD/MM HH:MM', () => {
    const ano = new Date().getFullYear();
    expect(normalizarDataHora('18/07 16:00')).toBe(`18/07/${ano} 16:00`);
  });

  it('preenche zeros à esquerda', () => {
    expect(normalizarDataHora('5/7/2026 9:05')).toBe('05/07/2026 09:05');
  });

  it('retorna null para lixo e valores fora de faixa', () => {
    expect(normalizarDataHora('amanhã cedo')).toBeNull();
    expect(normalizarDataHora('32/13/2026 25:99')).toBeNull();
    expect(normalizarDataHora(null)).toBeNull();
  });

  // Formatos relativos, ancorados na data da MENSAGEM (ref). 24/07/2026 15:00
  // em Brasília = 18:00 UTC; 24/07/2026 foi uma sexta-feira (dow=5).
  const ref = new Date('2026-07-24T18:00:00Z');

  it('resolve "Hoje HH:MM" e "Amanhã HH:MM" pela data da mensagem', () => {
    expect(normalizarDataHora('Hoje 21:30', ref)).toBe('24/07/2026 21:30');
    expect(normalizarDataHora('hoje às 21:30', ref)).toBe('24/07/2026 21:30');
    expect(normalizarDataHora('Amanhã 16:00', ref)).toBe('25/07/2026 16:00');
    expect(normalizarDataHora('amanha 16:00', ref)).toBe('25/07/2026 16:00');
  });

  it('vira o dia em Brasília, não em UTC (23:30 BRT ainda é o mesmo dia)', () => {
    // 23:30 em Brasília de 24/07 = 02:30 UTC de 25/07.
    const refNoite = new Date('2026-07-25T02:30:00Z');
    expect(normalizarDataHora('Hoje 23:45', refNoite)).toBe('24/07/2026 23:45');
  });

  it('resolve dia da semana para a PRÓXIMA ocorrência (hoje conta)', () => {
    expect(normalizarDataHora('Sex 19:00', ref)).toBe('24/07/2026 19:00');   // hoje é sexta
    expect(normalizarDataHora('Sáb 18:00', ref)).toBe('25/07/2026 18:00');
    expect(normalizarDataHora('sab 18:00', ref)).toBe('25/07/2026 18:00');
    expect(normalizarDataHora('Ter 19:00', ref)).toBe('28/07/2026 19:00');
    expect(normalizarDataHora('segunda-feira 20:00', ref)).toBe('27/07/2026 20:00');
  });

  it('dia da semana + data numérica usa a data numérica', () => {
    expect(normalizarDataHora('Sáb, 26/07 18:00', ref)).toBe('26/07/2026 18:00');
  });

  it('só o horário assume o dia da mensagem; aceita grafia "21h30"/"21h"', () => {
    expect(normalizarDataHora('21:30', ref)).toBe('24/07/2026 21:30');
    expect(normalizarDataHora('21h30', ref)).toBe('24/07/2026 21:30');
    expect(normalizarDataHora('21h', ref)).toBe('24/07/2026 21:00');
    expect(normalizarDataHora('Hoje 21h30', ref)).toBe('24/07/2026 21:30');
  });

  it('continua exigindo horário: "amanhã" sozinho é null', () => {
    expect(normalizarDataHora('amanhã', ref)).toBeNull();
    expect(normalizarDataHora('sábado', ref)).toBeNull();
  });
});
