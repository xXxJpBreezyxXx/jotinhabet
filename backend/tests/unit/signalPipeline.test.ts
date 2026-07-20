import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Testes do SignalPipeline com as bordas mockadas (banco, WhatsApp, cache de
 * alertas, gates de horário e revalidação). Regras de risco (regras.ts),
 * engine e canonização de casas são REAIS — é o contrato que importa.
 */
const h = vi.hoisted(() => {
  const estado = {
    // banco
    operacoesLucro: [] as any[],       // .from('operacoes').select('lucro_real')
    operacoesPorEvento: [] as any[],   // .from('operacoes').select('id').eq('evento')
    duplicataQuando: (_filters: any) => false,
    dedupQueries: [] as any[],
    inserted: [] as any[],
    insertResult: { data: { id: 'novo-id' } as any, error: null as any },
    updated: [] as any[],
    deleted: [] as any[],
    // gates de horário
    preJogo: true,
    dentroJanela: true,
    // revalidação
    reval: { ok: true, oddA: 2.05, oddB: 2.15, roiAtual: 4.5, motivo: 'odds atuais' } as any,
    revalCalls: 0,
    revalArgs: [] as any[],
    dataHoraFeed: null as string | null, // retorno (ISO) de dataHoraDoEvento
    // whatsapp / cache
    alertas: [] as any[],
    alertaSucesso: true,
    alreadySent: false,
    marked: [] as string[],
    resolve(q: any): any {
      if (q.table === 'operacoes') {
        if (q.cols === 'lucro_real') return { data: estado.operacoesLucro, error: null };
        return { data: estado.operacoesPorEvento, error: null };
      }
      if (q.table === 'oportunidades') {
        if (q.op === 'insert') {
          estado.inserted.push(q.payload);
          return estado.insertResult;
        }
        if (q.op === 'update') {
          estado.updated.push(q);
          return { data: null, error: null };
        }
        if (q.op === 'delete') {
          estado.deleted.push(q);
          return { data: null, error: null };
        }
        estado.dedupQueries.push(q.filters);
        if (estado.duplicataQuando(q.filters)) return { data: [{ id: 'dup-id' }], error: null };
        return { data: [], error: null };
      }
      return { data: null, error: null };
    },
  };
  return estado;
});

vi.mock('../../src/db/client', () => {
  function builder(table: string) {
    const q: any = { table, filters: {}, op: 'select' };
    const b: any = {
      select(cols?: string) { if (q.op === 'select') q.cols = cols; return b; },
      eq(col: string, val: any) { q.filters[col] = val; return b; },
      limit() { return b; },
      single() { return b; },
      in() { return b; },
      update(payload: any) { q.op = 'update'; q.payload = payload; return b; },
      insert(payload: any) { q.op = 'insert'; q.payload = payload; return b; },
      delete() { q.op = 'delete'; return b; },
      then(res: any, rej?: any) { return Promise.resolve(h.resolve(q)).then(res, rej); },
    };
    return b;
  }
  return { supabase: { from: (t: string) => builder(t) } };
});

vi.mock('../../src/notify/whatsapp', () => ({
  WhatsAppNotifier: class {
    async enviarAlerta(a: any) { h.alertas.push(a); return h.alertaSucesso; }
    async enviarTexto() { return true; }
  },
}));

vi.mock('../../src/notify/alertCache', () => ({
  alertAlreadySent: () => h.alreadySent,
  markAlertAsSent: (k: string) => { h.marked.push(k); },
}));

vi.mock('../../src/core/scanner_v2', () => ({
  ehPreJogo: () => h.preJogo,
  dentroDaJanelaDeAlerta: () => h.dentroJanela,
}));

vi.mock('../../src/core/revalidationService', () => ({
  // Réplica do lookup real: lowercase(nome) ∈ chaves do SCRAPER_FACTORY.
  casaTemScraper: (c: string) =>
    ['kto', 'betwarrior', 'superbet', 'aposta1', 'pinnacle', 'betboom', 'seubet', 'vbet']
      .includes((c || '').toString().trim().toLowerCase()),
  RevalidationService: class {
    async checarPernasAoVivo(opp: any) { h.revalCalls++; h.revalArgs.push(opp); return h.reval; }
    async dataHoraDoEvento() { return h.dataHoraFeed; }
  },
}));

import { SignalPipeline } from '../../src/signals/signalPipeline';
import { SinalExtraido } from '../../src/IA/extractors/telegramSignalExtractor';

const SINAL: SinalExtraido = {
  eh_sinal: true,
  confianca: 95,
  evento: 'Flamengo x Palmeiras',
  esporte: 'Futebol',
  mercado: 'Total de Gols',
  linha: 2.5,
  opcaoA: 'Mais de 2.5',
  opcaoB: 'Menos de 2.5',
  oddA: 2.1,
  oddB: 2.1,
  casaA: 'KTO',
  casaB: 'Superbet',
  dataHora: '18/07/2026 16:00',
};

beforeEach(() => {
  h.operacoesLucro = [];
  h.operacoesPorEvento = [];
  h.duplicataQuando = () => false;
  h.dedupQueries = [];
  h.inserted = [];
  h.insertResult = { data: { id: 'novo-id' }, error: null };
  h.updated = [];
  h.deleted = [];
  h.preJogo = true;
  h.dentroJanela = true;
  h.reval = { ok: true, oddA: 2.05, oddB: 2.15, roiAtual: 4.5, motivo: 'odds atuais' };
  h.revalCalls = 0;
  h.revalArgs = [];
  h.dataHoraFeed = null;
  h.alertas = [];
  h.alertaSucesso = true;
  h.alreadySent = false;
  h.marked = [];
});

describe('construirOportunidade', () => {
  it('deriva ROI/totalPerc das odds e usa o formato canônico de evento', () => {
    const opp = new SignalPipeline().construirOportunidade(SINAL)!;
    expect(opp).not.toBeNull();
    expect(opp.evento).toBe('Flamengo x Palmeiras (18/07/2026 16:00)');
    expect(opp.totalPerc).toBeCloseTo(0.9524, 4);
    expect(opp.lucroGarantidoPerc).toBeCloseTo(5.0, 1);
    expect(opp.oddCombinadaA).toBeCloseTo(0.5, 4);
    expect(opp.casaA).toBe('KTO');
    expect(opp.url).toBeUndefined();
  });

  it('usa "(Hoje)" quando o sinal não traz horário', () => {
    const opp = new SignalPipeline().construirOportunidade({ ...SINAL, dataHora: null })!;
    expect(opp.evento).toBe('Flamengo x Palmeiras (Hoje)');
    expect(opp.dataHora).toBeUndefined();
  });

  it('rejeita par sem break-even', () => {
    expect(new SignalPipeline().construirOportunidade({ ...SINAL, oddA: 1.5, oddB: 1.5 })).toBeNull();
  });
});

describe('gates de risco (regras.ts reais)', () => {
  it('bloqueia Resultado Final no futebol sem inserir', async () => {
    const r = await new SignalPipeline().processarSinal({
      ...SINAL,
      mercado: 'Resultado Final',
      linha: null,
      opcaoA: 'Flamengo',
      opcaoB: 'Palmeiras',
    });
    expect(r.acao).toBe('bloqueada_regras');
    expect(h.inserted).toHaveLength(0);
    expect(h.alertas).toHaveLength(0);
  });

  it('bloqueia tênis cruzando grupos de W.O. (KTO grupo B × Superbet grupo A)', async () => {
    const r = await new SignalPipeline().processarSinal({
      ...SINAL,
      esporte: 'Tênis',
      mercado: 'Vencedor',
      linha: null,
      opcaoA: 'Alcaraz',
      opcaoB: 'Sinner',
    });
    expect(r.acao).toBe('bloqueada_regras');
    expect(r.motivo).toBeTruthy();
  });

  it('permite tênis no MESMO grupo de W.O. (Superbet × Vbet, ambas A)', async () => {
    const r = await new SignalPipeline().processarSinal({
      ...SINAL,
      esporte: 'Tênis',
      mercado: 'Vencedor',
      linha: null,
      opcaoA: 'Alcaraz',
      opcaoB: 'Sinner',
      casaA: 'Superbet',
      casaB: 'Vbet',
    });
    expect(r.acao).not.toBe('bloqueada_regras');
    expect(h.inserted).toHaveLength(1);
  });
});

describe('dedup contra o radar', () => {
  it('acha duplicata na ordem direta e só atualiza visto_em', async () => {
    h.duplicataQuando = (f) => f.casa_a_nome === 'KTO' && f.casa_b_nome === 'Superbet';
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('duplicada');
    expect(r.id).toBe('dup-id');
    expect(h.updated).toHaveLength(1);
    expect(h.inserted).toHaveLength(0);
  });

  it('acha duplicata com as casas INVERTIDAS', async () => {
    h.duplicataQuando = (f) => f.casa_a_nome === 'Superbet' && f.casa_b_nome === 'KTO';
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('duplicada');
    expect(h.dedupQueries.length).toBeGreaterThanOrEqual(2);
  });
});

describe('decisão revalidável × não-revalidável', () => {
  it('par com scrapers → revalida, alerta com odds FRESCAS e nota ✅', async () => {
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('alertada');
    expect(h.revalCalls).toBe(1);
    expect(h.revalArgs[0].fonte).toBe('telegram');
    expect(h.inserted[0].fonte).toBe('telegram');
    expect(h.alertas).toHaveLength(1);
    const alerta = h.alertas[0];
    expect(alerta.odd1).toBe(2.05); // odds frescas da revalidação, não do print
    expect(alerta.roi).toBe(4.5);
    expect(alerta.fonte).toBe('Telegram (IA)');
    expect(alerta.nota).toContain('✅ Revalidada');
    expect(alerta.dataPartida).toBe('18/07/2026 16:00');
    expect(h.marked).toHaveLength(1);
  });

  it('casa sem scraper → NÃO revalida e alerta com tag ⚠️ e odds do print', async () => {
    const r = await new SignalPipeline().processarSinal({ ...SINAL, casaB: 'Bet365' });
    expect(r.acao).toBe('alertada_nao_revalidada');
    expect(h.revalCalls).toBe(0);
    const alerta = h.alertas[0];
    expect(alerta.odd1).toBe(2.1); // odds extraídas da imagem
    expect(alerta.nota).toContain('⚠️ NÃO REVALIDADO');
    expect(alerta.nota).toContain('Bet365');
    expect(h.marked).toHaveLength(1);
  });

  it('revalidação reprova → alerta suprimido, linha mantida (arb morreu)', async () => {
    h.reval = { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: 'perna não encontrada agora em KTO' };
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('suprimida_revalidacao');
    expect(h.alertas).toHaveLength(0);
    expect(h.deleted).toHaveLength(0); // "arb morreu" não é falha de infra
  });

  it('falha de INFRA na revalidação → suprime E remove a linha', async () => {
    h.reval = { ok: false, oddA: null, oddB: null, roiAtual: null, motivo: 'falha ao re-buscar pernas: timeout' };
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('suprimida_revalidacao');
    expect(h.deleted).toHaveLength(1);
  });

  it('ROI revalidado abaixo do piso 1.5 → suprime', async () => {
    h.reval = { ok: true, oddA: 2.0, oddB: 2.02, roiAtual: 0.5, motivo: 'odds atuais' };
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('suprimida_revalidacao');
  });
});

describe('gate de alerta', () => {
  it('não alerta partida que já começou (mas insere)', async () => {
    h.preJogo = false;
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('inserida_sem_alerta');
    expect(h.inserted).toHaveLength(1);
    expect(h.alertas).toHaveLength(0);
  });

  it('não alerta evento já apostado', async () => {
    h.operacoesPorEvento = [{ id: 'op-1' }];
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('inserida_sem_alerta');
    expect(r.motivo).toContain('já apostado');
  });

  it('não re-alerta com alertKey já enviado', async () => {
    h.alreadySent = true;
    const r = await new SignalPipeline().processarSinal(SINAL);
    expect(r.acao).toBe('inserida_sem_alerta');
    expect(h.alertas).toHaveLength(0);
  });

  it('links do grupo: casados por casa/hostname entram como link1/link2, soltos vão na nota', async () => {
    const r = await new SignalPipeline().processarSinal(
      { ...SINAL, casaA: 'Betsson', casaB: 'Novibet' }, // ambas sem scraper → alerta ⚠️ direto
      {
        links: [
          { url: 'https://novibet.bet.br/apostas/evento/123', casa: null },      // casa via hostname
          { url: 'https://betsson.com/pt/evento/456', casa: 'Betsson' },          // casa via contexto
          { url: 'https://t.me/canalqualquer/789', casa: null },                  // não casa → nota
        ],
      }
    );
    expect(r.acao).toBe('alertada_nao_revalidada');
    const alerta = h.alertas[0];
    expect(alerta.link1).toBe('https://betsson.com/pt/evento/456');
    expect(alerta.link2).toBe('https://novibet.bet.br/apostas/evento/123');
    expect(alerta.nota).toContain('🔗 Links do grupo: https://t.me/canalqualquer/789');
  });

  it('sem dataHora dos prints, resolve via feed de casa com scraper (ISO → Brasília)', async () => {
    h.dataHoraFeed = '2026-07-19T00:30:00Z'; // 21:30 de 18/07 em Brasília (UTC-3)
    const r = await new SignalPipeline().processarSinal({ ...SINAL, dataHora: null });
    expect(r.acao).toBe('alertada');
    expect(h.inserted[0].evento).toBe('Flamengo x Palmeiras (18/07/2026 21:30)');
    expect(h.alertas[0].dataPartida).toBe('18/07/2026 21:30');
  });

  it('sem dataHora e sem feed/links, segue como "(Hoje)"', async () => {
    const r = await new SignalPipeline().processarSinal({ ...SINAL, dataHora: null, casaB: 'Bet365' }, { links: [] });
    expect(r.acao).toBe('alertada_nao_revalidada');
    expect(h.inserted[0].evento).toBe('Flamengo x Palmeiras (Hoje)');
  });

  it('dataHora herdada do contexto entra no evento e no dataPartida do alerta', async () => {
    const r = await new SignalPipeline().processarSinal({ ...SINAL, casaB: 'Bet365', dataHora: '19/07/2026 21:30' });
    expect(r.acao).toBe('alertada_nao_revalidada');
    expect(h.inserted[0].evento).toBe('Flamengo x Palmeiras (19/07/2026 21:30)');
    expect(h.alertas[0].dataPartida).toBe('19/07/2026 21:30');
  });

  it('nota inclui aviso de quarter-line quando a linha é .25/.75', async () => {
    const r = await new SignalPipeline().processarSinal({
      ...SINAL,
      linha: 2.75,
      opcaoA: 'Mais de 2.75',
      opcaoB: 'Menos de 2.75',
    });
    expect(r.acao).toBe('alertada');
    expect(h.alertas[0].nota).toContain('PISO garantido');
  });
});
