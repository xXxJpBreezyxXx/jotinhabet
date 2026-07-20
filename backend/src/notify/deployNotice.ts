import { WhatsAppNotifier } from './whatsapp';

/** Alvo mínimo do aviso — permite injetar um mock nos testes. */
interface NotificadorTexto {
  enviarTexto(texto: string): Promise<boolean>;
}

export interface AvisoDeployOpts {
  /** Notificador (default: WhatsAppNotifier real). */
  notifier?: NotificadorTexto;
  /** Espera entre a 1ª e a 2ª tentativa, em ms (default 15s; testes passam 0). */
  retryDelayMs?: number;
  /** Instante do aviso (default: agora) — injetável para tornar a mensagem determinística. */
  agora?: Date;
}

/**
 * Aviso automático de "deploy concluído" no WhatsApp.
 *
 * No Swarm, `docker service update --force` reinicia o container com a imagem nova,
 * então o boot do backend equivale ao fim do deploy. É best-effort (nunca lança) com
 * 1 retentativa — a Evolution/rede pode ainda estar assentando nos primeiros segundos.
 * Desligável com a env AVISO_DEPLOY_WHATSAPP=false.
 *
 * @returns true se o WhatsApp foi enviado; false se desativado ou se falhou nas 2 tentativas.
 */
export async function avisarDeployWhatsApp(opts: AvisoDeployOpts = {}): Promise<boolean> {
  if ((process.env.AVISO_DEPLOY_WHATSAPP || '').toLowerCase() === 'false') {
    console.log('ℹ️ [Deploy] Aviso de deploy no WhatsApp desativado (AVISO_DEPLOY_WHATSAPP=false).');
    return false;
  }

  const notifier = opts.notifier ?? new WhatsAppNotifier();
  const retryDelayMs = opts.retryDelayMs ?? 15_000;
  const quando = opts.agora ?? new Date();

  const agoraBr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(quando).replace(',', '');

  const msg =
    `🚀 *JotinhaBet — deploy concluído*\n` +
    `Backend online e serviços iniciados (scanner, Telegram, monitor de GREEN).\n` +
    `🕒 ${agoraBr} (Brasília)`;

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      if (await notifier.enviarTexto(msg)) return true;
    } catch (e: any) {
      console.error('⚠️ [Deploy] Erro ao enviar aviso de deploy no WhatsApp:', e?.message || e);
    }
    if (tentativa === 1 && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  console.warn('⚠️ [Deploy] Aviso de deploy no WhatsApp não pôde ser enviado após 2 tentativas.');
  return false;
}
