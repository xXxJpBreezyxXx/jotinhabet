import { describe, it, expect } from 'vitest';
import { alignOdd } from '../../src/cashout/cashoutMatch';
import { ScrapedOdd } from '../../src/scraping/scraper_base';

function odd(evento: string, opcaoA: string, opcaoB: string, oddA = 2.0, oddB = 1.9, mercado = 'Resultado Final', linha?: number): ScrapedOdd {
  return { esporte: 'Futebol', evento, dataHora: 'Hoje', mercado, opcaoA, opcaoB, oddA, oddB, linha };
}

describe('alignOdd — orientação home/away', () => {
  it('mesma orientação: home←oddA, away←oddB', () => {
    const legs = alignOdd(odd('Flamengo vs Vasco', 'Flamengo', 'Vasco'), 'Flamengo', 'Vasco');
    expect(legs).toEqual([
      { selection: 'home', odd: 2.0 },
      { selection: 'away', odd: 1.9 },
    ]);
  });

  it('orientação invertida: away←oddA, home←oddB (odd segue o time)', () => {
    // Casa lista "Vasco vs Flamengo" mas o canônico é "Flamengo vs Vasco".
    const legs = alignOdd(odd('Vasco vs Flamengo', 'Vasco', 'Flamengo'), 'Flamengo', 'Vasco');
    expect(legs).toEqual([
      { selection: 'away', odd: 2.0 }, // oddA era do Vasco (=away canônico)
      { selection: 'home', odd: 1.9 }, // oddB era do Flamengo (=home canônico)
    ]);
  });

  it('homônimos que casam dos DOIS lados → null (não arrisca inverter)', () => {
    // Mesmo nome nos dois lados: placarMesma == placarInvertida → ambíguo → null.
    const legs = alignOdd(odd('River Plate vs River Plate', 'River Plate', 'River Plate'), 'River Plate', 'River Plate');
    expect(legs).toBeNull();
  });

  it('nenhum time bate → null', () => {
    const legs = alignOdd(odd('Time X vs Time Y', 'Time X', 'Time Y'), 'Outro A', 'Outro B');
    expect(legs).toBeNull();
  });

  it('totais alinham over/under por posição', () => {
    const legs = alignOdd(odd('A vs B', 'Mais de 2.5', 'Menos de 2.5', 1.95, 1.85, 'Total de Gols', 2.5), 'A', 'B');
    expect(legs).toEqual([
      { selection: 'over', odd: 1.95 },
      { selection: 'under', odd: 1.85 },
    ]);
  });
});
