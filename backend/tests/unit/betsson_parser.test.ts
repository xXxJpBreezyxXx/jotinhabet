import { describe, it, expect } from 'vitest';
import { BetssonScraper } from '../../src/scraping/casa_betsson';
import { normalizarMercado } from '../../src/arbitrage/markets';
import { mercadoPermitido } from '../../src/arbitrage/regras';

/**
 * Testes do parser da Betsson (`/api/sb/v1/widgets/events-table/v2`).
 *
 * O feed entrega três listas IRMÃS (events/markets/selections) ligadas por id, e o que
 * pode dar prejuízo aqui é silencioso: sinal do handicap invertido, mercado de 3 vias
 * saindo como par de 2 vias, e vencedor de tempo normal cruzando com moneyline incl. OT.
 * Cada um desses tem caso próprio abaixo.
 */

const FUTURO = new Date(Date.now() + 6 * 3600_000).toISOString();
const PASSADO = new Date(Date.now() - 3600_000).toISOString();

const CID = { FUTEBOL: 1, BASQUETE: 4, VOLEI: 9, TENIS: 11, BEISEBOL: 19 };

/** Evento com dois participantes (mandante = sortOrder 1). */
const evento = (over: Record<string, any> = {}) => ({
  id: 'f-EV1',
  categoryId: '1',
  competitionId: '8221',
  slug: 'futebol/brasil/serie-a/flamengo-palmeiras',
  startDate: FUTURO,
  participants: [
    { label: 'Flamengo', id: '1', sortOrder: 1, side: 1 },
    { label: 'Palmeiras', id: '2', sortOrder: 2, side: 2 },
  ],
  ...over,
});

const mercado = (marketTemplateId: string, over: Record<string, any> = {}) => ({
  id: `m-f-EV1-${marketTemplateId}${over.lineValue ? `-${over.lineValue}` : ''}`,
  eventId: 'f-EV1',
  marketTemplateId,
  lineValue: '',
  lineValueRaw: 0,
  status: 'Open',
  ...over,
});

const selecao = (marketId: string, selectionTemplateId: string, odds: number, over: Record<string, any> = {}) => ({
  marketId,
  selectionTemplateId,
  odds,
  status: 'Open',
  label: selectionTemplateId,
  ...over,
});

/** Roda o parser sobre uma página sintética e devolve as ScrapedOdd. */
function parse(
  cid: number,
  markets: any[],
  selections: any[],
  events: any[] = [evento()],
  opts?: { incluirAoVivo?: boolean }
) {
  const out: any[] = [];
  new BetssonScraper(opts).parsePagina({ events, markets, selections }, cid, out);
  return out;
}

const porMercado = (odds: any[]) => Object.fromEntries(odds.map((o) => [o.mercado, o]));

// ─────────────────────────────────────────────────────────────── handicap (o sinal)

describe('Betsson — handicap 2 vias', () => {
  /**
   * `lineValue` é o par "casa - visitante" e NÃO serve para conta; `lineValueRaw` é a
   * linha já assinada do MANDANTE. Se alguém trocar um pelo outro (ou inverter o sinal),
   * o motor pareia -1.5 com +1.5 de outra casa e a "surebet" perde nos dois lados.
   */
  it('lineValueRaw NEGATIVO = mandante favorito: linha e rótulos seguem o mandante', () => {
    const m = mercado('RLS', { lineValue: '0 - 1.5', lineValueRaw: -1.5 });
    const odds = parse(CID.BEISEBOL, [m], [
      selecao(m.id, 'HANDICAPHOME', 2.22),
      selecao(m.id, 'HANDICAPAWAY', 1.63),
    ]);
    expect(odds).toHaveLength(1);
    expect(odds[0].linha).toBe(-1.5);
    expect(odds[0].opcaoA).toBe('Flamengo (-1.5)');
    expect(odds[0].opcaoB).toBe('Palmeiras (+1.5)');
    expect(odds[0].oddA).toBe(2.22);
    expect(odds[0].oddB).toBe(1.63);
    expect(normalizarMercado(odds[0].mercado)).toBe('HANDICAP_GERAL_FT');
  });

  it('lineValueRaw POSITIVO = mandante azarão: sinais invertidos', () => {
    const m = mercado('RLS', { lineValue: '1.5 - 0', lineValueRaw: 1.5 });
    const odds = parse(CID.BEISEBOL, [m], [
      selecao(m.id, 'HANDICAPHOME', 1.22),
      selecao(m.id, 'HANDICAPAWAY', 3.8),
    ]);
    expect(odds[0].linha).toBe(1.5);
    expect(odds[0].opcaoA).toBe('Flamengo (+1.5)');
    expect(odds[0].opcaoB).toBe('Palmeiras (-1.5)');
  });

  it('handicap de 3 VIAS (tem HANDICAPDRAW) é DESCARTADO — o empate ficaria descoberto', () => {
    const m = mercado('M3WHCP', { lineValue: '0 - 1', lineValueRaw: -1 });
    const odds = parse(CID.FUTEBOL, [m], [
      selecao(m.id, 'HANDICAPHOME', 6.8),
      selecao(m.id, 'HANDICAPDRAW', 3.9),
      selecao(m.id, 'HANDICAPAWAY', 1.4),
    ]);
    expect(odds).toHaveLength(0);
  });

  it('linha INTEIRA de handicap é descartada (push devolve as duas pernas)', () => {
    const m = mercado('RLS', { lineValue: '0 - 1', lineValueRaw: -1 });
    const odds = parse(CID.BEISEBOL, [m], [
      selecao(m.id, 'HANDICAPHOME', 2.1),
      selecao(m.id, 'HANDICAPAWAY', 1.8),
    ]);
    expect(odds).toHaveLength(0);
  });

  it('vôlei: MSH sai como Handicap de SETS, que nunca colide com handicap de pontos', () => {
    const m = mercado('MSH', { lineValue: '0 - 2.5', lineValueRaw: -2.5 });
    const odds = parse(CID.VOLEI, [m], [
      selecao(m.id, 'HANDICAPHOME', 1.75),
      selecao(m.id, 'HANDICAPAWAY', 1.85),
    ]);
    expect(odds[0].mercado).toBe('Handicap de Sets');
    expect(normalizarMercado(odds[0].mercado)).toBe('HANDICAP_SETS_FT');
    expect(normalizarMercado(odds[0].mercado)).not.toBe(normalizarMercado('Handicap de Pontos'));
  });
});

// ─────────────────────────────────────────────────────────────── totais

describe('Betsson — totais', () => {
  it('over/under saem com os rótulos canônicos do projeto (Mais de / Menos de)', () => {
    const m = mercado('MTG2W', { lineValue: '2.5', lineValueRaw: 2.5 });
    const odds = parse(CID.FUTEBOL, [m], [
      selecao(m.id, 'OVER', 2.32, { label: 'Acima de 2.5' }),
      selecao(m.id, 'UNDER', 1.52, { label: 'Abaixo de 2.5' }),
    ]);
    expect(odds).toHaveLength(1);
    expect(odds[0].mercado).toBe('Total de Gols');
    expect(odds[0].linha).toBe(2.5);
    // O feed diz "Acima/Abaixo"; o projeto casa por "Mais de/Menos de".
    expect(odds[0].opcaoA).toBe('Mais de 2.5');
    expect(odds[0].opcaoB).toBe('Menos de 2.5');
    expect(normalizarMercado(odds[0].mercado)).toBe('TOTAIS_GOLS_FT');
  });

  it('total do 1º TEMPO leva o período no rótulo (não cruza com o total do jogo)', () => {
    const m = mercado('1HTG', { lineValue: '0.5', lineValueRaw: 0.5 });
    const odds = parse(CID.FUTEBOL, [m], [
      selecao(m.id, 'OVER', 1.77),
      selecao(m.id, 'UNDER', 1.96),
    ]);
    expect(normalizarMercado(odds[0].mercado)).toBe('TOTAIS_GOLS_1T');
    expect(normalizarMercado(odds[0].mercado)).not.toBe('TOTAIS_GOLS_FT');
  });

  it('MTG2W25 é a VITRINE do MTG2W@2.5 (mesmo market.id) — não gera oferta em dobro', () => {
    // Os dois entries apontam para o MESMO id e as MESMAS seleções, como no feed real.
    const id = 'm-f-EV1-MTG2W-2.5';
    const base = { id, eventId: 'f-EV1', lineValue: '2.5', lineValueRaw: 2.5, status: 'Open' };
    const odds = parse(
      CID.FUTEBOL,
      [{ ...base, marketTemplateId: 'MTG2W' }, { ...base, marketTemplateId: 'MTG2W25' }],
      [selecao(id, 'OVER', 3.4), selecao(id, 'UNDER', 1.28)]
    );
    // O parser emite os dois; o dedupe da coleta é que colapsa. Aqui garantimos que são
    // IDÊNTICOS (mesma chave de dedupe), e não duas ofertas divergentes.
    expect(odds).toHaveLength(2);
    expect(odds[0].mercado).toBe(odds[1].mercado);
    expect(odds[0].linha).toBe(odds[1].linha);
    expect(odds[0].oddA).toBe(odds[1].oddA);
  });

  it('tênis: total de games e handicap de games usam o vocabulário das casas já integradas', () => {
    const t = mercado('MTG2WP', { lineValue: '19.5', lineValueRaw: 19.5 });
    const h = mercado('M2WHCP', { lineValue: '5.5 - 0', lineValueRaw: 5.5 });
    const odds = parse(
      CID.TENIS,
      [t, h],
      [
        selecao(t.id, 'OVER', 1.82), selecao(t.id, 'UNDER', 1.82),
        selecao(h.id, 'HANDICAPHOME', 2.6), selecao(h.id, 'HANDICAPAWAY', 1.4),
      ]
    );
    const m = porMercado(odds);
    expect(normalizarMercado(m['Total de Games'].mercado)).toBe('TOTAIS_GAMES_FT');
    expect(normalizarMercado(m['Handicap'].mercado)).toBe('HANDICAP_GERAL_FT');
  });
});

// ─────────────────────────────────────────────────────────────── vencedor / BTTS

describe('Betsson — vencedor e BTTS', () => {
  it('vencedor 2 vias (moneyline incl. OT) sai como Resultado Final com os times', () => {
    const m = mercado('MW2W');
    const odds = parse(CID.BASQUETE, [m], [
      selecao(m.id, 'HOME', 1.5),
      selecao(m.id, 'AWAY', 2.19),
    ]);
    expect(odds).toHaveLength(1);
    expect(odds[0].mercado).toBe('Resultado Final');
    expect(odds[0].opcaoA).toBe('Flamengo');
    expect(odds[0].opcaoB).toBe('Palmeiras');
    expect(odds[0].linha).toBeUndefined();
  });

  it('vencedor com EMPATE (3 vias) é descartado, mesmo pedindo só HOME×AWAY', () => {
    const m = mercado('MW2W');
    const odds = parse(CID.BASQUETE, [m], [
      selecao(m.id, 'HOME', 2.4),
      selecao(m.id, 'DRAW', 3.1),
      selecao(m.id, 'AWAY', 2.9),
    ]);
    expect(odds).toHaveLength(0);
  });

  /**
   * A armadilha central do basquete: `MW3W` é "Excluindo tempo extra" e `MW2W` é
   * "Incluindo OT". Emitir os dois como 'Resultado Final' cruzaria tempo normal com
   * incl. OT — o que a Diretriz de basquete proíbe.
   */
  it('basquete: MW3W (excl. prorrogação) NUNCA é emitido', () => {
    const m3 = mercado('MW3W');
    const m2 = mercado('MW2W', { id: 'm-f-EV1-MW2W' });
    const odds = parse(
      CID.BASQUETE,
      [m3, m2],
      [
        selecao(m3.id, 'HOME', 1.6), selecao(m3.id, 'AWAY', 2.3),
        selecao(m2.id, 'HOME', 1.5), selecao(m2.id, 'AWAY', 2.19),
      ]
    );
    expect(odds).toHaveLength(1);
    expect(odds[0].oddA).toBe(1.5); // veio do MW2W, não do MW3W
  });

  it('tênis: SW ("Vencedor do set N") não é emitido — a lineValue ali é o número do set', () => {
    const m = mercado('SW', { lineValue: '2', lineValueRaw: 2 });
    const odds = parse(CID.TENIS, [m], [
      selecao(m.id, 'HOME', 1.9),
      selecao(m.id, 'AWAY', 1.9),
    ]);
    expect(odds).toHaveLength(0);
  });

  it('dupla chance (DC) não é emitida — nenhuma das 3 saídas é complemento da outra', () => {
    const m = mercado('DC');
    const odds = parse(CID.FUTEBOL, [m], [
      selecao(m.id, 'HOMEORDRAW', 1.33),
      selecao(m.id, 'HOMEORAWAY', 1.42),
      selecao(m.id, 'DRAWORAWAY', 1.38),
    ]);
    expect(odds).toHaveLength(0);
  });

  it('BTTS sai como Sim/Não', () => {
    const m = mercado('BTTS');
    const odds = parse(CID.FUTEBOL, [m], [
      selecao(m.id, 'YES', 2.05, { label: 'Sim' }),
      selecao(m.id, 'NO', 1.68, { label: 'Não' }),
    ]);
    expect(odds[0].mercado).toBe('Ambas equipes marcam');
    expect(odds[0].opcaoA).toBe('Sim');
    expect(odds[0].opcaoB).toBe('Não');
    expect(normalizarMercado(odds[0].mercado)).toBe('AMBAS_MARCAM_FT');
  });
});

// ─────────────────────────────────────────────────────────────── oferta viva / evento

describe('Betsson — filtros de oferta viva', () => {
  it("mercado em 'Hold' é ignorado", () => {
    const m = mercado('MTG2W', { lineValue: '2.5', lineValueRaw: 2.5, status: 'Hold' });
    const odds = parse(CID.FUTEBOL, [m], [selecao(m.id, 'OVER', 2.1), selecao(m.id, 'UNDER', 1.7)]);
    expect(odds).toHaveLength(0);
  });

  it("seleção 'Suspended' derruba o par (não há dois lados para arbitrar)", () => {
    const m = mercado('MTG2W', { lineValue: '2.5', lineValueRaw: 2.5 });
    const odds = parse(CID.FUTEBOL, [m], [
      selecao(m.id, 'OVER', 2.1),
      selecao(m.id, 'UNDER', 1.7, { status: 'Suspended' }),
    ]);
    expect(odds).toHaveLength(0);
  });

  /** O feed publica odd 1.00 em seleção 'Open' (visto em "Camboja ou Empate"). */
  it('odd 1.00 não é oferta real', () => {
    const m = mercado('MTG2W', { lineValue: '2.5', lineValueRaw: 2.5 });
    const odds = parse(CID.FUTEBOL, [m], [
      selecao(m.id, 'OVER', 1),
      selecao(m.id, 'UNDER', 1.7),
    ]);
    expect(odds).toHaveLength(0);
  });

  it('mercado não mapeado PARA AQUELE ESPORTE é ignorado (MTP só existe no vôlei)', () => {
    const m = mercado('MTP', { lineValue: '137.5', lineValueRaw: 137.5 });
    const sels = [selecao(m.id, 'OVER', 1.8), selecao(m.id, 'UNDER', 1.8)];
    expect(parse(CID.FUTEBOL, [m], sels)).toHaveLength(0);
    expect(parse(CID.VOLEI, [m], sels)).toHaveLength(1);
  });
});

describe('Betsson — identidade do evento', () => {
  it('mandante vem do sortOrder 1, mesmo com participants fora de ordem', () => {
    const ev = evento({
      participants: [
        { label: 'Palmeiras', id: '2', sortOrder: 2, side: 2 },
        { label: 'Flamengo', id: '1', sortOrder: 1, side: 1 },
      ],
    });
    const m = mercado('MW2W');
    const odds = parse(CID.BASQUETE, [m], [selecao(m.id, 'HOME', 1.5), selecao(m.id, 'AWAY', 2.19)], [ev]);
    expect(odds[0].evento).toBe('Flamengo vs Palmeiras');
    expect(odds[0].opcaoA).toBe('Flamengo');
  });

  it('evento sem 2 participantes (outright) é ignorado', () => {
    const ev = evento({ participants: [{ label: 'Campeão', id: '1', sortOrder: 1 }] });
    const m = mercado('MW2W');
    const odds = parse(CID.BASQUETE, [m], [selecao(m.id, 'HOME', 1.5), selecao(m.id, 'AWAY', 2.19)], [ev]);
    expect(odds).toHaveLength(0);
  });

  it('partida JÁ INICIADA sai fora no pré-jogo e entra com incluirAoVivo', () => {
    const ev = evento({ startDate: PASSADO });
    const m = mercado('MTG2W', { lineValue: '2.5', lineValueRaw: 2.5 });
    const sels = [selecao(m.id, 'OVER', 2.1), selecao(m.id, 'UNDER', 1.7)];
    expect(parse(CID.FUTEBOL, [m], sels, [ev])).toHaveLength(0);
    expect(parse(CID.FUTEBOL, [m], sels, [ev], { incluirAoVivo: true })).toHaveLength(1);
  });

  it('url do evento é montada a partir do slug', () => {
    const m = mercado('MTG2W', { lineValue: '2.5', lineValueRaw: 2.5 });
    const odds = parse(CID.FUTEBOL, [m], [selecao(m.id, 'OVER', 2.1), selecao(m.id, 'UNDER', 1.7)]);
    expect(odds[0].url).toBe('https://www.betsson.bet.br/apostas-esportivas/futebol/brasil/serie-a/flamengo-palmeiras');
    expect(odds[0].dataHora).toBe(FUTURO);
  });
});

describe('Betsson — conformidade com as Diretrizes', () => {
  it('nenhum mercado coletado no FUTEBOL é Resultado Final (proibido por Diretriz)', () => {
    const mtg = mercado('MTG2W', { lineValue: '2.5', lineValueRaw: 2.5 });
    const btts = mercado('BTTS', { id: 'm-f-EV1-BTTS' });
    const h1 = mercado('1HTG', { id: 'm-f-EV1-1HTG-0.5', lineValue: '0.5', lineValueRaw: 0.5 });
    const odds = parse(
      CID.FUTEBOL,
      [mtg, btts, h1],
      [
        selecao(mtg.id, 'OVER', 2.32), selecao(mtg.id, 'UNDER', 1.52),
        selecao(btts.id, 'YES', 2.05), selecao(btts.id, 'NO', 1.68),
        selecao(h1.id, 'OVER', 1.77), selecao(h1.id, 'UNDER', 1.96),
      ]
    );
    expect(odds).toHaveLength(3);
    for (const o of odds) {
      expect(normalizarMercado(o.mercado).startsWith('RESULTADO_FINAL')).toBe(false);
      expect(mercadoPermitido('Futebol', o.mercado)).toBe(true);
    }
  });

  it('todo mercado emitido tem canônico conhecido (nunca DESCONHECIDO)', () => {
    const casos: Array<[number, any, any[]]> = [
      [CID.FUTEBOL, mercado('MTG2W', { lineValue: '2.5', lineValueRaw: 2.5 }), ['OVER', 'UNDER']],
      [CID.FUTEBOL, mercado('BTTS'), ['YES', 'NO']],
      [CID.FUTEBOL, mercado('1HTG', { lineValue: '0.5', lineValueRaw: 0.5 }), ['OVER', 'UNDER']],
      [CID.BASQUETE, mercado('MW2W'), ['HOME', 'AWAY']],
      [CID.BASQUETE, mercado('PTSOUROLMID', { lineValue: '135.5', lineValueRaw: 135.5 }), ['OVER', 'UNDER']],
      [CID.BASQUETE, mercado('2WHCPROLMID', { lineValue: '0 - 3.5', lineValueRaw: -3.5 }), ['HANDICAPHOME', 'HANDICAPAWAY']],
      [CID.TENIS, mercado('MW2W'), ['HOME', 'AWAY']],
      [CID.TENIS, mercado('MTG2WP', { lineValue: '19.5', lineValueRaw: 19.5 }), ['OVER', 'UNDER']],
      [CID.TENIS, mercado('M2WHCP', { lineValue: '0 - 5.5', lineValueRaw: -5.5 }), ['HANDICAPHOME', 'HANDICAPAWAY']],
      [CID.VOLEI, mercado('MTP', { lineValue: '137.5', lineValueRaw: 137.5 }), ['OVER', 'UNDER']],
      [CID.VOLEI, mercado('MSH', { lineValue: '0 - 2.5', lineValueRaw: -2.5 }), ['HANDICAPHOME', 'HANDICAPAWAY']],
      [CID.BEISEBOL, mercado('ML'), ['HOME', 'AWAY']],
      [CID.BEISEBOL, mercado('TR', { lineValue: '8.5', lineValueRaw: 8.5 }), ['OVER', 'UNDER']],
      [CID.BEISEBOL, mercado('RLS', { lineValue: '0 - 1.5', lineValueRaw: -1.5 }), ['HANDICAPHOME', 'HANDICAPAWAY']],
    ];
    for (const [cid, m, papeis] of casos) {
      const odds = parse(cid, [m], papeis.map((p, i) => selecao(m.id, p, 1.8 + i * 0.1)));
      expect(odds, `${m.marketTemplateId} em cid=${cid} não gerou oferta`).toHaveLength(1);
      expect(normalizarMercado(odds[0].mercado), `${m.marketTemplateId} → ${odds[0].mercado}`).not.toBe('DESCONHECIDO');
    }
  });
});
