import { describe, it, expect } from 'vitest';
import { RevalidationService, casaTemScraper } from '../../src/core/revalidationService';
import { ScrapedOdd } from '../../src/scraping/scraper_base';

// Acessa os métodos privados (traduzirOpcaoSureRadar / acharPerna) via cast — o objetivo
// é provar a cadeia de matching da revalidação por-casas ISOLADA da cobertura ao vivo.
const svc = new RevalidationService() as any;

describe('Revalidação SureRadar pelas casas — resolução de casa', () => {
  it('casaTemScraper aceita label da SureRadar com sufixo "(BR)"', () => {
    expect(casaTemScraper('Betnacional (BR)')).toBe(true);
    expect(casaTemScraper('SuperBet (BR)')).toBe(true);
    expect(casaTemScraper('VBet (BR)')).toBe(true);
    expect(casaTemScraper('SeuBet (BR)')).toBe(true);
    expect(casaTemScraper('BetBoom (BR)')).toBe(true);
    // casas adicionadas em 2026-07-19 (browser + Altenar + Stake)
    expect(casaTemScraper('Betano (BR)')).toBe(true);
    expect(casaTemScraper('Blaze')).toBe(true);
    expect(casaTemScraper('1xBet')).toBe(true);
    expect(casaTemScraper('BetPix365 (BR)')).toBe(true);
    expect(casaTemScraper('EstrelaBet')).toBe(true);
    expect(casaTemScraper('MC Games')).toBe(true);
    expect(casaTemScraper('Stake (BR)')).toBe(true);
    // casas sem scraper (inviáveis headless — ver memória)
    expect(casaTemScraper('Bet365')).toBe(false);
    expect(casaTemScraper('Novibet (BR)')).toBe(false);
  });
});

describe('traduzirOpcaoSureRadar', () => {
  const T = (m: string, o: string, l: number | null = null) => svc.traduzirOpcaoSureRadar(m, o, l);

  it('BTTS: mapeia p/ Sim/Não pelo texto', () => {
    expect(T('Ambos marcam - Não', 'Ambos marcam - Não - gols')).toBe('Não');
    expect(T('Ambos marcam', 'Ambos marcam - gols')).toBe('Sim');
    expect(T('Ambas equipes marcam', 'Sim')).toBe('Sim');
  });

  it('Total: mapeia over/under (pt e en) p/ rótulo canônico do scraper', () => {
    expect(T('Total de gols', 'Over 2.5 gols')).toBe('Mais de 2.5');
    expect(T('Total de gols', 'Under 2.5 gols')).toBe('Menos de 2.5');
    expect(T('Total de gols', 'Acima de 2,5', 2.5)).toBe('Mais de 2.5');
    expect(T('Total de gols', 'Abaixo de 2,5', 2.5)).toBe('Menos de 2.5');
  });

  it('mercado de time (DNB/Resultado) passa direto (acharPerna casa por nome)', () => {
    expect(T('Empate anula a aposta', 'Atlético-MG')).toBe('Atlético-MG');
    expect(T('Resultado Final', 'Palmeiras')).toBe('Palmeiras');
  });
});

describe('acharPerna casa o rótulo traduzido contra a saída real do scraper', () => {
  const odds: ScrapedOdd[] = [
    { esporte: 'Futebol', evento: 'A vs B', dataHora: '2026-07-21T22:30:00Z', mercado: 'Ambas Equipes Marcam', opcaoA: 'Sim', opcaoB: 'Não', oddA: 1.72, oddB: 2.05 },
    { esporte: 'Futebol', evento: 'A vs B', dataHora: '2026-07-21T22:30:00Z', mercado: 'Total de Gols', linha: 2.5, opcaoA: 'Mais de 2.5', opcaoB: 'Menos de 2.5', oddA: 1.85, oddB: 1.9 },
    { esporte: 'Futebol', evento: 'A vs B', dataHora: '2026-07-21T22:30:00Z', mercado: 'Empate anula a aposta', opcaoA: 'Atlético-MG', opcaoB: 'Bahia', oddA: 1.5, oddB: 2.4 },
  ];

  it('BTTS Não/Sim traduzidos batem no lado certo', () => {
    expect(svc.acharPerna(odds, 'Ambos marcam - Não', null, svc.traduzirOpcaoSureRadar('Ambos marcam - Não', 'Ambos marcam - Não - gols'))).toBe(2.05);
    expect(svc.acharPerna(odds, 'Ambos marcam', null, svc.traduzirOpcaoSureRadar('Ambos marcam', 'Ambos marcam - gols'))).toBe(1.72);
  });

  it('Total Over/Under traduzidos batem no lado e linha certos', () => {
    expect(svc.acharPerna(odds, 'Total de gols', null, svc.traduzirOpcaoSureRadar('Total de gols', 'Over 2.5 gols'))).toBe(1.85);
    expect(svc.acharPerna(odds, 'Total de gols', null, svc.traduzirOpcaoSureRadar('Total de gols', 'Under 2.5 gols'))).toBe(1.9);
  });

  it('DNB por nome de time casa no lado certo', () => {
    expect(svc.acharPerna(odds, 'Empate anula a aposta', null, 'Atlético-MG')).toBe(1.5);
    expect(svc.acharPerna(odds, 'Empate anula a aposta', null, 'Bahia')).toBe(2.4);
  });

  it('linha ERRADA não casa (não devolve odd de outra linha)', () => {
    expect(svc.acharPerna(odds, 'Total de gols', null, svc.traduzirOpcaoSureRadar('Total de gols', 'Over 3.5 gols'))).toBe(null);
  });
});
