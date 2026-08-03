import { describe, it, expect } from 'vitest';
import { KtoScraper } from '../../src/scraping/casa_kambi';
import { normalizarMercado, mesmaOferta } from '../../src/arbitrage/markets';

/**
 * Regressão do teste ao vivo de 17/07/2026: mercados [Jogo] do beisebol da BetWarrior
 * que NÃO são match-winner ("Turnos 1", "Lidera após 5 Innings", "O primeiro time que
 * marca", "Odds do jogo (pitcher precisa começar)") eram carimbados de 'Resultado
 * Final' e cruzavam com o moneyline real de outra casa (ROI falso de até 29%).
 */

const ev = { id: 1, name: 'A - B', homeName: 'Boston Red Sox', awayName: 'Tampa Bay Rays', start: '2026-07-17T20:00:00Z' };
const parse = (bo: any) => ((new KtoScraper()) as any).parseBetOffer(bo, ev, 'baseball');

const bo2way = (label: string, o1 = 1810, o2 = 1920) => ({
  eventId: 1,
  criterion: { label },
  outcomes: [
    { type: 'OT_ONE', odds: o1, label: '1' },
    { type: 'OT_TWO', odds: o2, label: '2' },
  ],
});
const bo3way = (label: string) => ({
  eventId: 1,
  criterion: { label },
  outcomes: [
    { type: 'OT_ONE', odds: 3900, label: '1' },
    { type: 'OT_CROSS', odds: 1750, label: 'X' },
    { type: 'OT_TWO', odds: 3500, label: '2' },
  ],
});

describe('Kambi parseBetOffer — whitelist de match-winner (fail-closed)', () => {
  it('"Vencedor da partida" vira Resultado Final', () => {
    expect(parse(bo2way('Vencedor da partida'))?.mercado).toBe('Resultado Final');
  });
  it('"Vencedor da partida - Incluindo prorrogação" (basquete) vira Resultado Final', () => {
    expect(parse(bo2way('Vencedor da partida - Incluindo prorrogação'))?.mercado).toBe('Resultado Final');
  });
  it('"Turnos 1" (3-vias do 1º inning) NÃO vira Resultado Final', () => {
    const odd = parse(bo3way('Turnos 1'));
    expect(odd?.mercado).toBe('Turnos 1');
    expect(normalizarMercado(odd!.mercado)).not.toBe('RESULTADO_FINAL_FT');
  });
  it('"O primeiro time que marca" (2-vias) NÃO vira Resultado Final', () => {
    expect(parse(bo2way('O primeiro time que marca'))?.mercado).toBe('O primeiro time que marca');
  });
  it('"Odds do jogo (pitcher precisa começar)" NÃO vira Resultado Final', () => {
    expect(parse(bo2way('Odds do jogo (Jake Bennett precisa começar)'))?.mercado)
      .toBe('Odds do jogo (Jake Bennett precisa começar)');
  });
  it('"Lidera após 5 Innings" (3-vias) NÃO vira Resultado Final', () => {
    expect(parse(bo3way('Lidera após 5 Innings'))?.mercado).toBe('Lidera após 5 Innings');
  });
  it('"Vencedor - Set 2" (tênis) segue preservado como segmento', () => {
    const odd = parse(bo2way('Vencedor - Set 2'));
    expect(odd?.mercado).toBe('Vencedor - Set 2');
  });
});

describe('markets — períodos de beisebol não colidem com o jogo completo', () => {
  it('F5 (Primeiros 5 innings, com as variações reais de grafia) ≠ jogo completo', () => {
    expect(normalizarMercado('Handicap - Primeiros 5 innings')).toBe('HANDICAP_GERAL_E5');
    expect(normalizarMercado('Total de runs - Primeiro(s) 5 Innings')).toBe('TOTAIS_CORRIDAS_E5');
    expect(mesmaOferta('Handicap - Primeiros 5 innings', -1.5, 'Handicap', -1.5)).toBe(false);
    expect(mesmaOferta('Total de runs - Primeiro(s) 5 Innings', 4.5, 'Total de Corridas (incl. entradas extras)', 4.5)).toBe(false);
  });
  it('"Total de Corridas - Turnos 1" (1 inning) ≠ jogo completo', () => {
    expect(normalizarMercado('Total de Corridas - Turnos 1')).toBe('TOTAIS_CORRIDAS_I1');
    expect(mesmaOferta('Total de Corridas - Turnos 1', 0.5, 'Total de corridas', 0.5)).toBe(false);
  });
  it('jogo completo cruza entre casas: "Total de runs" × "Total de Corridas (incl. entradas extras)"', () => {
    expect(mesmaOferta('Total de runs', 8.5, 'Total de Corridas (incl. entradas extras)', 8.5)).toBe(true);
  });
});

/**
 * Lote 03/08/2026 — o Kambi repassa o `criterion` CRU como nome de mercado, então ele
 * escapa da convenção de nomes do projeto e passa a cruzar SÓ com o outro Kambi.
 * Medido: 468 ofertas/varredura de "Handicap de Game" (tênis) presas em
 * HANDICAP_GAMES_FT enquanto Pinnacle/NSoft/BetBoom/Altenar/Betsson publicam o MESMO
 * mercado como 'Handicap' → HANDICAP_GERAL_FT.
 */
describe('Kambi — convenção de nome do handicap de tênis', () => {
  const evT = { id: 9, name: 'A - B', homeName: 'Fritz, T', awayName: 'Jodar, R', start: '2026-08-03T14:00:00Z' };
  const parseT = (bo: any) => ((new KtoScraper()) as any).parseBetOffer(bo, evT, 'tennis');
  const hcp = (label: string, line: number) => ({
    eventId: 9,
    criterion: { label },
    outcomes: [
      { type: 'OT_ONE', odds: 1850, label: '1', line },
      { type: 'OT_TWO', odds: 1950, label: '2', line },
    ],
  });

  it('"Handicap de Game" é emitido como "Handicap" (canônico das outras casas)', () => {
    const odd = parseT(hcp('Handicap de Game', -3500));
    expect(odd?.mercado).toBe('Handicap');
    expect(normalizarMercado(odd!.mercado)).toBe('HANDICAP_GERAL_FT');
  });

  it('cruza com o handicap de tênis da Betsson/Pinnacle (era o bug: nunca cruzava)', () => {
    const odd = parseT(hcp('Handicap de Game', -3500));
    // 'Handicap' é o rótulo que Betsson/Pinnacle/NSoft/BetBoom emitem para o mesmo mercado.
    expect(mesmaOferta(odd!.mercado, odd!.linha, 'Handicap', -3.5)).toBe(true);
    // E o canônico antigo (HANDICAP_GAMES_FT) não é mais produzido.
    expect(normalizarMercado(odd!.mercado)).not.toBe('HANDICAP_GAMES_FT');
  });

  it('"Handicap de Set" NÃO é traduzido — já bate com "Handicap de Sets" das outras', () => {
    const odd = parseT(hcp('Handicap de Set', -1500));
    expect(odd?.mercado).toBe('Handicap de Set');
    expect(mesmaOferta(odd!.mercado, odd!.linha, 'Handicap de Sets', -1.5)).toBe(true);
    // …e nunca com o handicap de games, que é outro mercado.
    expect(mesmaOferta(odd!.mercado, odd!.linha, 'Handicap', -1.5)).toBe(false);
  });
});

/**
 * Desempates (tie-breaks) e quebras de saque caíam os DOIS em TOTAIS_GERAL_FT. O jogo
 * Taylor Fritz x Rafael Jodar publica os dois ao mesmo tempo (03/08/2026): bastava a
 * linha coincidir para o motor pareá-los como a MESMA aposta e fabricar surebet falsa.
 */
describe('markets — totais de tênis que colapsavam em GERAL', () => {
  it('desempates e quebras de saque têm canônicos DISTINTOS', () => {
    expect(normalizarMercado('Total de desempates')).toBe('TOTAIS_TIEBREAKS_FT');
    expect(normalizarMercado('Total de quebras de saque')).toBe('TOTAIS_QUEBRAS_SAQUE_FT');
    expect(normalizarMercado('Total de desempates')).not.toBe(normalizarMercado('Total de quebras de saque'));
  });
  it('não são mais a "mesma oferta" na linha coincidente (era o arb falso)', () => {
    expect(mesmaOferta('Total de desempates', 3.5, 'Total de quebras de saque', 3.5)).toBe(false);
  });
  it('nenhum dos dois cruza com o total de games da partida', () => {
    expect(mesmaOferta('Total de desempates', 9.5, 'Total de Games', 9.5)).toBe(false);
    expect(mesmaOferta('Total de quebras de saque', 9.5, 'Total de Games', 9.5)).toBe(false);
  });
  it('mesmo mercado entre casas segue cruzando (não quebrei o caso bom)', () => {
    expect(mesmaOferta('Total de desempates', 2.5, 'Total de Desempates', 2.5)).toBe(true);
  });
});
