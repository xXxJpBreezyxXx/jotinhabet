import { describe, it, expect, afterEach, vi } from 'vitest';
import { dentroDaJanelaDeAlerta } from '../../src/core/scanner_v2';

/**
 * Janela de envio do alerta no WhatsApp (horário de Brasília, UTC-3):
 *  - partidas de HOJE: sempre;
 *  - partidas de AMANHÃ: só a partir das 20h;
 *  - depois de amanhã: nunca.
 * Brasília = UTC-3 constante → UTC 23:00 = 20:00 BR.
 */
describe('dentroDaJanelaDeAlerta', () => {
  afterEach(() => vi.useRealTimers());

  // Fixa o "agora" e volta a data BR do dia/amanhã/depois em "(DD/MM/AAAA HH:MM)".
  const comAgora = (isoUtc: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(isoUtc));
  };
  const ev = (dataBR: string) => `Time A x Time B (${dataBR} 15:00)`;

  it('antes das 20h BR: libera HOJE e bloqueia AMANHÃ', () => {
    comAgora('2026-07-18T20:00:00Z'); // 17:00 BR, dia 18/07
    expect(dentroDaJanelaDeAlerta(ev('18/07/2026'))).toBe(true);
    expect(dentroDaJanelaDeAlerta(ev('19/07/2026'))).toBe(false);
    expect(dentroDaJanelaDeAlerta(ev('20/07/2026'))).toBe(false);
  });

  it('a partir das 20h BR: libera HOJE e AMANHÃ (não depois)', () => {
    comAgora('2026-07-18T23:30:00Z'); // 20:30 BR, dia 18/07
    expect(dentroDaJanelaDeAlerta(ev('18/07/2026'))).toBe(true);
    expect(dentroDaJanelaDeAlerta(ev('19/07/2026'))).toBe(true);
    expect(dentroDaJanelaDeAlerta(ev('20/07/2026'))).toBe(false);
  });

  it('usa o dia de BRASÍLIA, não o UTC (rollover de meia-noite)', () => {
    comAgora('2026-07-19T02:00:00Z'); // UTC já é 19/07, mas BR = 23:00 do 18/07
    expect(dentroDaJanelaDeAlerta(ev('18/07/2026'))).toBe(true);  // "hoje" em BR
    expect(dentroDaJanelaDeAlerta(ev('19/07/2026'))).toBe(true);  // "amanhã" em BR, já passou das 20h
  });

  it('rótulos textuais: "(Hoje" sempre; "(Amanhã" só após 20h', () => {
    comAgora('2026-07-18T20:00:00Z'); // 17:00 BR
    expect(dentroDaJanelaDeAlerta('Time A x Time B (Hoje 15:00)')).toBe(true);
    expect(dentroDaJanelaDeAlerta('Time A x Time B (Amanhã 15:00)')).toBe(false);
    comAgora('2026-07-18T23:30:00Z'); // 20:30 BR
    expect(dentroDaJanelaDeAlerta('Time A x Time B (Amanhã 15:00)')).toBe(true);
  });

  it('sem data clara no evento: não bloqueia', () => {
    comAgora('2026-07-18T20:00:00Z');
    expect(dentroDaJanelaDeAlerta('Time A x Time B')).toBe(true);
  });
});
