import { describe, it, expect } from 'vitest';
import { BetBoomScraper } from '../../src/scraping/casa_betboom';
import { normalizarMercado } from '../../src/arbitrage/markets';

const FUTURO = Math.floor(Date.now() / 1000) + 3600;

const evento = (over: Partial<any>) => ({
  desc: {
    scheduled: FUTURO,
    type: 'match',
    virtual: false,
    sport: '1',
    competitors: [
      { id: 'a', name: 'Flamengo' },
      { id: 'b', name: 'Palmeiras' },
    ],
    ...over.desc,
  },
  markets: over.markets || {},
  state: { status: 0, ...(over.state || {}) },
});

const parse = (evs: Record<string, any>, sports: string[]) =>
  new BetBoomScraper().parseEventos(evs, new Set(sports));

describe('BetBoom parseEventos', () => {
  it('total com quarter-line passa; linha inteira não', () => {
    const odds = parse(
      {
        e1: evento({
          markets: {
            '18': {
              'total=2.25': { '12': { k: '1.9' }, '13': { k: '1.95' } },
              'total=3': { '12': { k: '2.1' }, '13': { k: '1.75' } },
            },
          },
        }),
      },
      ['1']
    );
    expect(odds).toHaveLength(1);
    expect(odds[0].mercado).toBe('Total de Gols');
    expect(odds[0].linha).toBe(2.25);
    expect(odds[0].opcaoA).toBe('Mais de 2.25');
    expect(normalizarMercado(odds[0].mercado)).toBe('TOTAIS_GOLS_FT');
  });

  it('handicap: linha do mandante (1714) com sinal correto nos rótulos', () => {
    const odds = parse(
      {
        e1: evento({
          markets: { '16': { 'hcp=-1.5': { '1714': { k: '2.4' }, '1715': { k: '1.55' } } } },
        }),
      },
      ['1']
    );
    expect(odds).toHaveLength(1);
    expect(odds[0].opcaoA).toBe('Flamengo (-1.5)');
    expect(odds[0].opcaoB).toBe('Palmeiras (+1.5)');
    expect(odds[0].oddA).toBe(2.4);
    expect(odds[0].linha).toBe(-1.5);
  });

  it('futebol NÃO emite 1x2 (mercado 1 fora da whitelist)', () => {
    const odds = parse(
      { e1: evento({ markets: { '1': { '': { '1': { k: '2' }, '2': { k: '3.2' }, '3': { k: '3.5' } } } } }) },
      ['1']
    );
    expect(odds).toHaveLength(0);
  });

  it('basquete: só mercados incl. prorrogação (219), 1x2 regulamentar fora', () => {
    const odds = parse(
      {
        e1: evento({
          desc: { sport: '2' },
          markets: {
            '1': { '': { '1': { k: '1.8' }, '2': { k: '15' }, '3': { k: '2' } } },
            '219': { '': { '4': { k: '1.85' }, '5': { k: '1.95' } } },
          },
        }),
      },
      ['2']
    );
    expect(odds).toHaveLength(1);
    expect(odds[0].mercado).toBe('Resultado Final');
    expect(odds[0].oddA).toBe(1.85); // outcome 4 = mandante
  });

  it('e-sports: mapa-vencedor/total/handicap de rodadas clusterizam por mapa (igual à Kambi)', () => {
    const odds = parse(
      {
        e1: evento({
          desc: { sport: '109', competitors: [{ id: 'a', name: 'FURIA' }, { id: 'b', name: 'NAVI' }] },
          markets: {
            '330': { 'mapnr=2': { '4': { k: '1.9' }, '5': { k: '1.85' } } },
            '332': { 'mapnr=1|total=21.5': { '12': { k: '1.87' }, '13': { k: '1.87' } } },
            '331': { 'mapnr=1|hcp=-2.5': { '1714': { k: '1.9' }, '1715': { k: '1.84' } } },
          },
        }),
      },
      ['109']
    );
    const porMercado = Object.fromEntries(odds.map((o) => [o.mercado, o]));
    expect(porMercado['Mapa 2']).toBeTruthy();
    expect(normalizarMercado('Mapa 2')).toBe('VENCEDOR_MAPA_M2');
    expect(normalizarMercado(porMercado['Mapa 1 - Total de rodadas'].mercado)).toBe('TOTAIS_ROUNDS_M1');
    expect(normalizarMercado(porMercado['Mapa 1 - Handicap de rodadas'].mercado)).toBe('HANDICAP_ROUNDS_M1');
  });

  it('exclui virtual, ao vivo (status≠0) e partida já iniciada', () => {
    const mkts = { '18': { 'total=2.5': { '12': { k: '1.9' }, '13': { k: '1.9' } } } };
    const odds = parse(
      {
        virtual: evento({ desc: { virtual: true }, markets: mkts }),
        live: evento({ state: { status: 1 }, markets: mkts }),
        passada: evento({ desc: { scheduled: Math.floor(Date.now() / 1000) - 60 }, markets: mkts }),
        ok: evento({ markets: mkts }),
      },
      ['1']
    );
    expect(odds).toHaveLength(1);
  });
});

/**
 * Lote 03/08/2026 — HANDICAP ASIÁTICO 0 = EMPATE ANULA (Draw No Bet).
 *
 * Com handicap 0 o empate devolve as duas pernas (push), que é exatamente a liquidação do
 * DNB: mesmo mercado, mesma estrutura de pagamento. Antes, `linhaArbitravel(0)` = false
 * descartava TODOS eles em silêncio — 477 dos 801 jogos de futebol da BetBoom (60%).
 */
describe('BetBoom — handicap asiático 0 vira Empate Anula', () => {
  const comHcp = (hcp: string, oH = '1.98', oA = '1.74') =>
    evento({ markets: { '16': { [`hcp=${hcp}`]: { '1714': { k: oH }, '1715': { k: oA } } } } });

  it('handicap 0 sai como Empate Anula, com os TIMES e SEM linha', () => {
    const odds = parse({ e1: comHcp('0') }, ['1']);
    expect(odds).toHaveLength(1);
    expect(odds[0].mercado).toBe('Empate Anula');
    expect(odds[0].opcaoA).toBe('Flamengo');
    expect(odds[0].opcaoB).toBe('Palmeiras');
    expect(odds[0].linha).toBeUndefined();
    expect(odds[0].oddA).toBe(1.98);
    expect(odds[0].oddB).toBe(1.74);
  });

  it('o canônico é DNB_FT — o mesmo de Kambi/Altenar/Superbet (senão não cruzaria)', () => {
    const odds = parse({ e1: comHcp('0') }, ['1']);
    expect(normalizarMercado(odds[0].mercado)).toBe('DNB_FT');
    expect(normalizarMercado(odds[0].mercado)).toBe(normalizarMercado('Empate anula a aposta'));
    // Não pode sair como handicap: viraria HANDICAP_GERAL_FT e cruzaria com handicap real.
    expect(normalizarMercado(odds[0].mercado)).not.toBe('HANDICAP_GERAL_FT');
  });

  it('"hcp=0.0" (mesma linha, outra grafia) também vira Empate Anula', () => {
    const odds = parse({ e1: comHcp('0.0') }, ['1']);
    expect(odds[0].mercado).toBe('Empate Anula');
  });

  it('handicap INTEIRO diferente de 0 segue descartado (push sem equivalente)', () => {
    expect(parse({ e1: comHcp('1') }, ['1'])).toHaveLength(0);
    expect(parse({ e1: comHcp('-2') }, ['1'])).toHaveLength(0);
  });

  it('meia-linha e quarter seguem saindo como Handicap normal, com sinal', () => {
    const meia = parse({ e1: comHcp('-1.5') }, ['1']);
    expect(meia[0].mercado).toBe('Handicap');
    expect(meia[0].linha).toBe(-1.5);
    expect(meia[0].opcaoA).toBe('Flamengo (-1.5)');
    expect(meia[0].opcaoB).toBe('Palmeiras (+1.5)');
    const quarter = parse({ e1: comHcp('0.25') }, ['1']);
    expect(quarter[0].mercado).toBe('Handicap');
    expect(quarter[0].linha).toBe(0.25);
  });
});

/**
 * Handicap 0 só é Empate Anula ONDE EXISTE EMPATE. Em tênis/basquete(incl. OT)/vôlei não
 * existe empate, então handicap 0 ali é o PRÓPRIO vencedor da partida — carimbá-lo
 * 'Empate Anula' colocaria um Resultado Final no canônico DNB_FT.
 */
describe('BetBoom — handicap 0 NÃO é DNB em esporte sem empate', () => {
  const evEsporte = (sport: string, mid: string) => ({
    desc: {
      scheduled: FUTURO, type: 'match', virtual: false, sport,
      competitors: [{ id: 'a', name: 'Alcaraz, C' }, { id: 'b', name: 'Sinner, J' }],
    },
    markets: { [mid]: { 'hcp=0': { '1714': { k: '1.90' }, '1715': { k: '1.90' } } } },
    state: { status: 0 },
  });

  it('tênis (sport 5, mercado 187): handicap 0 não vira Empate Anula', () => {
    const odds = parse({ e1: evEsporte('5', '187') }, ['5']);
    expect(odds.filter((o) => o.mercado === 'Empate Anula')).toHaveLength(0);
  });

  it('basquete (sport 2, mercado 223): handicap 0 não vira Empate Anula', () => {
    const odds = parse({ e1: evEsporte('2', '223') }, ['2']);
    expect(odds.filter((o) => o.mercado === 'Empate Anula')).toHaveLength(0);
  });

  it('futebol (sport 1, mercado 16) SEGUE virando Empate Anula', () => {
    const odds = parse({ e1: evEsporte('1', '16') }, ['1']);
    expect(odds.filter((o) => o.mercado === 'Empate Anula')).toHaveLength(1);
  });
});
