import { describe, it, expect } from 'vitest';
import { MarjoSportsScraper, NgxScraper } from '../../src/scraping/casa_ngx';
import { normalizarMercado } from '../../src/arbitrage/markets';

const FUTURO = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
const PASSADO = new Date(Date.now() - 30 * 60 * 1000).toISOString();

const on = (value: number, over: any = {}) => ({ value, enable: true, status: 'ACTIVE', ...over });
/** Placeholder de linha fora do ar: o feed usa value 1 (basquete) ou 0 (futebol ao vivo). */
const off = (value = 1, status = 'DEACTIVATED') => ({ value, enable: true, status });
const total = (header: string, name: string, o: any) => ({ header, team: null, name, ...o });
const hcp = (team: string, name: string, o: any) => ({ header: null, team, name, ...o });

const evento = (t: string, odds: any, over: any = {}) => ({
  _id: 'x1',
  __t: t,
  status: 'NOT_STARTED',
  start_date: FUTURO,
  valid_odds: 300,
  home_competitor: { pt_br: 'Casa FC' },
  away_competitor: { pt_br: 'Fora FC' },
  odds,
  ...over,
});

const parse = (ev: any, opts?: { incluirAoVivo?: boolean }) =>
  new MarjoSportsScraper(opts).parseEvento(ev as any);

describe('NGX parseEvento (MarjoSports)', () => {
  it('futebol: dupla chance PRONTA vira Resultado Final (odd real, não a sintética)', () => {
    const odds = parse(
      evento('Soccer', {
        full_time: {
          home: on(1.85), draw: on(3.38), away: on(4.25),
          draw_or_away: on(1.82), home_or_draw: on(1.22), home_or_away: on(1.28),
        },
      })
    );
    expect(odds).toHaveLength(1);
    const o = odds[0];
    expect(o.mercado).toBe('Resultado Final');
    expect(normalizarMercado(o.mercado)).toBe('RESULTADO_FINAL_FT');
    expect(o.esporte).toBe('Futebol');
    expect(o.opcaoA).toBe('Vitória Casa FC');
    expect(o.opcaoB).toBe('Fora FC ou Empate');
    expect(o.oddA).toBe(1.85);
    expect(o.oddB).toBe(1.82); // real; a sintética daria ~1.883
    expect(o.dataHora).toBe(FUTURO);
  });

  it('futebol sem dupla chance pronta: cai na sintética empate+fora', () => {
    const odds = parse(evento('Soccer', { full_time: { home: on(1.85), draw: on(3.38), away: on(4.25) } }));
    expect(odds).toHaveLength(1);
    expect(odds[0].oddB).toBeCloseTo(1 / (1 / 3.38 + 1 / 4.25), 6);
  });

  it('futebol: 1X2 NUNCA sai como 2 vias — sem empate nem dupla chance, não emite nada', () => {
    // Empate suspenso e sem draw_or_away: "Casa × Fora" deixaria o empate descoberto.
    const odds = parse(evento('Soccer', { full_time: { home: on(1.85), draw: off(0, 'SUSPENDED'), away: on(4.25) } }));
    expect(odds).toHaveLength(0);
  });

  it('futebol: dupla chance sintética <= 1 é descartada (impossível de arbitrar)', () => {
    // Mandante zebra extrema + margem alta: 1/(1/1.6 + 1/2.5) = 0.976, ou seja apostar nos
    // dois lados do B custa mais do que retorna (caso real visto na Luvabet em 29/07).
    const odds = parse(evento('Soccer', { full_time: { home: on(9.0), draw: on(1.6), away: on(2.5) } }));
    expect(odds).toHaveLength(0);
  });

  it('futebol: BTTS e Empate Anula do detalhe', () => {
    const odds = parse(
      evento('Soccer', {
        full_time: {
          both_teams_to_score_yes: on(1.84), both_teams_to_score_no: on(1.86),
          home_draw_no_bet: on(1.34), away_draw_no_bet: on(2.9),
        },
      })
    );
    const porMercado = Object.fromEntries(odds.map((o) => [normalizarMercado(o.mercado), o]));
    expect(Object.keys(porMercado).sort()).toEqual(['AMBAS_MARCAM_FT', 'DNB_FT']);
    expect(porMercado.AMBAS_MARCAM_FT.opcaoA).toBe('Sim');
    expect(porMercado.AMBAS_MARCAM_FT.opcaoB).toBe('Não');
    expect(porMercado.DNB_FT.opcaoA).toBe('Casa FC');
    expect(porMercado.DNB_FT.oddB).toBe(2.9);
  });

  it('total de gols: meia-linha e quarter entram, linha INTEIRA fica fora', () => {
    const odds = parse(
      evento('Soccer', {
        full_time: {
          goals_over_under: [
            total('OVER', '2.5', on(1.94)), total('UNDER', '2.5', on(1.77)),
            total('OVER', '2.75', on(2.1)), total('UNDER', '2.75', on(1.72)),
            total('OVER', '3.0', on(2.4)), total('UNDER', '3.0', on(1.55)),
          ],
        },
      })
    );
    expect(odds.map((o) => o.linha).sort()).toEqual([2.5, 2.75]);
    expect(odds.every((o) => normalizarMercado(o.mercado) === 'TOTAIS_GOLS_FT')).toBe(true);
    const l25 = odds.find((o) => o.linha === 2.5)!;
    expect([l25.opcaoA, l25.opcaoB]).toEqual(['Mais de 2.5', 'Menos de 2.5']);
    expect([l25.oddA, l25.oddB]).toEqual([1.94, 1.77]);
  });

  it('total: over/under suspenso ou placeholder (value<=1) não forma par; total POR TIME é ignorado', () => {
    const odds = parse(
      evento('Soccer', {
        full_time: {
          goals_over_under: [
            total('OVER', '1.5', on(1.3)), total('UNDER', '1.5', off(1)),
            total('OVER', '4.5', on(3.8)), total('UNDER', '4.5', off(0, 'SUSPENDED')),
            total('OVER', '5.5', on(6.9, { enable: false })), total('UNDER', '5.5', on(1.09)),
          ],
          // `team_goals_over_under` nem é lido, mas se um item por-time vazasse no array do
          // total da partida ele não pode virar par (é outro mercado).
          team_goals_over_under: [
            { header: 'OVER', team: 'HOME', name: '2.5', ...on(2.08) },
            { header: 'UNDER', team: 'HOME', name: '2.5', ...on(1.64) },
          ],
        },
      })
    );
    expect(odds).toHaveLength(0);
  });

  it('handicap asiático: par HOME(L) × AWAY(-L) pelo sinal, linha 0.0 barrada', () => {
    const odds = parse(
      evento('Soccer', {
        full_time: {
          asian_handicap: [
            hcp('HOME', '-0.5', on(1.76)), hcp('AWAY', '0.5', on(1.85)),
            hcp('HOME', '0.0', on(1.33)), hcp('AWAY', '-0.0', on(2.81)),
            hcp('HOME', '-1.0', on(2.38)), hcp('AWAY', '1.0', on(1.45)),
            hcp('HOME', '-1.5', on(2.99)), hcp('AWAY', '1.5', off(1)),
          ],
        },
      })
    );
    expect(odds).toHaveLength(1);
    const o = odds[0];
    expect(normalizarMercado(o.mercado)).toBe('HANDICAP_GERAL_FT');
    expect(o.linha).toBe(-0.5);
    expect(o.opcaoA).toBe('Casa FC (-0.5)');
    expect(o.opcaoB).toBe('Fora FC (+0.5)');
    expect([o.oddA, o.oddB]).toEqual([1.76, 1.85]);
  });

  it('tênis: +1.5 e -1.5 do mandante no MESMO array não podem parear entre si', () => {
    // Caso real do sets_handicap: o feed publica as duas linhas do mandante juntas.
    // Pareamento por |L| juntaria HOME(+1.5) com AWAY(+1.5) — duas pernas do mesmo lado.
    const odds = parse(
      evento('Tennis', {
        full_time: {
          home: on(2.1), away: on(1.74),
          games_over_under: [total('OVER', '22.5', on(2.28)), total('UNDER', '22.5', on(1.58))],
          games_handicap: [hcp('HOME', '0.5', on(2.01)), hcp('AWAY', '-0.5', on(1.75))],
          sets_handicap: [
            hcp('HOME', '1.5', on(1.48)), hcp('AWAY', '-1.5', on(2.47)),
            hcp('HOME', '-1.5', on(3.05)), hcp('AWAY', '1.5', on(1.33)),
          ],
        },
      })
    );
    const sets = odds.filter((o) => o.mercado === 'Handicap de Sets').sort((a, b) => a.linha! - b.linha!);
    expect(sets.map((o) => [o.linha, o.oddA, o.oddB])).toEqual([
      [-1.5, 3.05, 1.33],
      [1.5, 1.48, 2.47],
    ]);
    expect(sets[1].opcaoA).toBe('Casa FC (+1.5)');
    expect(sets[1].opcaoB).toBe('Fora FC (-1.5)');
    const canon = odds.map((o) => normalizarMercado(o.mercado)).sort();
    expect(canon).toEqual([
      'HANDICAP_GERAL_FT', 'HANDICAP_SETS_FT', 'HANDICAP_SETS_FT',
      'RESULTADO_FINAL_FT', 'TOTAIS_GAMES_FT',
    ]);
    expect(odds.find((o) => o.mercado === 'Resultado Final')!.opcaoA).toBe('Casa FC');
  });

  it('basquete: lê o full_match (2 vias, inclui prorrogação) e IGNORA o full_time (3 vias regulamentar)', () => {
    const odds = parse(
      evento('Basketball', {
        full_match: {
          home: on(3.2), away: on(1.27),
          points_over_under: [
            total('OVER', '181.5', off(1)), total('UNDER', '181.5', off(1)),
            total('OVER', '175.5', on(1.86)), total('UNDER', '175.5', on(1.78)),
          ],
          points_handicap: [hcp('HOME', '8.5', on(1.76)), hcp('AWAY', '-8.5', on(1.88))],
        },
        // Tempo regulamentar (traz empate). As Diretrizes proíbem cruzar "sem prorrogação".
        full_time: { home: on(3.4), draw: on(17), away: on(1.3) },
      })
    );
    expect(odds).toHaveLength(3);
    const rf = odds.find((o) => o.mercado === 'Resultado Final')!;
    expect([rf.oddA, rf.oddB]).toEqual([3.2, 1.27]); // do full_match, não do full_time
    expect(rf.opcaoA).toBe('Casa FC');
    expect(odds.map((o) => normalizarMercado(o.mercado)).sort()).toEqual([
      'HANDICAP_GERAL_FT', 'RESULTADO_FINAL_FT', 'TOTAIS_PONTOS_FT',
    ]);
    expect(odds.find((o) => o.linha === 175.5)!.oddA).toBe(1.86);
    expect(odds.find((o) => o.mercado === 'Handicap')!.linha).toBe(8.5);
  });

  it('tênis de mesa e vôlei usam os rótulos de PONTOS das outras casas', () => {
    const mesa = parse(
      evento('TableTennis', {
        full_time: {
          home: on(3.1), away: on(1.28),
          points_over_under: [total('OVER', '72.5', on(1.9)), total('UNDER', '72.5', on(1.85))],
          points_handicap: [hcp('HOME', '4.5', on(1.95)), hcp('AWAY', '-4.5', on(1.8))],
        },
      })
    );
    expect(mesa[0].esporte).toBe('Tenis de Mesa');
    expect(mesa.map((o) => normalizarMercado(o.mercado)).sort()).toEqual([
      'HANDICAP_PONTOS_FT', 'RESULTADO_FINAL_FT', 'TOTAIS_PONTOS_FT',
    ]);
    const volei = parse(
      evento('Volley', {
        full_match: {
          home: on(2.06), away: on(1.68),
          points_over_under: [total('OVER', '183.5', on(1.9)), total('UNDER', '183.5', on(1.83))],
          points_handicap: [hcp('HOME', '3.5', on(1.9)), hcp('AWAY', '-3.5', on(1.85))],
          sets_handicap: [hcp('HOME', '1.5', on(1.35)), hcp('AWAY', '-1.5', on(2.9))],
        },
      })
    );
    expect(volei[0].esporte).toBe('Volei');
    expect(volei.map((o) => normalizarMercado(o.mercado)).sort()).toEqual([
      'HANDICAP_PONTOS_FT', 'HANDICAP_SETS_FT', 'RESULTADO_FINAL_FT', 'TOTAIS_PONTOS_FT',
    ]);
  });

  it('beisebol: full_match (inclui innings extra) → Resultado Final + Total de Corridas', () => {
    const odds = parse(
      evento('Baseball', {
        full_match: {
          home: on(1.74), away: on(2.1),
          runs_over_under: [total('OVER', '8.5', on(1.95)), total('UNDER', '8.5', on(1.87))],
          runs_handicap: [hcp('HOME', '-1.5', on(2.35)), hcp('AWAY', '1.5', on(1.6))],
        },
        // 9 innings, 3 vias — liquidação diferente, não pode virar Resultado Final.
        full_time: { home_1x2: on(1.83), draw_1x2: on(8.6), away_1x2: on(2.24) },
      })
    );
    expect(odds.map((o) => normalizarMercado(o.mercado)).sort()).toEqual([
      'HANDICAP_GERAL_FT', 'RESULTADO_FINAL_FT', 'TOTAIS_CORRIDAS_FT',
    ]);
    expect(odds.find((o) => o.mercado === 'Resultado Final')!.oddA).toBe(1.74);
  });

  it('sem a flag: LIVE e NOT_STARTED com kickoff no passado ficam fora', () => {
    const mercado = { full_time: { home: on(1.85), draw: on(3.38), away: on(4.25) } };
    expect(parse(evento('Soccer', mercado, { status: 'LIVE', start_date: PASSADO }))).toHaveLength(0);
    expect(parse(evento('Soccer', mercado, { status: 'NOT_STARTED', start_date: PASSADO }))).toHaveLength(0);
    expect(parse(evento('Soccer', mercado, { status: 'ENDED' }))).toHaveLength(0);
    expect(parse(evento('Soccer', mercado))).toHaveLength(1);
  });

  it('com a flag: mantém a partida em andamento, mas não o registro pendurado', () => {
    const mercado = { full_time: { home: on(1.85), draw: on(3.38), away: on(4.25) } };
    const vivo = { incluirAoVivo: true };
    const live = parse(evento('Soccer', mercado, { status: 'LIVE', start_date: PASSADO }), vivo);
    expect(live).toHaveLength(1);
    // dataHora no passado é o único sinal de "ao vivo" (ScrapedOdd não tem campo de estado).
    expect(Date.parse(live[0].dataHora)).toBeLessThan(Date.now());
    // NOT_STARTED atrasado: 30 min é ordem de quadra (entra); 4h é registro furado (sai).
    expect(parse(evento('Soccer', mercado, { start_date: PASSADO }), vivo)).toHaveLength(1);
    const atrasado4h = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    expect(parse(evento('Soccer', mercado, { start_date: atrasado4h }), vivo)).toHaveLength(0);
    // LIVE aceita recuo largo (4h ainda vale), mas não o zumbi de 2 dias.
    expect(parse(evento('Soccer', mercado, { status: 'LIVE', start_date: atrasado4h }), vivo)).toHaveLength(1);
    const zumbi = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    expect(parse(evento('Soccer', mercado, { status: 'LIVE', start_date: zumbi }), vivo)).toHaveLength(0);
    expect(parse(evento('Soccer', mercado, { start_date: zumbi }), vivo)).toHaveLength(0);
  });

  it('descarta evento sem competidor, sem data válida, virtual ou de esporte não mapeado', () => {
    const mercado = { full_time: { home: on(1.85), draw: on(3.38), away: on(4.25) } };
    expect(parse(evento('Soccer', mercado, { home_competitor: {}, home_team: '' }))).toHaveLength(0);
    expect(parse(evento('Soccer', mercado, { start_date: 'amanhã' }))).toHaveLength(0);
    expect(parse(evento('Soccer', mercado, { home_competitor: { pt_br: 'Casa FC', is_virtual: true } }))).toHaveLength(0);
    expect(parse(evento('ESoccer', mercado))).toHaveLength(0);
    expect(parse(evento('Soccer', { full_match: { to_qualify_home: on(1.5), to_qualify_away: on(2.5) } }))).toHaveLength(0);
  });

  it('mescla catálogo+detalhe: detalhe manda, catálogo cobre o que ele suspendeu', () => {
    // Caso real do ao vivo: a lista traz home/away ACTIVE e o detalhe, pedido segundos
    // depois, volta com o principal suspenso (mercado suspende a cada bola). Trocar cego
    // pelo detalhe perderia o Resultado Final.
    const s = new MarjoSportsScraper({ incluirAoVivo: true });
    const lista = evento('Tennis', { full_time: { home: on(2.1), away: on(1.6) } }, { status: 'LIVE', start_date: PASSADO });
    const detalhe = evento(
      'Tennis',
      {
        full_time: {
          home: off(0), away: off(0),
          games_over_under: [total('OVER', '22.5', on(2.28)), total('UNDER', '22.5', on(1.58))],
        },
      },
      { status: 'LIVE', start_date: PASSADO }
    );
    const out = (s as any).mesclar(lista, detalhe) as any[];
    expect(out.map((o) => normalizarMercado(o.mercado)).sort()).toEqual(['RESULTADO_FINAL_FT', 'TOTAIS_GAMES_FT']);
    expect(out.find((o) => o.mercado === 'Resultado Final').oddA).toBe(2.1); // veio da lista
    // Sem conflito de chave: o principal ATIVO no detalhe não sai duplicado com o da lista.
    const detAtivo = evento('Tennis', { full_time: { home: on(2.2), away: on(1.55) } }, { status: 'LIVE', start_date: PASSADO });
    const out2 = (s as any).mesclar(lista, detAtivo) as any[];
    expect(out2).toHaveLength(1);
    expect(out2[0].oddA).toBe(2.2); // detalhe manda (snapshot mais novo)
  });

  it('a base é multi-tenant: a marca só troca nome e Origin', () => {
    class OutraMarca extends NgxScraper {
      constructor() {
        super({ nome: 'Outra', origin: 'https://outra.bet.br' });
      }
    }
    expect(new OutraMarca().getNome()).toBe('Outra');
    expect(new MarjoSportsScraper().getNome()).toBe('MarjoSports');
    expect(
      new OutraMarca().parseEvento(evento('Soccer', { full_time: { home: on(2), draw_or_away: on(1.9) } }) as any)
    ).toHaveLength(1);
  });
});
