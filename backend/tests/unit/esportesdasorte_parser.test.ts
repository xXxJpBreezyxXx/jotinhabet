import { describe, it, expect } from 'vitest';
import { EsportesDaSorteScraper } from '../../src/scraping/casa_esportesdasorte';
import { normalizarMercado } from '../../src/arbitrage/markets';
import { splitEvento, parseKickoff } from '../../src/arbitrage/matcher';

const FUTURO = Date.now() + 3600_000;

// Monta a árvore data[st].cs[].sns[].fs[] como o league-card devolve.
function sports(fixture: any) {
  return [{ stId: 152, cs: [{ sns: [{ sId: 1, fs: [fixture] }] }] }];
}

const fixtureBase = {
  fId: 1, fsd: FUTURO, hcN: 'Flamengo', acN: 'Palmeiras',
  lSt: false, vld: true, frz: false, btgs: [] as any[],
};

const btgResultado = {
  btgN: 'Resultado',
  fos: [
    { btN: 'Casa', hSh: 'Flamengo', pSh: 'Home', hO: 2.1, valid: true },
    { btN: 'Empate', hSh: 'Empate', pSh: 'Empate', hO: 3.3, valid: true },
    { btN: 'Fora', hSh: 'Palmeiras', pSh: 'Away', hO: 3.5, valid: true },
  ],
};
const btgTotal = {
  btgN: 'Total Gols',
  fos: [
    { btN: 'Total', hSh: 'Mais de 2.5', pSh: 'Over 2.5', sv: '2.5', hO: 1.9, valid: true },
    { btN: 'Total', hSh: 'Menos de 2.5', pSh: 'Under 2.5', sv: '2.5', hO: 1.95, valid: true },
    { btN: 'Total', hSh: 'Mais de 1.5', pSh: 'Over 1.5', sv: '1.5', hO: 1.2, valid: true },
    { btN: 'Total', hSh: 'Menos de 1.5', pSh: 'Under 1.5', sv: '1.5', hO: 4.5, valid: true },
  ],
};
const btgBtts = {
  btgN: 'Ambas equipes marcam',
  fos: [
    { btN: 'Sim', hSh: 'Sim', pSh: 'Sim', hO: 1.85, valid: true },
    { btN: 'Não', hSh: 'Não', pSh: 'no', hO: 1.9, valid: true },
  ],
};

describe('EsportesDaSorteScraper.parseSports', () => {
  const s = new EsportesDaSorteScraper();
  const alvo = new Set([152]);

  it('extrai Total de Gols (over/under) com linha e rótulos canônicos', () => {
    const odds = s.parseSports(sports({ ...fixtureBase, btgs: [btgTotal] }), alvo);
    expect(odds.length).toBe(2); // duas linhas: 2.5 e 1.5
    const l25 = odds.find((o) => o.linha === 2.5)!;
    expect(l25.evento).toBe('Flamengo vs Palmeiras');
    expect(l25.mercado).toBe('Total de Gols');
    expect(l25.opcaoA).toBe('Mais de 2.5');
    expect(l25.opcaoB).toBe('Menos de 2.5');
    expect(l25.oddA).toBe(1.9);
    expect(l25.oddB).toBe(1.95);
    expect(normalizarMercado(l25.mercado)).toBe('TOTAIS_GOLS_FT');
  });

  it('extrai BTTS (Sim/Não) normalizando para AMBAS_MARCAM_FT', () => {
    const odds = s.parseSports(sports({ ...fixtureBase, btgs: [btgBtts] }), alvo);
    expect(odds.length).toBe(1);
    expect(odds[0].mercado).toBe('Ambas Equipes Marcam');
    expect(odds[0].opcaoA).toBe('Sim');
    expect(odds[0].oddA).toBe(1.85);
    expect(odds[0].oddB).toBe(1.9);
    expect(normalizarMercado(odds[0].mercado)).toBe('AMBAS_MARCAM_FT');
  });

  it('NUNCA emite 1X2 (Resultado) — Diretrizes proíbem no futebol', () => {
    const odds = s.parseSports(sports({ ...fixtureBase, btgs: [btgResultado, btgTotal] }), alvo);
    expect(odds.every((o) => !normalizarMercado(o.mercado).startsWith('RESULTADO'))).toBe(true);
    expect(odds.every((o) => normalizarMercado(o.mercado) === 'TOTAIS_GOLS_FT')).toBe(true);
  });

  it('descarta ao vivo, congelado, inválido e já iniciado', () => {
    expect(s.parseSports(sports({ ...fixtureBase, lSt: true, btgs: [btgTotal] }), alvo).length).toBe(0);
    expect(s.parseSports(sports({ ...fixtureBase, frz: true, btgs: [btgTotal] }), alvo).length).toBe(0);
    expect(s.parseSports(sports({ ...fixtureBase, vld: false, btgs: [btgTotal] }), alvo).length).toBe(0);
    expect(s.parseSports(sports({ ...fixtureBase, fsd: Date.now() - 1000, btgs: [btgTotal] }), alvo).length).toBe(0);
  });

  it('só emite linha de total quando há over E under', () => {
    const soOver = { btgN: 'Total Gols', fos: [{ btN: 'Total', pSh: 'Over 2.5', sv: '2.5', hO: 1.9, valid: true }] };
    expect(s.parseSports(sports({ ...fixtureBase, btgs: [soOver] }), alvo).length).toBe(0);
  });

  it('evento e dataHora sempre no formato que o matcher entende', () => {
    const odds = s.parseSports(sports({ ...fixtureBase, btgs: [btgTotal] }), alvo);
    expect(odds.every((o) => splitEvento(o.evento) !== null)).toBe(true);
    expect(odds.every((o) => parseKickoff(o.dataHora) !== null)).toBe(true);
  });
});
