import { describe, it, expect } from 'vitest';
import { isoParaBrasilia, htmlParaTexto } from '../../src/signals/dataHoraResolver';

describe('isoParaBrasilia', () => {
  it('converte ISO UTC para DD/MM/AAAA HH:MM em Brasília (UTC-3)', () => {
    expect(isoParaBrasilia('2026-07-19T00:30:00Z')).toBe('18/07/2026 21:30');
    expect(isoParaBrasilia('2026-07-18T15:00:00Z')).toBe('18/07/2026 12:00');
  });

  it('retorna null para ISO inválido', () => {
    expect(isoParaBrasilia('Hoje')).toBeNull();
    expect(isoParaBrasilia('')).toBeNull();
  });
});

describe('htmlParaTexto', () => {
  it('remove scripts, styles e tags, preservando o texto', () => {
    const html = '<html><head><style>.x{}</style><script>var a=1;</script></head>' +
      '<body><h1>Nashville SC x Atlanta Utd</h1><p>Hoje&nbsp;às <b>21:30</b></p></body></html>';
    expect(htmlParaTexto(html)).toBe('Nashville SC x Atlanta Utd Hoje às 21:30');
  });
});
