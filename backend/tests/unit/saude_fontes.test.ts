import { describe, it, expect } from 'vitest';
import { ArbitrageScannerV2 } from '../../src/core/scanner_v2';

/**
 * A Pinnacle passou ~3h fora da varredura em 03/08/2026 sem ninguém saber: o exit node do
 * túnel caiu, e o scraper engoliu o erro por esporte e devolveu lista VAZIA. Uma casa
 * "bem-sucedida com 0 odds" era indistinguível de uma casa sem jogos — daí o critério de
 * falha ser `0 odds` OU exceção.
 */
const sc = () => new ArbitrageScannerV2() as any;
const registrar = (s: any, casa: string, odds: number, motivo: string | null = null) =>
  s.registrarSaudeDaFonte(casa, odds, motivo);

describe('saúde das fontes', () => {
  it('0 odds SEM erro conta como falha (era o caso invisível da Pinnacle)', () => {
    const s = sc();
    registrar(s, 'Pinnacle', 0, null);
    registrar(s, 'Pinnacle', 0, null);
    expect(s.caiuAgora).toHaveLength(0); // ainda no limiar
    registrar(s, 'Pinnacle', 0, null);
    expect(s.caiuAgora).toHaveLength(1);
    expect(s.caiuAgora[0]).toContain('Pinnacle');
    expect(s.caiuAgora[0]).toContain('0 odds, sem erro');
  });

  it('avisa UMA vez por queda, não a cada varredura (senão é spam de 5 em 5 min)', () => {
    const s = sc();
    for (let i = 0; i < 8; i++) registrar(s, 'Pinnacle', 0, null);
    expect(s.caiuAgora).toHaveLength(1);
  });

  it('coleta boa antes do limiar zera o contador', () => {
    const s = sc();
    registrar(s, 'KTO', 0, null);
    registrar(s, 'KTO', 0, null);
    registrar(s, 'KTO', 1500, null);
    registrar(s, 'KTO', 0, null);
    expect(s.caiuAgora).toHaveLength(0);
  });

  it('recuperação é anunciada só se a queda foi avisada', () => {
    const s = sc();
    for (let i = 0; i < 3; i++) registrar(s, 'Pinnacle', 0, null);
    s.caiuAgora.splice(0);
    registrar(s, 'Pinnacle', 900, null);
    expect(s.voltouAgora).toEqual(['Pinnacle']);
    // e volta a poder avisar numa próxima queda
    for (let i = 0; i < 3; i++) registrar(s, 'Pinnacle', 0, null);
    expect(s.caiuAgora).toHaveLength(1);
  });

  it('uma casa que nunca caiu não gera aviso de recuperação', () => {
    const s = sc();
    registrar(s, 'Superbet', 700, null);
    registrar(s, 'Superbet', 700, null);
    expect(s.voltouAgora).toHaveLength(0);
  });

  it('exceção carrega o motivo na mensagem', () => {
    const s = sc();
    for (let i = 0; i < 3; i++) registrar(s, 'Betnacional', 0, 'fetch failed');
    expect(s.caiuAgora[0]).toContain('fetch failed');
  });

  it('casas são contabilizadas de forma independente', () => {
    const s = sc();
    for (let i = 0; i < 3; i++) { registrar(s, 'Pinnacle', 0, null); registrar(s, 'KTO', 1200, null); }
    expect(s.caiuAgora).toEqual([expect.stringContaining('Pinnacle')]);
  });
});
