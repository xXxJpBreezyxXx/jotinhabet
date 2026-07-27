import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Mock mínimo do supabase: app_config e operacoes controláveis por teste. */
const h = vi.hoisted(() => ({
  appConfig: null as any[] | null,
  operacoes: null as any[] | null,
}));

vi.mock('../../src/db/client', () => {
  function builder(table: string) {
    const b: any = {
      select() { return b; },
      eq() { return b; },
      limit() { return b; },
      then(res: any, rej?: any) {
        const data = table === 'app_config' ? h.appConfig : h.operacoes;
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  }
  return { supabase: { from: builder } };
});

import { bancaParaAlertas } from '../../src/core/bancaAtiva';

beforeEach(() => {
  h.appConfig = null;
  h.operacoes = null;
});

describe('bancaParaAlertas', () => {
  it('usa a banca ativa salva no painel quando existe (fonte da verdade)', async () => {
    h.appConfig = [{ valor: '222.04' }];
    h.operacoes = [{ lucro_real: 9.03 }]; // legado daria 59.03 — não pode vencer
    expect(await bancaParaAlertas()).toBe(222.04);
  });

  it('sem banca salva, cai no legado 50 + Σ lucro_real', async () => {
    h.operacoes = [{ lucro_real: 9.03 }, { lucro_real: 0.97 }];
    expect(await bancaParaAlertas()).toBe(60);
  });

  it('banca salva inválida (zero/negativa/lixo) não vale — usa o legado', async () => {
    h.appConfig = [{ valor: '0' }];
    h.operacoes = [{ lucro_real: 5 }];
    expect(await bancaParaAlertas()).toBe(55);
    h.appConfig = [{ valor: 'abc' }];
    expect(await bancaParaAlertas()).toBe(55);
  });

  it('sem nada no banco, volta ao piso de 50', async () => {
    expect(await bancaParaAlertas()).toBe(50);
  });

  it('legado abaixo de R$ 1 volta ao piso de 50 (mesma regra antiga)', async () => {
    h.operacoes = [{ lucro_real: -49.5 }];
    expect(await bancaParaAlertas()).toBe(50);
  });
});
