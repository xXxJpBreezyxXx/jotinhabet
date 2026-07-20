import { describe, it, expect } from 'vitest';
import {
  CashoutNotifier,
  formatarCashoutAlert,
  type CashoutAlertData,
  type TextSender,
} from '../../src/cashout/cashoutNotifier';

const OPP: CashoutAlertData = {
  signature: 'ek|home|Superbet',
  event_label: 'Time A vs Time B',
  sport: 'Futebol',
  market_label: 'Resultado Final',
  selection_label: 'Time A',
  target_name: 'Superbet',
  compass_fair_odd: 1.67,
  target_odd_value: 1.95,
  gap_pct: 0.083,
  confirming_sources: ['Pinnacle'],
  ttl_estimated_seconds: 45,
  starts_at: null,
};

class FakeSender implements TextSender {
  enviados: string[] = [];
  ok = true;
  async enviarTexto(texto: string): Promise<boolean> {
    this.enviados.push(texto);
    return this.ok;
  }
}

describe('formatarCashoutAlert', () => {
  it('inclui evento, seleção, odds e gap', () => {
    const msg = formatarCashoutAlert(OPP);
    expect(msg).toContain('Time A vs Time B');
    expect(msg).toContain('Resultado Final → *Time A*');
    expect(msg).toContain('1.95 (Superbet)');
    expect(msg).toContain('1.67');
    expect(msg).toContain('+8.3%');
    expect(msg).toContain('Pinnacle');
    expect(msg).toContain('~45s');
  });

  it('TTL nulo vira "curta"', () => {
    expect(formatarCashoutAlert({ ...OPP, ttl_estimated_seconds: null })).toContain('Janela: curta');
  });
});

describe('CashoutNotifier', () => {
  it('sem destino configurado → não envia', async () => {
    const fake = new FakeSender();
    const n = new CashoutNotifier('', fake);
    expect(n.isConfigured()).toBe(false);
    expect(await n.alertar(OPP, 1000)).toBe(false);
    expect(fake.enviados).toHaveLength(0);
  });

  it('placeholder xxxx → não configurado', () => {
    expect(new CashoutNotifier('55xxxx@g.us', new FakeSender()).isConfigured()).toBe(false);
  });

  it('envia uma vez e respeita o cooldown na mesma assinatura', async () => {
    process.env.CASHOUT_ALERT_COOLDOWN_MINUTES = '30';
    const fake = new FakeSender();
    const n = new CashoutNotifier('123456@g.us', fake);
    const t0 = 1_000_000;

    expect(await n.alertar(OPP, t0)).toBe(true);
    expect(fake.enviados).toHaveLength(1);

    // 10 min depois: ainda no cooldown → não reenvia
    expect(await n.alertar(OPP, t0 + 10 * 60_000)).toBe(false);
    expect(fake.enviados).toHaveLength(1);

    // 31 min depois: passou o cooldown → reenvia
    expect(await n.alertar(OPP, t0 + 31 * 60_000)).toBe(true);
    expect(fake.enviados).toHaveLength(2);
  });

  it('assinaturas diferentes não se bloqueiam', async () => {
    const fake = new FakeSender();
    const n = new CashoutNotifier('123456@g.us', fake);
    expect(await n.alertar(OPP, 5000)).toBe(true);
    expect(await n.alertar({ ...OPP, signature: 'outra' }, 5000)).toBe(true);
    expect(fake.enviados).toHaveLength(2);
  });

  it('envio que falha não grava cooldown (permite retry no próximo ciclo)', async () => {
    const fake = new FakeSender();
    fake.ok = false;
    const n = new CashoutNotifier('123456@g.us', fake);
    expect(await n.alertar(OPP, 1000)).toBe(false);
    fake.ok = true;
    expect(await n.alertar(OPP, 2000)).toBe(true); // não estava em cooldown → tenta de novo
    expect(fake.enviados).toHaveLength(2);
  });
});
