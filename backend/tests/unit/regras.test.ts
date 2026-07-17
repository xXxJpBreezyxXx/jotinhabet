import { describe, it, expect } from 'vitest';
import { grupoTenis, mesmoGrupoTenis, mercadoPermitido, regraPermiteOportunidade } from '../../src/arbitrage/regras';

describe('regras.grupoTenis', () => {
  it('mapeia casas do usuário aos grupos corretos (com/sem "(BR)")', () => {
    // KTO rebaixada A→B em 17/07/2026 (KTO.md): o provedor não anula no Vencedor.
    expect(grupoTenis('KTO')).toBe('B');
    expect(grupoTenis('Superbet')).toBe('A');
    expect(grupoTenis('Aposta1 (BR)')).toBe('A');
    expect(grupoTenis('Betnacional (BR)')).toBe('A');
    expect(grupoTenis('Pinnacle')).toBe('B');
    expect(grupoTenis('BetWarrior')).toBe('B');
    // Vbet classificada A em 17/07/2026 (VBET.md): regra publicada anula em abandono.
    expect(grupoTenis('Vbet')).toBe('A');
    expect(grupoTenis('Vbet (BR)')).toBe('A');
    expect(grupoTenis('CasaInexistente')).toBeNull();
  });
  it('auditoria 17/07/2026 (GRUPOS_WO_CASAS.md): reclassificações aplicadas', () => {
    // Betano B→A: regra publicada é void puro — cruzá-la como B com a KTO era o mesmo
    // padrão de prejuízo do incidente Brumm×Savkin.
    expect(grupoTenis('Betano (BR)')).toBe('A');
    // Template de avanço/1 set (red no desistente) → Grupo B.
    expect(grupoTenis('Stake')).toBe('B');
    expect(grupoTenis('BolsaDeAposta')).toBe('B');
    expect(grupoTenis('Rei do Pitaco')).toBe('B');
    expect(grupoTenis('1xBet')).toBe('B');
    // Novibet: regra inacessível → sem grupo (bloqueada no tênis).
    expect(grupoTenis('Novibet')).toBeNull();
    // Betnacional fica em A (variante win/void — nunca dá red por abandono).
    expect(grupoTenis('Betnacional (BR)')).toBe('A');
  });
  it('mesmoGrupoTenis: A×A e B×B ok; A×B e desconhecida não', () => {
    expect(mesmoGrupoTenis('Superbet', 'Aposta1')).toBe(true); // A×A
    expect(mesmoGrupoTenis('Pinnacle', 'BetWarrior')).toBe(true); // B×B
    expect(mesmoGrupoTenis('KTO', 'Pinnacle')).toBe(true); // B×B (KTO rebaixada em 17/07)
    expect(mesmoGrupoTenis('KTO', 'Superbet')).toBe(false); // B×A
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
  it('rejeita tênis A×B (Superbet × Pinnacle)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'Superbet', casaB: 'Pinnacle' })).ok).toBe(false);
  });
  it('permite tênis A×A (Superbet × Aposta1)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'Superbet', casaB: 'Aposta1' })).ok).toBe(true);
  });
  it('permite tênis B×B no moneyline (KTO × Pinnacle, pós-rebaixamento)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Pinnacle' })).ok).toBe(true);
  });
  it('permite tênis B×B (Pinnacle × BetWarrior)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Total de Games', casaA: 'Pinnacle', casaB: 'BetWarrior' })).ok).toBe(true);
  });
  it('tênis: KTO bloqueada em Handicap/Totais (KTO.md §3), mesmo B×B', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Total de Games', casaA: 'KTO', casaB: 'Pinnacle' })).ok).toBe(false);
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Handicap', casaA: 'BetWarrior', casaB: 'KTO' })).ok).toBe(false);
  });
  it('tênis de MESA herda as regras do tênis (grupos de W.O.)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis de Mesa', mercado: 'Resultado Final', casaA: 'Superbet', casaB: 'Aposta1' })).ok).toBe(true);
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis de Mesa', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Superbet' })).ok).toBe(false);
  });
  it('tênis: KTO×Betano REJEITADO pós-auditoria (Betano é A; era a whitelist antiga do KTO.md)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Betano (BR)' })).ok).toBe(false);
    // Pares B novos da KTO seguem liberados no moneyline (Handicap/Totais da KTO continuam bloqueados).
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Stake' })).ok).toBe(true);
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: '1xBet', casaB: 'Pinnacle' })).ok).toBe(true);
    // Novibet sem grupo: nunca cruza no tênis.
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'Novibet', casaB: 'Superbet' })).ok).toBe(false);
  });
  it('tênis: Vbet[A] cruza com Grupo A e é bloqueada contra Grupo B (VBET.md)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'Vbet', casaB: 'Superbet' })).ok).toBe(true);
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'Vbet', casaB: 'Pinnacle' })).ok).toBe(false);
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis', mercado: 'Resultado Final', casaA: 'Vbet', casaB: 'KTO' })).ok).toBe(false);
    expect(regraPermiteOportunidade(opp({ esporte: 'Tenis de Mesa', mercado: 'Resultado Final', casaA: 'Vbet (BR)', casaB: 'SeuBet' })).ok).toBe(true);
  });
  it('vôlei/beisebol: sem restrição de grupo (moneyline liberado)', () => {
    expect(regraPermiteOportunidade(opp({ esporte: 'Volei', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Superbet' })).ok).toBe(true);
    expect(regraPermiteOportunidade(opp({ esporte: 'Beisebol', mercado: 'Total de Corridas', casaA: 'Pinnacle', casaB: 'Aposta1' })).ok).toBe(true);
  });
});
