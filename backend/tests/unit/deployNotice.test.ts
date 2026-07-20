import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { avisarDeployWhatsApp } from '../../src/notify/deployNotice';

// Notificador falso: registra as mensagens e devolve resultados programáveis por chamada.
function fakeNotifier(resultados: boolean[]) {
  const enviadas: string[] = [];
  let i = 0;
  return {
    enviadas,
    enviarTexto: vi.fn(async (t: string) => {
      enviadas.push(t);
      return resultados[Math.min(i++, resultados.length - 1)];
    }),
  };
}

describe('avisarDeployWhatsApp', () => {
  const envAntes = process.env.AVISO_DEPLOY_WHATSAPP;
  beforeEach(() => { delete process.env.AVISO_DEPLOY_WHATSAPP; });
  afterEach(() => {
    if (envAntes === undefined) delete process.env.AVISO_DEPLOY_WHATSAPP;
    else process.env.AVISO_DEPLOY_WHATSAPP = envAntes;
  });

  it('envia uma vez quando o WhatsApp aceita de primeira', async () => {
    const n = fakeNotifier([true]);
    const ok = await avisarDeployWhatsApp({ notifier: n, retryDelayMs: 0 });
    expect(ok).toBe(true);
    expect(n.enviarTexto).toHaveBeenCalledTimes(1);
    expect(n.enviadas[0]).toContain('deploy concluído');
  });

  it('retenta uma vez e vence na 2ª tentativa', async () => {
    const n = fakeNotifier([false, true]);
    const ok = await avisarDeployWhatsApp({ notifier: n, retryDelayMs: 0 });
    expect(ok).toBe(true);
    expect(n.enviarTexto).toHaveBeenCalledTimes(2);
  });

  it('desiste após 2 tentativas e retorna false', async () => {
    const n = fakeNotifier([false, false]);
    const ok = await avisarDeployWhatsApp({ notifier: n, retryDelayMs: 0 });
    expect(ok).toBe(false);
    expect(n.enviarTexto).toHaveBeenCalledTimes(2);
  });

  it('não trava se enviarTexto lançar — trata como falha e retenta', async () => {
    const n = {
      enviarTexto: vi
        .fn()
        .mockRejectedValueOnce(new Error('rede caiu'))
        .mockResolvedValueOnce(true),
    };
    const ok = await avisarDeployWhatsApp({ notifier: n as any, retryDelayMs: 0 });
    expect(ok).toBe(true);
    expect(n.enviarTexto).toHaveBeenCalledTimes(2);
  });

  it('respeita AVISO_DEPLOY_WHATSAPP=false (não envia)', async () => {
    process.env.AVISO_DEPLOY_WHATSAPP = 'false';
    const n = fakeNotifier([true]);
    const ok = await avisarDeployWhatsApp({ notifier: n, retryDelayMs: 0 });
    expect(ok).toBe(false);
    expect(n.enviarTexto).not.toHaveBeenCalled();
  });

  it('formata o horário em Brasília (UTC-3) na mensagem', async () => {
    const n = fakeNotifier([true]);
    // 2026-07-19T02:00:00Z → 23:00 do dia 18/07 em Brasília.
    await avisarDeployWhatsApp({ notifier: n, retryDelayMs: 0, agora: new Date('2026-07-19T02:00:00Z') });
    expect(n.enviadas[0]).toContain('18/07/2026 23:00');
  });
});
