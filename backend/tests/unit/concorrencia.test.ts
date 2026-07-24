import { describe, it, expect } from 'vitest';
import { comLimite } from '../../src/utils/concorrencia';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('utils/comLimite', () => {
  it('preserva a ordem por índice mesmo quando itens terminam fora de ordem', async () => {
    const itens = [30, 10, 20, 5]; // o 1º demora mais que os seguintes
    const res = await comLimite(itens, 4, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(res.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20, 5]);
  });

  it('isola falhas: uma rejeição não derruba as demais e vira rejected no índice certo', async () => {
    const res = await comLimite([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('falhou no 2');
      return n * 10;
    });
    expect(res[0]).toMatchObject({ status: 'fulfilled', value: 10 });
    expect(res[1].status).toBe('rejected');
    expect((res[1] as PromiseRejectedResult).reason.message).toBe('falhou no 2');
    expect(res[2]).toMatchObject({ status: 'fulfilled', value: 30 });
  });

  it('nunca ultrapassa o limite de concorrência', async () => {
    let emVoo = 0;
    let pico = 0;
    const itens = Array.from({ length: 8 }, (_, i) => i);
    await comLimite(itens, 3, async () => {
      emVoo++;
      pico = Math.max(pico, emVoo);
      await tick(10);
      emVoo--;
      return null;
    });
    expect(pico).toBeLessThanOrEqual(3);
    expect(pico).toBeGreaterThan(1); // de fato rodou em paralelo
  });

  it('lista vazia devolve lista vazia (não trava)', async () => {
    const res = await comLimite([], 5, async () => 1);
    expect(res).toEqual([]);
  });
});
