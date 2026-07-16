import { describe, it, expect } from 'vitest';
import { grupoTenis, mesmoGrupoTenis, mercadoPermitido, regraPermiteOportunidade } from '../../src/arbitrage/regras';

describe('regras.grupoTenis', () => {
  it('mapeia casas do usuário aos grupos corretos (com/sem "(BR)")', () => {
    expect(grupoTenis('KTO')).toBe('A');
    expect(grupoTenis('Superbet')).toBe('A');
    expect(grupoTenis('Aposta1 (BR)')).toBe('A');
    expect(grupoTenis('Betnacional (BR)')).toBe('A');
    expect(grupoTenis('Pinnacle')).toBe('B');
    expect(grupoTenis('BetWarrior')).toBe('B');
    expect(grupoTenis('Betano (BR)')).toBe('B');
    expect(grupoTenis('CasaInexistente')).toBeNull();
  });
  it('mesmoGrupoTenis: A×A e B×B ok; A×B e desconhecida não', () => {
    expect(mesmoGrupoTenis('KTO', 'Superbet')).toBe(true); // A×A
    expect(mesmoGrupoTenis('Pinnacle', 'BetWarrior')).toBe(true); // B×B
    expect(mesmoGrupoTenis('KTO', 'Pinnacle')).toBe(false); // A×B
    expect(mesmoGrupoTenis('Superbet', 'Pinnacle')).toBe(false); // A×B
    expect(mesmoGrupoTenis('KTO', 'Desconhecida')).toBe(false); // desconhecida
  });
});

describe('regras.mercadoPermitido', () => {
  it('futebol: Resultado Final / 1X2 PROIBIDO', () => {
    expect(mercadoPermitido('Futebol', 'Resultado Final')).toBe(false);
    expect(mercadoPermitido('Futebol', '1x2')).toBe(false);
  });
  it('futebol: Total, Handicap Asiático, BTTS liberados', () => {
    expect(mercadoPermitido('Futebol', 'Total de gols')).toBe(true);
    expect(mercadoPermitido('Futebol', 'Handicap')).toBe(true);
    expect(mercadoPermitido('Futebol', 'Ambas equipes marcam')).toBe(true);
  });
  it('basquete/tênis: moneyline (Resultado Final) liberado', () => {
    expect(mercadoPermitido('Basquete', 'Resultado Final')).toBe(true);
    expect(mercadoPermitido('Tenis', 'Resultado Final')).toBe(true);
  });
});

describe('regras.regraPermiteOportunidade', () => {
  const opp = (o: any) => ({ esporte: 'Futebol', mercado: 'Total de gols', casaA: 'KTO', casaB: 'Pinnacle', ...o });

  it('rejeita futebol Resultado Final', () => {
    expect(regraPermiteOportunidade(opp({ mercado: 'Resultado Final' })).ok).toBe(false);
  });
  it('permite futebol Total mesmo entre casas de grupos diferentes (grupo só vale p/ tênis)', () => {
    expect(regraPermiteOportunidade(opp({ mercado: 'Total de gols', casaA: 'KTO', casaB: 'Pinnacle' })).ok).toBe(true);
  });
  it('rejeita tênis A×B (KTO × Pinnacle)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Pinnacle' })).ok).toBe(false);
  });
  it('permite tênis A×A (KTO × Superbet)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Superbet' })).ok).toBe(true);
  });
  it('permite tênis B×B (Pinnacle × BetWarrior)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Total de Games', casaA: 'Pinnacle', casaB: 'BetWarrior' })).ok).toBe(true);
  });
});
