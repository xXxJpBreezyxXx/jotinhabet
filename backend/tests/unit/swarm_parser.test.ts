import { describe, it, expect } from 'vitest';
import { SeuBetScraper } from '../../src/scraping/casa_swarm';
import { normalizarMercado } from '../../src/arbitrage/markets';

const FUTURO = Math.floor(Date.now() / 1000) + 3600;

const jogo = (over: any = {}) => ({
  id: 1,
  team1_name: 'França',
  team2_name: 'Inglaterra',
  start_ts: FUTURO,
  is_blocked: 0,
  market: {},
  ...over,
});

const parse = (games: any[], sportId: number) => new SeuBetScraper().parseGames(games, sportId);

describe('Swarm parseGames (SeuBet/BetConstruct)', () => {
  it('P1P2 vira Resultado Final com W1=mandante', () => {
    const odds = parse(
      [jogo({ market: { m1: { type: 'P1P2', event: { a: { id: 1, type_1: 'W1', price: 1.5 }, b: { id: 2, type_1: 'W2', price: 2.6 } } } } })],
      4
    );
    expect(odds).toHaveLength(1);
    expect(odds[0].mercado).toBe('Resultado Final');
    expect(odds[0].opcaoA).toBe('França');
    expect(odds[0].oddA).toBe(1.5);
    expect(odds[0].esporte).toBe('Tenis');
  });

  it('total asiático do futebol: linha do market.base, quarter aceita e inteira barrada', () => {
    const mk = (base: number) => ({
      type: 'OverUnder', base,
      event: { o: { id: 1, type_1: 'Over', price: 2.05, base }, u: { id: 2, type_1: 'Under', price: 1.7, base } },
    });
    const odds = parse([jogo({ market: { a: mk(2.75), b: mk(3) } })], 1);
    expect(odds).toHaveLength(1);
    expect(odds[0].linha).toBe(2.75);
    expect(normalizarMercado(odds[0].mercado)).toBe('TOTAIS_GOLS_FT');
  });

  it('handicap usa o base do EVENTO Home — não o market.base (que no tênis vem invertido)', () => {
    // Caso real capturado: market.base=-1.5 mas Home carrega +1.5 (Sets Handicap do tênis).
    const odds = parse(
      [jogo({
        market: {
          m1: {
            type: 'Sets Handicap', base: -1.5,
            event: { h: { id: 1, type_1: 'Home', price: 1.53, base: 1.5 }, a: { id: 2, type_1: 'Away', price: 2.35, base: -1.5 } },
          },
        },
      })],
      4
    );
    expect(odds).toHaveLength(1);
    expect(odds[0].linha).toBe(1.5);
    expect(odds[0].opcaoA).toBe('França (+1.5)');
    expect(odds[0].opcaoB).toBe('Inglaterra (-1.5)');
    expect(normalizarMercado(odds[0].mercado)).toBe('HANDICAP_SETS_FT');
  });

  it('tipos fora da whitelist (estatísticas, P1XP2) são ignorados', () => {
    const odds = parse(
      [jogo({
        market: {
          m1: { type: 'P1XP2', event: { a: { id: 1, type_1: 'W1', price: 1.33 }, b: { id: 2, type_1: 'X', price: 17 }, c: { id: 3, type_1: 'W2', price: 3.38 } } },
          m2: { type: 'CornersOverUnder', base: 11.5, event: { o: { id: 4, type_1: 'Over', price: 3.42 }, u: { id: 5, type_1: 'Under', price: 1.23 } } },
          m3: { type: 'Shots:Total', base: 24.5, event: { o: { id: 6, type_1: 'Over', price: 1.6 }, u: { id: 7, type_1: 'Under', price: 2.08 } } },
        },
      })],
      1
    );
    expect(odds).toHaveLength(0);
  });

  it('exclui jogo bloqueado e jogo já iniciado', () => {
    const mk = { type: 'P1P2', event: { a: { id: 1, type_1: 'W1', price: 1.5 }, b: { id: 2, type_1: 'W2', price: 2.6 } } };
    const odds = parse(
      [
        jogo({ is_blocked: 1, market: { m1: mk } }),
        jogo({ start_ts: Math.floor(Date.now() / 1000) - 60, market: { m1: mk } }),
        jogo({ market: { m1: mk } }),
      ],
      41
    );
    expect(odds).toHaveLength(1);
    expect(odds[0].esporte).toBe('Tenis de Mesa');
  });

  it('e-sports: MapsTotal/MapsHandicap clusterizam como as outras casas', () => {
    const odds = parse(
      [jogo({
        team1_name: 'FURIA', team2_name: 'NAVI',
        market: {
          m1: { type: 'MapsTotal', base: 2.5, event: { o: { id: 1, type_1: 'Over', price: 1.97 }, u: { id: 2, type_1: 'Under', price: 1.73 } } },
          m2: { type: 'MapsHandicap', base: -1.5, event: { h: { id: 3, type_1: 'Home', price: 1.41, base: 1.5 }, a: { id: 4, type_1: 'Away', price: 2.68, base: -1.5 } } },
        },
      })],
      75
    );
    const canon = odds.map((o) => normalizarMercado(o.mercado)).sort();
    expect(canon).toEqual(['HANDICAP_MAPAS_FT', 'TOTAIS_MAPAS_FT']);
    expect(odds.every((o) => o.esporte === 'Esports')).toBe(true);
  });
});
