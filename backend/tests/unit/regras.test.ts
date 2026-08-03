import { describe, it, expect } from 'vitest';
import { casaBloqueada, grupoTenis, mesmoGrupoTenis, mercadoPermitido, regraPermiteOportunidade } from '../../src/arbitrage/regras';
import { normalizarMercado, mesmaOferta } from '../../src/arbitrage/markets';

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
  it('auditoria 03/08/2026: Betsson classificada em B (regra de "1 set concluído")', () => {
    // §17.57 do rulebook oficial: "um set completo deve ser completado para que as apostas
    // sejam válidas" — mesma redação da Pinnacle, e sem cláusula de void por desistência
    // (o mesmo doc escreve avanço explícito no snooker, então o silêncio é proposital).
    expect(grupoTenis('Betsson')).toBe('B');
    expect(grupoTenis('Betsson (BR)')).toBe('B');
    // B×B libera; B×A segue rejeitado.
    expect(mesmoGrupoTenis('Betsson', 'Pinnacle')).toBe(true);
    expect(mesmoGrupoTenis('Betsson', 'KTO')).toBe(true);
    expect(mesmoGrupoTenis('Betsson', 'Superbet')).toBe(false);
    expect(mesmoGrupoTenis('Betsson', 'Betano')).toBe(false);
    // O bloqueio da KTO em Handicap/Totais de tênis é por CASA e vale por cima do grupo.
    expect(
      regraPermiteOportunidade({
        esporte: 'Tenis', evento: 'A vs B', mercado: 'Handicap', linha: -1.5,
        casaA: 'Betsson', casaB: 'KTO', oddA: 2, oddB: 2, opcaoA: 'A', opcaoB: 'B',
      } as any).ok
    ).toBe(false);
  });
  it('auditoria 03/08/2026: EstrelaBet e 4Play em A (void puro, template Altenar)', () => {
    // "se um tenista se retirar antes do último ponto concluído, o mercado vencedor da
    // partida é anulado" — texto idêntico nas duas e igual ao que classificou a BrBET.
    // Adversarial: nenhum "avanço" ligado a tênis; "um set" só em DEFINIÇÃO de mercado.
    expect(grupoTenis('EstrelaBet')).toBe('A');
    expect(grupoTenis('4Play')).toBe('A');
    expect(grupoTenis('EstrelaBet (BR)')).toBe('A');
    // A×A libera o tênis entre elas e com as outras casas de A (eram ~4.500 odds/varredura
    // com o tênis todo rejeitado pelo fail-safe de grupo desconhecido).
    expect(mesmoGrupoTenis('EstrelaBet', '4Play')).toBe(true);
    expect(mesmoGrupoTenis('EstrelaBet', 'Aposta1')).toBe(true);
    expect(mesmoGrupoTenis('4Play', 'Superbet')).toBe(true);
    // …e A×B segue rejeitado contra o Grupo B (Kambi/Pinnacle/Betsson).
    expect(mesmoGrupoTenis('EstrelaBet', 'KTO')).toBe(false);
    expect(mesmoGrupoTenis('4Play', 'Betsson')).toBe(false);
    expect(mesmoGrupoTenis('4Play', 'Pinnacle')).toBe(false);
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

describe('casas vetadas na operação', () => {
  it('EsporteNetBet (e variantes) é vetada em qualquer mercado e qualquer fonte', () => {
    expect(casaBloqueada('EsporteNetBet')).toBe(true);
    expect(casaBloqueada('esporte net bet')).toBe(true);
    expect(casaBloqueada('EsporteNet VIP')).toBe(true);
    expect(casaBloqueada('EsporteNetBet (BR)')).toBe(true);
    const r = regraPermiteOportunidade({
      esporte: 'Futebol',
      mercado: 'Total de Gols',
      casaA: 'EsporteNetBet',
      casaB: 'KTO',
    });
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('vetada');
  });

  it('NÃO confunde com EsportesDaSorte, que é casa integrada e legítima', () => {
    // Os nomes são parecidos; comparar por "contém" quebraria a casa boa.
    expect(casaBloqueada('EsportesDaSorte')).toBe(false);
    expect(casaBloqueada('Esportes da Sorte')).toBe(false);
    expect(
      regraPermiteOportunidade({ esporte: 'Futebol', mercado: 'Total de Gols', casaA: 'EsportesDaSorte', casaB: 'KTO' }).ok
    ).toBe(true);
  });

  it('casa vazia/desconhecida não é vetada por acidente', () => {
    expect(casaBloqueada('')).toBe(false);
    expect(casaBloqueada('Betano')).toBe(false);
  });
});

describe('W.O. do tênis: auditoria das casas novas (31/07/2026)', () => {
  it('BrBET e MarjoSports entram no Grupo A (regra publicada = void)', () => {
    expect(grupoTenis('BrBET')).toBe('A');
    expect(grupoTenis('MarjoSports')).toBe('A');
    // A×A é permitido; A×B continua bloqueado.
    expect(mesmoGrupoTenis('BrBET', 'Superbet')).toBe(true);
    expect(mesmoGrupoTenis('MarjoSports', 'BrBET')).toBe(true);
    expect(mesmoGrupoTenis('BrBET', 'KTO')).toBe(false);
  });

  it('EsportesDaSorte entra no Grupo A — e isso NÃO estende para a Onabet (mesmo operador)', () => {
    // A regra que classifica vem do SPORTSBOOK (Sportingtech), não do grupo empresarial: o
    // T&C das duas é o mesmo documento e é mudo sobre desistência. A Onabet roda Altenar.
    expect(grupoTenis('EsportesDaSorte')).toBe('A');
    expect(grupoTenis('Onabet')).toBeNull();
    expect(mesmoGrupoTenis('EsportesDaSorte', 'Onabet')).toBe(false);
  });

  it('Onabet e BetEsporte ficam SEM grupo: nenhuma das duas publica regra de abandono', () => {
    // Fail-safe da doutrina: sem regra do OPERADOR, tênis fica bloqueado. A Onabet é Altenar,
    // e Altenar tem operador em A (Aposta1) e em B (KTO) — chutar aqui é a armadilha A×B.
    expect(grupoTenis('Onabet')).toBeNull();
    expect(grupoTenis('BetEsporte')).toBeNull();
    const r = regraPermiteOportunidade({
      esporte: 'Tênis',
      mercado: 'Vencedor da Partida',
      casaA: 'Onabet',
      casaB: 'Superbet',
    });
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('W.O.');
  });

  it('tênis entre as duas classificadas passa no gate', () => {
    expect(
      regraPermiteOportunidade({ esporte: 'Tênis', mercado: 'Vencedor da Partida', casaA: 'BrBET', casaB: 'MarjoSports' }).ok
    ).toBe(true);
  });
});

/**
 * Blindagem de 03/08/2026 — os feeds erram o gênero do ordinal. O Altenar publica
 * "1ª tempo - Total de gols" (feminino), e sem aceitar o "ª" esse mercado caía em FT:
 * `mesmaOferta('1ª tempo - Total de gols', 1.5, 'Total de Gols', 1.5)` devolvia TRUE, ou
 * seja, over 1.5 do PRIMEIRO TEMPO pareava com over 1.5 da PARTIDA INTEIRA — pernas não
 * complementares, "surebet" que perde sempre.
 */
describe('markets — ordinal de tempo com gênero errado no feed', () => {
  const casos = ['1ª tempo - Total de gols', '1º tempo - Total de gols', '1o tempo - Total de gols'];
  it('todas as grafias de 1º tempo dão TOTAIS_GOLS_1T', () => {
    for (const c of casos) expect(normalizarMercado(c), c).toBe('TOTAIS_GOLS_1T');
  });
  it('nenhuma grafia cruza com o total da PARTIDA na mesma linha', () => {
    for (const c of casos) expect(mesmaOferta(c, 1.5, 'Total de Gols', 1.5), c).toBe(false);
  });
  it('2º tempo idem, e 1º tempo nunca cruza com 2º tempo', () => {
    expect(normalizarMercado('2ª tempo - Total de gols')).toBe('TOTAIS_GOLS_2T');
    expect(mesmaOferta('1ª tempo - Total de gols', 1.5, '2ª tempo - Total de gols', 1.5)).toBe(false);
  });
  it('o total da partida segue cruzando com ele mesmo (não quebrei o caso bom)', () => {
    expect(mesmaOferta('Total de Gols', 2.5, 'Total de gols', 2.5)).toBe(true);
  });
});
