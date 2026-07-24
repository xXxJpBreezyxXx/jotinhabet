import { describe, it, expect, afterEach, vi } from 'vitest';
import { setBrowserOdds, getBrowserOddsFresh, _limparBrowserOddsCache } from '../../src/scraping/browserOddsCache';
import { ScrapedOdd } from '../../src/scraping/scraper_base';

const odd: ScrapedOdd = {
  esporte: 'Futebol', evento: 'A vs B', dataHora: '2026-07-20T20:00:00Z',
  mercado: 'Resultado Final', opcaoA: 'A', opcaoB: 'B', oddA: 2, oddB: 2,
};

describe('browserOddsCache', () => {
  afterEach(() => { vi.useRealTimers(); _limparBrowserOddsCache(); });

  it('devolve entradas dentro da idade e descarta as velhas', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    setBrowserOdds('Betano', [odd]);

    expect(getBrowserOddsFresh(60_000).find((e) => e.nome === 'Betano')).toBeTruthy();

    vi.setSystemTime(new Date('2026-07-20T00:02:00Z')); // +2min
    expect(getBrowserOddsFresh(60_000).find((e) => e.nome === 'Betano')).toBeFalsy();   // 2min > 1min
    expect(getBrowserOddsFresh(300_000).find((e) => e.nome === 'Betano')).toBeTruthy(); // 2min < 5min
  });

  it('ignora snapshot vazio', () => {
    setBrowserOdds('Blaze', []);
    expect(getBrowserOddsFresh(600_000).find((e) => e.nome === 'Blaze')).toBeFalsy();
  });

  it('a última gravação substitui a anterior', () => {
    setBrowserOdds('1xBet', [odd]);
    setBrowserOdds('1xBet', [odd, odd]);
    const e = getBrowserOddsFresh(600_000).find((x) => x.nome === '1xBet');
    expect(e?.odds).toHaveLength(2);
  });
});
