import { describe, it, expect } from 'vitest';
import { RevalidationService } from '../../src/core/revalidationService';

// linhaEmbutida/linhaDaOpcao são privados; acesso via cast (padrão de teste de unidade).
const svc = new RevalidationService() as any;

describe('parse de linha com vírgula decimal (SureRadar entrega "2,5")', () => {
  it('linhaDaOpcao: "Acima de 2,5" → 2.5 (não 2)', () => {
    expect(svc.linhaDaOpcao('Acima de 2,5')).toBe(2.5);
    expect(svc.linhaDaOpcao('Mais de 2.5')).toBe(2.5); // ponto segue funcionando
    expect(svc.linhaDaOpcao('Menos de 1,75')).toBe(1.75);
  });

  it('linhaEmbutida: handicap "Time A (-1,5)" → -1.5 (não null)', () => {
    expect(svc.linhaEmbutida('Time A (-1,5)')).toBe(-1.5);
    expect(svc.linhaEmbutida('Time B (+1.5)')).toBe(1.5); // ponto segue funcionando
  });

  it('rótulo sem número → null', () => {
    expect(svc.linhaDaOpcao('Flamengo')).toBeNull();
    expect(svc.linhaEmbutida('Vasco')).toBeNull();
  });
});
