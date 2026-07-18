import { describe, it, expect } from 'vitest';
import { GreenMonitorService } from '../../src/scheduler/greenMonitorService';

const s = new GreenMonitorService();
const H = 3600_000;

describe('GreenMonitorService — kickoff/buffer/decisão (puro)', () => {
  it('kickoffFromEvento interpreta "(DD/MM/AAAA HH:MM)" como horário de Brasília (-03:00)', () => {
    const ms = s.kickoffFromEvento('Time A vs Time B (16/07/2026 14:30)');
    expect(ms).toBe(Date.parse('2026-07-16T17:30:00Z')); // 14:30 BRT = 17:30 UTC
  });

  it('kickoffFromEvento aceita en-dash e devolve null sem data', () => {
    expect(s.kickoffFromEvento('LDU Quito – Leones (18/07/2026 05:00)')).toBe(Date.parse('2026-07-18T08:00:00Z'));
    expect(s.kickoffFromEvento('Time A vs Time B')).toBe(null);
    expect(s.kickoffFromEvento('Time A vs Time B (Hoje)')).toBe(null);
  });

  it('bufferMs: tênis (games/sets) dura mais que o padrão', () => {
    expect(s.bufferMs('Total de Games')).toBe(4 * H);
    expect(s.bufferMs('Total de Sets')).toBe(4 * H);
    expect(s.bufferMs('Total de Gols')).toBe(3 * H); // base
    expect(s.bufferMs('')).toBe(3 * H);
  });

  it('matchEndMs: kickoff+margem; fallback entrada+5h sem kickoff', () => {
    const koms = Date.parse('2026-07-16T17:30:00Z');
    expect(s.matchEndMs({ evento: 'A vs B (16/07/2026 14:30)', mercado: 'Total de Gols' })).toBe(koms + 3 * H);
    expect(s.matchEndMs({ evento: 'A vs B (16/07/2026 14:30)', mercado: 'Total de Games' })).toBe(koms + 4 * H);
    // sem kickoff → confirmado_em + 5h
    const conf = '2026-07-16T10:00:00Z';
    expect(s.matchEndMs({ evento: 'A vs B', mercado: '', confirmado_em: conf })).toBe(Date.parse(conf) + 5 * H);
    expect(s.matchEndMs({ evento: 'A vs B', mercado: '' })).toBe(null); // sem nada
  });

  it('decisao: aguardar (futuro) / green (fim <24h) / antigo (fim >24h)', () => {
    const agora = Date.parse('2026-07-16T20:00:00Z');
    // kickoff 14:30 BRT (17:30Z) + 3h = 20:30Z → ainda não terminou às 20:00Z
    expect(s.decisao({ evento: 'A vs B (16/07/2026 14:30)', mercado: 'Total de Gols' }, agora)).toBe('aguardar');
    // fim às 18:30Z (kickoff 12:30 BRT), agora 20:00Z → terminou há 1h30 → green
    expect(s.decisao({ evento: 'A vs B (16/07/2026 12:30)', mercado: 'Total de Gols' }, agora)).toBe('green');
    // fim ontem → antigo (silêncio)
    expect(s.decisao({ evento: 'A vs B (15/07/2026 12:30)', mercado: 'Total de Gols' }, agora)).toBe('antigo');
  });
});

describe('GreenMonitorService — mensagem', () => {
  const op = {
    evento: 'Atlético-MG vs Bahia (21/07/2026 19:30)', mercado: 'Total de Gols',
    casa_a: 'Betnacional', casa_b: 'Superbet', lucro_real: 12.5,
  };
  it('formata GREEN com evento, casas, lucro e banca', () => {
    const msg = s.formatarMensagem(op, 1234.56);
    expect(msg).toContain('GREEN');
    expect(msg).toContain('Atlético-MG vs Bahia');
    expect(msg).toContain('Betnacional');
    expect(msg).toContain('Superbet');
    expect(msg).toContain('R$ 12.50');
    expect(msg).toContain('R$ 1234.56');
  });
  it('omite a linha de banca quando banca é null', () => {
    const msg = s.formatarMensagem(op, null);
    expect(msg).toContain('R$ 12.50');
    expect(msg).not.toContain('banca agora');
  });
  it('lê detalhes do JSON em resultado quando as colunas dedicadas faltam', () => {
    const opJson = {
      resultado: JSON.stringify({ evento: 'X vs Y (10/07/2026 10:00)', mercado: 'BTTS', casaA: 'KTO', casaB: 'Pinnacle' }),
      lucro_real: 3,
    };
    const msg = s.formatarMensagem(opJson, null);
    expect(msg).toContain('X vs Y');
    expect(msg).toContain('KTO');
    expect(msg).toContain('Pinnacle');
  });
});
