import { describe, it, expect } from 'vitest';
import { BetEsporteScraper, BeRef } from '../../src/scraping/casa_betesporte';
import { normalizarMercado } from '../../src/arbitrage/markets';

const FUTURO = new Date(Date.now() + 3600_000).toISOString();

/** Opção do feed: externalId manda, `name` carrega a linha quando não há campo `line`. */
const opt = (externalId: string, name: string, odd: number, over: Partial<any> = {}) => ({
  id: 1, externalId, name, odd, locked: false, blocked: false, hide: false, ...over,
});

const ref = (sportId: number, over: Partial<any> = {}): BeRef => ({
  sportId,
  tournamentId: 10,
  countryId: 20,
  ev: {
    id: 999,
    homeTeamName: 'Flamengo',
    awayTeamName: 'Palmeiras',
    date: FUTURO,
    optionsCount: 100,
    ...over,
  },
});

const parse = (sportId: number, mercados: any[], evOver: Partial<any> = {}, opts?: any) =>
  new BetEsporteScraper(opts).parseEvento(ref(sportId, evOver), mercados);

const porMercado = (odds: any[]) => Object.fromEntries(odds.map((o) => [o.mercado, o]));

describe('BetEsporte parseEvento — futebol', () => {
  it('1x2 de 3 vias sai como DUPLA CHANCE SINTÉTICA (nunca 3 vias cru)', () => {
    const odds = parse(1, [
      {
        type: 1, name: '1x2', locked: false,
        options: [opt('1', 'Casa', 2.0), opt('2', 'Empate', 3.4), opt('3', 'Fora', 3.6)],
      },
    ]);
    expect(odds).toHaveLength(1);
    expect(odds[0].mercado).toBe('Resultado Final');
    expect(odds[0].opcaoA).toBe('Vitória Flamengo');
    expect(odds[0].opcaoB).toBe('Palmeiras ou Empate');
    expect(odds[0].oddA).toBe(2.0);
    expect(odds[0].oddB).toBeCloseTo(1 / (1 / 3.4 + 1 / 3.6), 10);
    expect(normalizarMercado(odds[0].mercado)).toBe('RESULTADO_FINAL_FT');
  });

  it('dupla chance com odd combinada <= 1 é descartada (não compõe arbitragem)', () => {
    const odds = parse(1, [
      {
        type: 1, name: '1x2',
        options: [opt('1', 'Casa', 9.0), opt('2', 'Empate', 1.5), opt('3', 'Fora', 3.0)],
      },
    ]);
    expect(odds).toHaveLength(0);
  });

  it('total: meia-linha e quarter passam, linha INTEIRA é descartada (push)', () => {
    const odds = parse(1, [
      { type: 18, name: 'Total', line: '2.5', options: [opt('12', 'Mais de 2.5', 2.46), opt('13', 'Menos de 2.5', 1.48)] },
      { type: 18, name: 'Total', line: '2.25', options: [opt('12', 'Mais de 2.25', 1.9), opt('13', 'Menos de 2.25', 1.95)] },
      { type: 18, name: 'Total', line: '2', options: [opt('12', 'Mais de 2', 1.84), opt('13', 'Menos de 2', 1.86)] },
    ]);
    expect(odds.map((o) => o.linha)).toEqual([2.5, 2.25]);
    expect(odds[0].mercado).toBe('Total de Gols');
    expect(odds[0].opcaoA).toBe('Mais de 2.5');
    expect(odds[0].opcaoB).toBe('Menos de 2.5');
    expect(normalizarMercado(odds[0].mercado)).toBe('TOTAIS_GOLS_FT');
  });

  it('handicap: linha do MANDANTE com sinal espelhado no visitante', () => {
    const odds = parse(1, [
      { type: 16, name: 'Handicap', line: '-1.5', options: [opt('1714', 'Casa (-1.5)', 2.4), opt('1715', 'Fora (+1.5)', 1.55)] },
    ]);
    expect(odds).toHaveLength(1);
    expect(odds[0].linha).toBe(-1.5);
    expect(odds[0].opcaoA).toBe('Flamengo (-1.5)');
    expect(odds[0].opcaoB).toBe('Palmeiras (+1.5)');
    expect(odds[0].oddA).toBe(2.4);
    expect(normalizarMercado(odds[0].mercado)).toBe('HANDICAP_GERAL_FT');
  });

  it('DNB e BTTS saem com os rótulos canônicos do projeto', () => {
    const odds = parse(1, [
      { type: 11, name: 'Empate devolve aposta', options: [opt('4', 'Casa', 1.44), opt('5', 'Fora', 3.1)] },
      { type: 29, name: 'Ambas as equipes marcam', options: [opt('74', 'Sim', 2.04), opt('76', 'Não', 1.6)] },
    ]);
    const m = porMercado(odds);
    expect(normalizarMercado(m['Empate Anula'].mercado)).toBe('DNB_FT');
    expect(m['Empate Anula'].opcaoA).toBe('Flamengo');
    expect(normalizarMercado(m['Ambas equipes marcam'].mercado)).toBe('AMBAS_MARCAM_FT');
    expect(m['Ambas equipes marcam'].opcaoB).toBe('Não');
  });

  it('mercados fora da whitelist não entram: promo 1601, escanteios, por-time e períodos', () => {
    const odds = parse(1, [
      // "1x2 (Pagamento antecipado)" — promoção, liquida diferente do 1x2
      { type: 1601, name: '1x2 (Pagamento antecipado)', options: [opt('1', 'Casa', 2.1), opt('2', 'Empate', 3.3), opt('3', 'Fora', 3.5)] },
      { type: 166, name: 'Total de escanteios', options: [opt('12', 'Mais de 8.5', 1.63), opt('13', 'Menos de 8.5', 1.92)] },
      { type: 165, name: 'Escanteios handicap', options: [opt('1714', 'Casa (-0.5)', 2.29), opt('1715', 'Fora (+0.5)', 1.37)] },
      { type: 19, name: 'Casa total', options: [opt('12', 'Mais de 1.5', 3.85), opt('13', 'Menos de 1.5', 1.22)] },
      { type: 68, name: '1ª parte - total', options: [opt('12', 'Mais de 0.5', 1.48), opt('13', 'Menos de 0.5', 2.16)] },
      { type: 60, name: '1ª parte - 1x2', options: [opt('1', 'Casa', 3.0), opt('2', 'Empate', 2.0), opt('3', 'Fora', 4.0)] },
    ]);
    expect(odds).toHaveLength(0);
  });

  it('odd travada (locked → odd 0) invalida o mercado inteiro', () => {
    const odds = parse(1, [
      { type: 18, name: 'Total', line: '3.5', options: [opt('12', 'Mais de 3.5', 4.59), opt('13', 'Menos de 3.5', 0, { locked: true })] },
      { type: 16, name: 'Handicap', line: '-0.5', locked: true, options: [opt('1714', 'Casa (-0.5)', 1.9), opt('1715', 'Fora (+0.5)', 1.9)] },
    ]);
    expect(odds).toHaveLength(0);
  });

  it('linha do campo `line` divergindo do rótulo da opção é descartada (guarda de sinal)', () => {
    const odds = parse(1, [
      { type: 16, name: 'Handicap', line: '-1.5', options: [opt('1714', 'Casa (+1.5)', 1.19), opt('1715', 'Fora (-1.5)', 3.85)] },
    ]);
    expect(odds).toHaveLength(0);
  });

  it('mesma oferta repetida no feed entra uma única vez', () => {
    const mkt = { type: 18, name: 'Total', line: '2.5', options: [opt('12', 'Mais de 2.5', 2.46), opt('13', 'Menos de 2.5', 1.48)] };
    expect(parse(1, [mkt, { ...mkt }])).toHaveLength(1);
  });

  it('evento sem data válida não emite nada (nunca inventar kickoff)', () => {
    const odds = parse(
      1,
      [{ type: 18, name: 'Total', line: '2.5', options: [opt('12', 'Mais de 2.5', 2.46), opt('13', 'Menos de 2.5', 1.48)] }],
      { date: 'Hoje' }
    );
    expect(odds).toHaveLength(0);
  });
});

describe('BetEsporte parseEvento — demais esportes', () => {
  it('basquete: só as versões "incluindo prorrogação"; 1x2 por quarto fora', () => {
    const odds = parse(2, [
      { type: 219, name: 'Vencedor (incluindo prolongamento)', options: [opt('4', 'Casa', 1.85), opt('5', 'Fora', 1.95)] },
      { type: 223, name: 'Handicap (incluindo prolongamento)', options: [opt('1714', 'Casa (+5.5)', 1.9), opt('1715', 'Fora (-5.5)', 1.9)] },
      { type: 225, name: 'Total (incluindo prolongamento)', options: [opt('12', 'Mais de 184.5', 1.87), opt('13', 'Menos de 184.5', 1.87)] },
      { type: 235, name: '1º quarto - 1x2', options: [opt('1', 'Casa', 2.1), opt('2', 'Empate', 12), opt('3', 'Fora', 2.2)] },
    ]);
    const m = porMercado(odds);
    expect(Object.keys(m).sort()).toEqual(['Handicap', 'Resultado Final', 'Total de Pontos']);
    expect(m['Resultado Final'].oddA).toBe(1.85); // externalId 4 = mandante
    expect(m['Handicap'].linha).toBe(5.5); // linha lida do rótulo (não há campo `line`)
    expect(m['Handicap'].opcaoA).toBe('Flamengo (+5.5)');
    expect(m['Total de Pontos'].linha).toBe(184.5);
    expect(normalizarMercado(m['Total de Pontos'].mercado)).toBe('TOTAIS_PONTOS_FT');
  });

  it('tênis: 187 é handicap de GAMES (rótulo "Handicap"), 188 é de SETS', () => {
    const odds = parse(5, [
      { type: 186, name: 'Vencedor', options: [opt('4', 'Casa', 1.5), opt('5', 'Fora', 2.6)] },
      { type: 187, name: 'Handicap de jogos', options: [opt('1714', 'Casa (-2.5)', 1.9), opt('1715', 'Fora (+2.5)', 1.9)] },
      { type: 188, name: 'Handicap de sets', options: [opt('1714', 'Casa (-1.5)', 2.5), opt('1715', 'Fora (+1.5)', 1.5)] },
      { type: 189, name: 'Total jogos', options: [opt('12', 'Mais de 20.5', 1.85), opt('13', 'Menos de 20.5', 1.9)] },
    ]);
    const m = porMercado(odds);
    expect(normalizarMercado(m['Handicap'].mercado)).toBe('HANDICAP_GERAL_FT');
    expect(normalizarMercado(m['Handicap de Sets'].mercado)).toBe('HANDICAP_SETS_FT');
    expect(normalizarMercado(m['Total de Games'].mercado)).toBe('TOTAIS_GAMES_FT');
    expect(m['Handicap'].linha).toBe(-2.5);
    expect(m['Handicap de Sets'].opcaoB).toBe('Palmeiras (+1.5)');
  });

  it('tênis de mesa e vôlei: handicap/total de PONTOS (assunto no rótulo)', () => {
    for (const sid of [20, 23]) {
      const odds = parse(sid, [
        { type: 186, name: 'Vencedor', options: [opt('4', 'Casa', 1.4), opt('5', 'Fora', 2.9)] },
        { type: 237, name: 'Handicap pontos', options: [opt('1714', 'Casa (+1.5)', 1.8), opt('1715', 'Fora (-1.5)', 1.95)] },
        { type: 238, name: 'Total pontos', options: [opt('12', 'Mais de 75.5', 1.9), opt('13', 'Menos de 75.5', 1.85)] },
      ]);
      const m = porMercado(odds);
      expect(normalizarMercado(m['Handicap de Pontos'].mercado)).toBe('HANDICAP_PONTOS_FT');
      expect(normalizarMercado(m['Total de Pontos'].mercado)).toBe('TOTAIS_PONTOS_FT');
      expect(odds[0].esporte).toBe(sid === 20 ? 'Tenis de Mesa' : 'Volei');
    }
  });

  it('beisebol: versões "incluindo innings extra" com Total de Corridas', () => {
    const odds = parse(3, [
      { type: 251, name: 'Vencedor (incluindo innings extra)', options: [opt('4', 'Casa', 1.7), opt('5', 'Fora', 2.2)] },
      { type: 256, name: 'Handicap (incluindo innings extra)', options: [opt('1714', 'Casa (-2.5)', 3.1), opt('1715', 'Fora (+2.5)', 1.4)] },
      { type: 258, name: 'Total (incluindo innings extra)', options: [opt('12', 'Mais de 6.5', 1.9), opt('13', 'Menos de 6.5', 1.9)] },
    ]);
    const m = porMercado(odds);
    expect(normalizarMercado(m['Total de Corridas'].mercado)).toBe('TOTAIS_CORRIDAS_FT');
    expect(m['Handicap'].linha).toBe(-2.5);
    expect(odds[0].esporte).toBe('Beisebol');
  });
});

describe('BetEsporte parseEvento — e-sports (numeração de provedor própria)', () => {
  const ES = { homeTeamName: 'FURIA', awayTeamName: 'NAVI' };

  it('vencedor da partida 2 vias entra; a variante 1x2 do MESMO type é descartada', () => {
    const odds = parse(
      205,
      [
        { type: 1, name: 'Vencedor da Partida - (incluindo OT)', options: [opt('1', 'FURIA', 1.9), opt('2', 'NAVI', 1.85)] },
      ],
      ES
    );
    expect(odds).toHaveLength(1);
    expect(odds[0].esporte).toBe('Esports');
    expect(odds[0].mercado).toBe('Resultado Final');
    expect(odds[0].opcaoA).toBe('FURIA');

    const tresVias = parse(
      209,
      [
        {
          type: 1, name: 'Vencedor da Partida - 1x2',
          options: [opt('1', 'FURIA', 1.9), opt('3', 'empate', 12), opt('2', 'NAVI', 1.85)],
        },
      ],
      ES
    );
    expect(tresVias).toHaveLength(0);
  });

  it('mapas: vencedor, total/handicap de rodadas clusterizam por mapa (igual à Kambi/BetBoom)', () => {
    const odds = parse(
      205,
      [
        { type: 6, name: 'Vencedor do Mapa 2 - (incluindo OT)', options: [opt('1', 'FURIA', 1.9), opt('2', 'NAVI', 1.85)] },
        { type: 6, name: 'Vencedor do Mapa 2 - 1x2', options: [opt('1', 'FURIA', 2.0), opt('3', 'empate', 20), opt('2', 'NAVI', 1.95)] },
        // ordem invertida de propósito: a perna sai pelo externalId (4=menos, 5=mais)
        { type: 24, name: 'Total de Rounds - Mapa 1', options: [opt('5', 'mais de 21.5', 1.87), opt('4', 'menos de 21.5', 1.9)] },
        { type: 11, name: 'Handicap de Rounds - Mapa 1', options: [opt('1', 'FURIA -2.5', 1.9), opt('2', 'NAVI +2.5', 1.84)] },
        { type: 3, name: 'Total de Mapas', options: [opt('4', 'menos de 2.5', 1.7), opt('5', 'mais de 2.5', 2.1)] },
        { type: 2, name: 'Handicap da Partida', options: [opt('1', 'FURIA +1.5', 1.25), opt('2', 'NAVI -1.5', 3.6)] },
        // type 126 é total POR TIME — fora da whitelist mesmo com nome parecido
        { type: 126, name: 'FURIA Total de Rounds - Mapa 1', options: [opt('4', 'menos de 7.5', 1.9), opt('5', 'mais de 7.5', 1.9)] },
      ],
      ES
    );
    const m = porMercado(odds);
    expect(Object.keys(m).sort()).toEqual([
      'Handicap de Mapas', 'Mapa 1 - Handicap de rodadas', 'Mapa 1 - Total de rodadas', 'Mapa 2', 'Total de Mapas',
    ]);
    expect(normalizarMercado(m['Mapa 2'].mercado)).toBe('VENCEDOR_MAPA_M2');
    expect(normalizarMercado(m['Mapa 1 - Total de rodadas'].mercado)).toBe('TOTAIS_ROUNDS_M1');
    expect(normalizarMercado(m['Mapa 1 - Handicap de rodadas'].mercado)).toBe('HANDICAP_ROUNDS_M1');
    expect(normalizarMercado(m['Total de Mapas'].mercado)).toBe('TOTAIS_MAPAS_FT');
    expect(normalizarMercado(m['Handicap de Mapas'].mercado)).toBe('HANDICAP_MAPAS_FT');
    expect(m['Mapa 1 - Total de rodadas'].oddA).toBe(1.87); // 5 = mais
    expect(m['Mapa 1 - Total de rodadas'].oddB).toBe(1.9); // 4 = menos
    expect(m['Mapa 1 - Handicap de rodadas'].linha).toBe(-2.5); // sinal do mandante
    expect(m['Handicap de Mapas'].linha).toBe(1.5);
    expect(m['Handicap de Mapas'].opcaoA).toBe('FURIA (+1.5)');
  });
});

describe('BetEsporte refsElegiveis', () => {
  const AGORA = Date.parse('2026-07-31T20:00:00Z');
  const ev = (id: number, over: Partial<any> = {}) => ({
    id, homeTeamName: 'A', awayTeamName: 'B', date: '2026-07-31T22:00:00Z', markets: [], ...over,
  });
  const arvore = (eventos: any[], over: Partial<any> = {}) => [
    {
      id: 1, name: 'Futebol',
      countries: [{ id: 20, name: 'Brasil', blocked: false, tournaments: [{ id: 10, name: 'Série A', blocked: false, events: eventos, ...over }] }],
    },
  ];

  it('descarta bloqueado, sem data e partida já iniciada', () => {
    const refs = new BetEsporteScraper().refsElegiveis(
      arvore([
        ev(1),
        ev(2, { blocked: true }),
        ev(3, { date: undefined }),
        ev(4, { date: '2026-07-31T19:00:00Z' }), // já começou
        ev(1), // id repetido
      ]),
      new Set([1]),
      AGORA
    );
    expect(refs.map((r) => r.ev.id)).toEqual([1]);
    expect(refs[0]).toMatchObject({ sportId: 1, tournamentId: 10, countryId: 20 });
  });

  it('torneio/país bloqueado derruba os eventos de dentro', () => {
    const refs = new BetEsporteScraper().refsElegiveis(arvore([ev(1)], { blocked: true }), new Set([1]), AGORA);
    expect(refs).toHaveLength(0);
  });

  it('esporte fora do mapa é ignorado (futsal, e-soccer...)', () => {
    const nodes = arvore([ev(1)]);
    nodes[0].id = 29; // Futsal
    expect(new BetEsporteScraper().refsElegiveis(nodes, new Set([29]), AGORA)).toHaveLength(0);
  });

  it('com incluirAoVivo a partida em andamento é MANTIDA', () => {
    const refs = new BetEsporteScraper({ incluirAoVivo: true }).refsElegiveis(
      arvore([ev(4, { date: '2026-07-31T19:00:00Z' })]),
      new Set([1]),
      AGORA
    );
    expect(refs.map((r) => r.ev.id)).toEqual([4]);
  });
});
