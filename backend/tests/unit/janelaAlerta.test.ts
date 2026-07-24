import { describe, it, expect, afterEach, vi } from 'vitest';
import { dentroDaJanelaDeAlerta } from '../../src/core/scanner_v2';

/**
 * Janela de envio do alerta no WhatsApp: partidas cujo início cai dentro das próximas
 * 48h. Substituiu a regra antiga ("hoje sempre / amanhã só após 20h / depois nunca").
 * A data do evento vem em Brasília (UTC-3) no texto "(DD/MM/AAAA HH:MM)".
 */
describe('dentroDaJanelaDeAlerta (janela de 48h)', () => {
  afterEach(() => vi.useRealTimers());

  const comAgora = (isoUtc: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(isoUtc));
  };
  // Evento "(DD/MM/AAAA HH:MM)" com horário de início em Brasília.
  const ev = (dataBR: string, horaBR = '20:00') => `Time A x Time B (${dataBR} ${horaBR})`;

  it('libera partidas dentro das próximas 48h (hoje e amanhã)', () => {
    comAgora('2026-07-18T12:00:00Z'); // 09:00 BR, 18/07
    expect(dentroDaJanelaDeAlerta(ev('18/07/2026'))).toBe(true); // hoje à noite
    expect(dentroDaJanelaDeAlerta(ev('19/07/2026'))).toBe(true); // ~35h à frente
  });

  it('bloqueia partidas além de 48h; libera bem no limite', () => {
    comAgora('2026-07-18T12:00:00Z'); // 09:00 BR, 18/07 → limite = 20/07 09:00 BR
    expect(dentroDaJanelaDeAlerta(ev('20/07/2026', '08:00'))).toBe(true);  // ~47h → dentro
    expect(dentroDaJanelaDeAlerta(ev('20/07/2026', '20:00'))).toBe(false); // ~59h → fora
    expect(dentroDaJanelaDeAlerta(ev('21/07/2026'))).toBe(false);          // fora
  });

  it('amanhã já não depende mais das 20h (mudança de contrato)', () => {
    comAgora('2026-07-18T12:00:00Z'); // 09:00 BR — bem antes das 20h
    expect(dentroDaJanelaDeAlerta(ev('19/07/2026', '15:00'))).toBe(true);
  });

  it('rótulos textuais "(Hoje" e "(Amanhã" cabem sempre na janela', () => {
    comAgora('2026-07-18T12:00:00Z');
    expect(dentroDaJanelaDeAlerta('Time A x Time B (Hoje 15:00)')).toBe(true);
    expect(dentroDaJanelaDeAlerta('Time A x Time B (Amanhã 15:00)')).toBe(true);
  });

  it('usa o instante real (UTC-3), não o dia de calendário', () => {
    comAgora('2026-07-19T02:00:00Z'); // UTC 19/07, mas BR = 23:00 do 18/07
    // Evento 20/07 22:00 BR = 21/07 01:00 UTC. Agora = 19/07 02:00 UTC. Diferença ~47h → dentro.
    expect(dentroDaJanelaDeAlerta(ev('20/07/2026', '22:00'))).toBe(true);
  });

  it('sem data clara no evento: não bloqueia', () => {
    comAgora('2026-07-18T12:00:00Z');
    expect(dentroDaJanelaDeAlerta('Time A x Time B')).toBe(true);
  });
});
