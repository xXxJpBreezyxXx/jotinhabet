import { describe, it, expect } from 'vitest';
import { canonizarCasa } from '../../src/signals/casasAliases';

// Chaves do SCRAPER_FACTORY (revalidationService.ts) — a revalidação resolve o
// scraper por lowercase(nome), então lowercase(canônico) TEM que bater com a chave.
const CASAS_COM_SCRAPER = ['kto', 'betwarrior', 'superbet', 'aposta1', 'pinnacle', 'betboom', 'seubet', 'vbet'];

describe('canonizarCasa', () => {
  it('todo canônico de casa com scraper resolve a chave do SCRAPER_FACTORY', () => {
    for (const chave of CASAS_COM_SCRAPER) {
      const canonico = canonizarCasa(chave);
      expect(canonico.trim().toLowerCase()).toBe(chave);
    }
  });

  it('normaliza variações de escrita comuns de grupo', () => {
    expect(canonizarCasa('KTO (BR)')).toBe('KTO');
    expect(canonizarCasa('kto br')).toBe('KTO');
    expect(canonizarCasa('SUPERBET')).toBe('Superbet');
    expect(canonizarCasa('Bet Warrior')).toBe('BetWarrior');
    expect(canonizarCasa('seu.bet')).toBe('SeuBet');
    expect(canonizarCasa('Aposta 1')).toBe('Aposta1');
  });

  it('mapeia casas sem scraper para o nome de exibição', () => {
    expect(canonizarCasa('BETANO')).toBe('Betano');
    expect(canonizarCasa('bet 365')).toBe('Bet365');
    expect(canonizarCasa('Esportes da Sorte')).toBe('EsportesDaSorte');
  });

  it('remove o sufixo "(BR)" do template da calculadora', () => {
    expect(canonizarCasa('Betsson (BR)')).toBe('Betsson');
    expect(canonizarCasa('Novibet (BR)')).toBe('Novibet');
    expect(canonizarCasa('Stake (BR)')).toBe('Stake');
    expect(canonizarCasa('Superbet (BR)')).toBe('Superbet');
  });

  it('casa desconhecida passa intacta (trimada)', () => {
    expect(canonizarCasa('  Casa Nova XYZ  ')).toBe('Casa Nova XYZ');
  });
});
