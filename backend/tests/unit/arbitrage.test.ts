import { describe, it, expect } from 'vitest';
import { ArbitrageEngine } from '../../src/arbitrage/engine';
import { ScrapedOdd } from '../../src/scraping/scraper_base';
import { normalizarMercado, mesmaOferta, linhasIguais } from '../../src/arbitrage/markets';
import { mesmoHorario, parseKickoff, forcaMatchEvento, areEventsSame } from '../../src/arbitrage/matcher';

const odd = (o: Partial<ScrapedOdd>): ScrapedOdd => ({
  esporte: 'Futebol',
  evento: 'Time A vs Time B',
  dataHora: '2026-07-15T10:00:00Z',
  mercado: 'Total de gols',
  opcaoA: 'Mais de 2.5',
  opcaoB: 'Menos de 2.5',
  oddA: 2,
  oddB: 2,
  ...o,
});

describe('markets.normalizarMercado', () => {
  it('distingue assunto: gols ≠ escanteios', () => {
    expect(normalizarMercado('Total de gols')).toBe('TOTAIS_GOLS_FT');
    expect(normalizarMercado('Total de escanteios')).toBe('TOTAIS_ESCANTEIOS_FT');
    expect(normalizarMercado('Total de gols')).not.toBe(normalizarMercado('Total de escanteios'));
  });
  it('distingue período: FT ≠ 1º tempo', () => {
    expect(normalizarMercado('Total de gols - 1º Tempo')).toBe('TOTAIS_GOLS_1T');
    expect(normalizarMercado('Total de gols')).not.toBe(normalizarMercado('Total de gols - 1º Tempo'));
  });
  it('reconhece match winner com sinônimos', () => {
    expect(normalizarMercado('Resultado Final')).toBe('RESULTADO_FINAL_FT');
    expect(normalizarMercado('Vencedor da Partida')).toBe('RESULTADO_FINAL_FT');
  });
});

describe('markets.mesmaOferta (gate de linha)', () => {
  it('cruza mesma linha com nomes diferentes de mercado', () => {
    expect(mesmaOferta('Total de gols', 2.5, 'Total de Gols', 2.5)).toBe(true);
  });
  it('NÃO cruza linhas diferentes', () => {
    expect(mesmaOferta('Total de gols', 2.5, 'Total de gols', 3.0)).toBe(false);
  });
  it('NÃO cruza assuntos diferentes na mesma linha', () => {
    expect(mesmaOferta('Total de gols', 2.5, 'Total de escanteios', 2.5)).toBe(false);
  });
  it('linhasIguais trata undefined', () => {
    expect(linhasIguais(undefined, undefined)).toBe(true);
    expect(linhasIguais(2.5, undefined)).toBe(false);
  });
});

describe('matcher horário + força', () => {
  it('parseKickoff aceita ISO e formato BR (UTC)', () => {
    expect(parseKickoff('2026-07-15T10:00:00Z')).toBe(parseKickoff('2026-07-15 10:00:00'));
    expect(parseKickoff('Hoje')).toBeNull();
  });
  it('mesmoHorario: bloqueia jogos distantes, permite iguais e desconhecidos', () => {
    expect(mesmoHorario('2026-07-15T10:00:00Z', '2026-07-15 10:00:00')).toBe(true);
    expect(mesmoHorario('2026-07-15T10:00:00Z', '2026-07-15T13:00:00Z')).toBe(false);
    expect(mesmoHorario('Hoje', '2026-07-15T10:00:00Z')).toBe(true); // desconhecido não bloqueia
  });
  it('forcaMatchEvento: alto para times equivalentes, baixo para diferentes', () => {
    expect(forcaMatchEvento('Cheonan City vs Mokpo City', 'Cheonan City vs FC Mokpo')).toBeGreaterThan(0.7);
    expect(forcaMatchEvento('Barcelona vs Real Madrid', 'Bayern vs Dortmund')).toBeLessThan(0.6);
  });
  it('areEventsSame aceita separadores variados', () => {
    expect(areEventsSame('Time A vs Time B', 'Time A - Time B')).toBe(true);
  });
});

describe('ArbitrageEngine (detecção + confiança + gates)', () => {
  const engine = new ArbitrageEngine();

  it('detecta surebet de Total na mesma linha', async () => {
    const casa1 = [odd({ mercado: 'Total de gols', linha: 2.5, opcaoA: 'Mais de 2.5', opcaoB: 'Menos de 2.5', oddA: 2.1, oddB: 1.6 })];
    const casa2 = [odd({ mercado: 'Total de Gols', linha: 2.5, opcaoA: 'Mais de 2.5', opcaoB: 'Menos de 2.5', oddA: 1.7, oddB: 2.05 })];
    const ops = await engine.encontrarOportunidades('C1', casa1, 'C2', casa2);
    expect(ops.length).toBeGreaterThanOrEqual(1);
    expect(ops[0].lucroGarantidoPerc).toBeGreaterThan(0);
    expect(ops[0].confianca).toBeGreaterThan(0);
  });

  it('gate de linha: Over 2.5 NÃO cruza com Over 3.0', async () => {
    const casa1 = [odd({ mercado: 'Total de gols', linha: 2.5, oddA: 2.1, oddB: 1.6 })];
    const casa2 = [odd({ mercado: 'Total de gols', linha: 3.0, opcaoA: 'Mais de 3', opcaoB: 'Menos de 3', oddA: 1.5, oddB: 2.4 })];
    const ops = await engine.encontrarOportunidades('C1', casa1, 'C2', casa2);
    expect(ops.length).toBe(0);
  });

  it('gate de horário: jogos em horários distantes NÃO cruzam', async () => {
    const casa1 = [odd({ evento: 'Time A vs Time B', dataHora: '2026-07-15T10:00:00Z', mercado: 'Resultado Final', opcaoA: 'Time A', opcaoB: 'Time B', oddA: 2.1, oddB: 2.1 })];
    const casa2 = [odd({ evento: 'Time A vs Time B', dataHora: '2026-07-15T18:00:00Z', mercado: 'Resultado Final', opcaoA: 'Time A', opcaoB: 'Time B', oddA: 2.1, oddB: 2.1 })];
    const ops = await engine.encontrarOportunidades('C1', casa1, 'C2', casa2);
    expect(ops.length).toBe(0);
  });

  it('confiança menor + alerta quando ROI é absurdamente alto', async () => {
    // Basquete moneyline é permitido (futebol Resultado Final seria bloqueado pelas Diretrizes).
    const casa1 = [odd({ esporte: 'Basquete', mercado: 'Resultado Final', opcaoA: 'Time A', opcaoB: 'Time B', oddA: 3.0, oddB: 2.0 })];
    const casa2 = [odd({ esporte: 'Basquete', mercado: 'Resultado Final', opcaoA: 'Time A', opcaoB: 'Time B', oddA: 3.0, oddB: 3.0 })];
    const ops = await engine.encontrarOportunidades('C1', casa1, 'C2', casa2);
    const alta = ops.find(o => o.lucroGarantidoPerc > 15);
    expect(alta).toBeTruthy();
    expect(alta!.alertaPrecisao).toMatch(/ROI muito alto/);
    expect(alta!.confianca).toBeLessThan(0.9);
  });
});
