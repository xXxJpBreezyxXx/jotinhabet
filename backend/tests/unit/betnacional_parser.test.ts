import { describe, it, expect } from 'vitest';
import { BetnacionalScraper } from '../../src/scraping/casa_betnacional';
import { normalizarMercado } from '../../src/arbitrage/markets';
import { splitEvento, parseKickoff } from '../../src/arbitrage/matcher';

const meta = {
  eid: 915870497,
  home: 'Atlético-MG',
  away: 'Bahia',
  dataHora: new Date(Date.now() + 3600_000).toISOString(),
  esporte: 'Futebol',
};

// Linhas de odds no shape REAL do /api/event-odds/{eid}/grouped (odds[]).
const o = (p: Partial<any>) => ({ market_display_status: 1, selection_display_status: 1, ...p });

// Total de Gols FT: code "Total" (sem pipes), specifier VÍRGULA "total=2,5".
const total25 = [
  o({ market_id: 999167, market_code: 'Total', outcome_name: 'Mais de 2,5 gols', odd: '1.850', specifier: 'total=2,5' }),
  o({ market_id: 999167, market_code: 'Total', outcome_name: 'Menos de 2,5 gols', odd: '1.900', specifier: 'total=2,5' }),
];
const total15 = [
  o({ market_id: 999166, market_code: 'Total', outcome_name: 'Mais de 1,5 gols', odd: '1.250', specifier: 'total=1,5' }),
  o({ market_id: 999166, market_code: 'Total', outcome_name: 'Menos de 1,5 gols', odd: '3.600', specifier: 'total=1,5' }),
];
// BTTS FT: code pipe-wrapped "|Both Teams To Score|", e market_display_status=0
// (flag de sub-aba, NÃO suspensão) — precisa ser emitido mesmo assim.
const btts = [
  o({ market_id: 999273, market_code: '|Both Teams To Score|', outcome_name: 'Sim', odd: '1.727', market_display_status: 0 }),
  o({ market_id: 999273, market_code: '|Both Teams To Score|', outcome_name: 'Não', odd: '2.050', market_display_status: 0 }),
];
// DNB FT: code "|Draw No Bet|", outcomes = nomes dos times.
const dnb = [
  o({ market_id: 999134, market_code: '|Draw No Bet|', outcome_name: 'Atlético-MG', odd: '1.500' }),
  o({ market_id: 999134, market_code: '|Draw No Bet|', outcome_name: 'Bahia', odd: '2.400' }),
];
// 1X2 — PROIBIDO no futebol; nunca deve sair.
const wdw = [
  o({ market_id: 999133, market_code: '|Win-Draw-Win|', outcome_name: 'Atlético-MG', odd: '2.100' }),
  o({ market_id: 999133, market_code: '|Win-Draw-Win|', outcome_name: 'Empate', odd: '3.600' }),
  o({ market_id: 999133, market_code: '|Win-Draw-Win|', outcome_name: 'Bahia', odd: '3.400' }),
];

describe('BetnacionalScraper.parseGrouped', () => {
  const s = new BetnacionalScraper();

  it('extrai Total de Gols (over/under) com linha do specifier vírgula e rótulos canônicos', () => {
    const odds = s.parseGrouped({ odds: [...total25, ...total15] }, meta);
    expect(odds.length).toBe(2);
    const l25 = odds.find((x) => x.linha === 2.5)!;
    expect(l25.evento).toBe('Atlético-MG vs Bahia');
    expect(l25.mercado).toBe('Total de Gols');
    expect(l25.opcaoA).toBe('Mais de 2.5');
    expect(l25.opcaoB).toBe('Menos de 2.5');
    expect(l25.oddA).toBe(1.85);
    expect(l25.oddB).toBe(1.9);
    expect(normalizarMercado(l25.mercado)).toBe('TOTAIS_GOLS_FT');
  });

  it('extrai BTTS mesmo com market_display_status=0 (é sub-aba, não suspensão)', () => {
    const odds = s.parseGrouped({ odds: btts }, meta);
    expect(odds.length).toBe(1);
    expect(odds[0].mercado).toBe('Ambas Equipes Marcam');
    expect(odds[0].opcaoA).toBe('Sim');
    expect(odds[0].oddA).toBe(1.727);
    expect(odds[0].oddB).toBe(2.05);
    expect(normalizarMercado(odds[0].mercado)).toBe('AMBAS_MARCAM_FT');
  });

  it('extrai DNB mapeando outcomes aos times (home=opcaoA) → DNB_FT', () => {
    const odds = s.parseGrouped({ odds: dnb }, meta);
    expect(odds.length).toBe(1);
    expect(odds[0].mercado).toBe('Empate anula a aposta');
    expect(odds[0].opcaoA).toBe('Atlético-MG');
    expect(odds[0].opcaoB).toBe('Bahia');
    expect(odds[0].oddA).toBe(1.5);
    expect(odds[0].oddB).toBe(2.4);
    expect(normalizarMercado(odds[0].mercado)).toBe('DNB_FT');
  });

  it('NUNCA emite 1X2 (Win-Draw-Win) — Diretrizes proíbem no futebol', () => {
    const odds = s.parseGrouped({ odds: [...wdw, ...total25] }, meta);
    expect(odds.every((x) => !normalizarMercado(x.mercado).startsWith('RESULTADO'))).toBe(true);
    expect(odds.length).toBe(1);
    expect(odds[0].mercado).toBe('Total de Gols');
  });

  it('exclui Total do 1º tempo (code TOTAL_1ST_HALF) do Total de jogo completo', () => {
    const total1t = [
      o({ market_id: 999266, market_code: 'TOTAL_1ST_HALF', outcome_name: 'Mais de 2,5 gols no 1º tempo', odd: '7.500', specifier: 'total=2,5' }),
      o({ market_id: 999266, market_code: 'TOTAL_1ST_HALF', outcome_name: 'Menos de 2,5 gols no 1º tempo', odd: '1.090', specifier: 'total=2,5' }),
    ];
    const odds = s.parseGrouped({ odds: [...total25, ...total1t] }, meta);
    expect(odds.length).toBe(1);
    expect(odds[0].linha).toBe(2.5);
  });

  it('exclui BTTS de 1º/2º tempo do BTTS de jogo completo', () => {
    const bttsHt = [
      o({ market_id: 9991786, market_code: '|Both Teams to Score in the First Half|', outcome_name: 'Sim', odd: '4.500' }),
      o({ market_id: 9991786, market_code: '|Both Teams to Score in the First Half|', outcome_name: 'Não', odd: '1.180' }),
    ];
    const odds = s.parseGrouped({ odds: bttsHt }, meta);
    expect(odds.length).toBe(0);
  });

  it('descarta seleção fechada (selection_display_status=0)', () => {
    const fechado = total25.map((x) => ({ ...x, selection_display_status: 0 }));
    expect(s.parseGrouped({ odds: fechado }, meta).length).toBe(0);
  });

  it('só emite a linha de total quando há over E under', () => {
    expect(s.parseGrouped({ odds: [total25[0]] }, meta).length).toBe(0);
  });

  it('pareia Total pela LINHA mesmo se linhas diferentes vierem no MESMO market_id', () => {
    // Cenário adversarial: over 2,5 e under 3,5 sob o mesmo id — NÃO podem parear
    // (surebet fabricada). Com over 2,5+under 2,5 e over 3,5+under 3,5 → 2 linhas certas.
    const misto = [
      o({ market_id: 999167, market_code: 'Total', outcome_name: 'Mais de 2,5 gols', odd: '1.850', specifier: 'total=2,5' }),
      o({ market_id: 999167, market_code: 'Total', outcome_name: 'Menos de 3,5 gols', odd: '1.286', specifier: 'total=3,5' }),
    ];
    expect(s.parseGrouped({ odds: misto }, meta).length).toBe(0); // cada linha incompleta

    const completo = [
      o({ market_id: 999167, market_code: 'Total', outcome_name: 'Mais de 2,5 gols', odd: '1.850', specifier: 'total=2,5' }),
      o({ market_id: 999167, market_code: 'Total', outcome_name: 'Menos de 2,5 gols', odd: '1.900', specifier: 'total=2,5' }),
      o({ market_id: 999167, market_code: 'Total', outcome_name: 'Mais de 3,5 gols', odd: '3.300', specifier: 'total=3,5' }),
      o({ market_id: 999167, market_code: 'Total', outcome_name: 'Menos de 3,5 gols', odd: '1.286', specifier: 'total=3,5' }),
    ];
    const odds = s.parseGrouped({ odds: completo }, meta);
    expect(odds.length).toBe(2);
    expect(odds.find((x) => x.linha === 2.5)!.oddA).toBe(1.85);
    expect(odds.find((x) => x.linha === 3.5)!.oddA).toBe(3.3);
    expect(odds.find((x) => x.linha === 3.5)!.oddB).toBe(1.286);
  });

  it('DNB distingue dérbi estadual (Atlético-MG × Atlético-GO) — não derruba por fuzzy', () => {
    const metaDerby = { ...meta, home: 'Atlético-MG', away: 'Atlético-GO' };
    const dnbDerby = [
      o({ market_id: 999134, market_code: '|Draw No Bet|', outcome_name: 'Atlético-MG', odd: '1.800' }),
      o({ market_id: 999134, market_code: '|Draw No Bet|', outcome_name: 'Atlético-GO', odd: '2.000' }),
    ];
    for (const rows of [dnbDerby, [dnbDerby[1], dnbDerby[0]]]) { // ordem não garantida no feed
      const odds = s.parseGrouped({ odds: rows }, metaDerby);
      expect(odds.length).toBe(1);
      expect(odds[0].opcaoA).toBe('Atlético-MG');
      expect(odds[0].oddA).toBe(1.8); // home
      expect(odds[0].oddB).toBe(2.0); // away — NÃO some nem troca de lado
    }
  });

  it('DNB por nome exato normalizado (acento/pontuação) sem fuzzy de quase-homônimo', () => {
    const metaAcento = { ...meta, home: 'Atletico-MG', away: 'Bahia' }; // sem acento na LISTA
    const dnbAcento = [
      o({ market_id: 999134, market_code: '|Draw No Bet|', outcome_name: 'Atlético-MG', odd: '1.500' }), // com acento no GROUPED
      o({ market_id: 999134, market_code: '|Draw No Bet|', outcome_name: 'Bahia', odd: '2.400' }),
    ];
    const odds = s.parseGrouped({ odds: dnbAcento }, metaAcento);
    expect(odds.length).toBe(1);
    expect(odds[0].oddA).toBe(1.5);
    expect(odds[0].oddB).toBe(2.4);
  });

  it('descarta linha inteira (não arbitrável em 2 pernas)', () => {
    const inteira = [
      o({ market_id: 999999, market_code: 'Total', outcome_name: 'Mais de 2 gols', odd: '2.000', specifier: 'total=2' }),
      o({ market_id: 999999, market_code: 'Total', outcome_name: 'Menos de 2 gols', odd: '1.800', specifier: 'total=2' }),
    ];
    expect(s.parseGrouped({ odds: inteira }, meta).length).toBe(0);
  });

  it('descarta odd <= 1', () => {
    const ruim = [
      o({ market_id: 999167, market_code: 'Total', outcome_name: 'Mais de 2,5 gols', odd: '1.000', specifier: 'total=2,5' }),
      o({ market_id: 999167, market_code: 'Total', outcome_name: 'Menos de 2,5 gols', odd: '0.950', specifier: 'total=2,5' }),
    ];
    expect(s.parseGrouped({ odds: ruim }, meta).length).toBe(0);
  });

  it('evento e dataHora sempre no formato que o matcher entende', () => {
    const odds = s.parseGrouped({ odds: [...total25, ...btts, ...dnb] }, meta);
    expect(odds.length).toBe(3);
    expect(odds.every((x) => splitEvento(x.evento) !== null)).toBe(true);
    expect(odds.every((x) => parseKickoff(x.dataHora) !== null)).toBe(true);
  });
});
