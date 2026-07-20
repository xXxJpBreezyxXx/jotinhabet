// cashoutNotifier.ts
// Alerta de oportunidade do Radar Cashout no WhatsApp, num GRUPO SEPARADO do de
// surebet (env EVOLUTION_RECIPIENT_CASHOUT). Dedupe por assinatura com cooldown em
// memória — a mesma oportunidade não é reenviada a cada ciclo enquanto persiste.

import { WhatsAppNotifier } from '../notify/whatsapp';

export interface CashoutAlertData {
  signature: string;
  event_label: string;
  sport: string;
  market_label: string;
  selection_label: string;
  target_name: string;
  compass_fair_odd: number;
  target_odd_value: number;
  gap_pct: number;
  confirming_sources: string[];
  ttl_estimated_seconds: number | null;
  starts_at?: string | null;
}

/** Alvo mínimo do envio — permite injetar um mock nos testes. */
export interface TextSender {
  enviarTexto(texto: string): Promise<boolean>;
}

function horaBr(iso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso)).replace(',', '');
  } catch {
    return iso;
  }
}

/** Formata a mensagem de cashout (pura — testável isoladamente). */
export function formatarCashoutAlert(a: CashoutAlertData): string {
  const gap = (a.gap_pct * 100).toFixed(1);
  const ttl = a.ttl_estimated_seconds != null ? `~${a.ttl_estimated_seconds}s` : 'curta';
  const contexto = [a.sport, a.starts_at ? horaBr(a.starts_at) : null].filter(Boolean).join(' • ');
  const fontes = a.confirming_sources?.length ? a.confirming_sources.join(', ') : '—';

  return `🎯 *RADAR CASHOUT: +${gap}% de valor* 🎯

🏆 *${a.event_label}*${contexto ? `\n🏅 ${contexto}` : ''}
🎯 ${a.market_label} → *${a.selection_label}*

🟠 *Odd desregulada:* ${a.target_odd_value.toFixed(2)} (${a.target_name})
🧭 *Linha justa (bússola):* ${a.compass_fair_odd.toFixed(2)} — ${fontes}

📈 Valor estimado: *+${gap}%* | ⏳ Janela: ${ttl}

⚡ _Cotação atrasada em relação à linha afiada. A casa tende a ajustar rápido — confira e aposte já se ainda estiver de pé._`;
}

export class CashoutNotifier {
  private sender: TextSender;
  private recipient: string;
  private cooldownMs: number;
  private lastAlert = new Map<string, number>(); // signature → ms do último alerta

  constructor(recipientOverride?: string, sender?: TextSender) {
    this.recipient = (recipientOverride ?? process.env.EVOLUTION_RECIPIENT_CASHOUT ?? '').trim();
    this.sender = sender ?? new WhatsAppNotifier(this.recipient);
    const min = parseInt(process.env.CASHOUT_ALERT_COOLDOWN_MINUTES || '30', 10);
    this.cooldownMs = (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
  }

  /** True se há um destino de cashout configurado (grupo/número real, não placeholder). */
  isConfigured(): boolean {
    return !!this.recipient && !this.recipient.toLowerCase().includes('xxxx');
  }

  private podeAlertar(signature: string, nowMs: number): boolean {
    const last = this.lastAlert.get(signature);
    return !last || nowMs - last >= this.cooldownMs;
  }

  /** Envia o alerta (respeitando o cooldown). Retorna true se mandou. Nunca lança. */
  async alertar(opp: CashoutAlertData, nowMs: number): Promise<boolean> {
    if (!this.isConfigured()) return false;
    if (!this.podeAlertar(opp.signature, nowMs)) return false;
    try {
      const ok = await this.sender.enviarTexto(formatarCashoutAlert(opp));
      if (ok) this.lastAlert.set(opp.signature, nowMs);
      return ok;
    } catch (err: any) {
      console.error('[Cashout] alerta WhatsApp falhou:', err?.message);
      return false;
    }
  }

  /** Aviso de texto livre no grupo de cashout (ex.: "módulo no ar"). Sem cooldown. */
  async avisarTexto(texto: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    return this.sender.enviarTexto(texto);
  }
}

export const cashoutNotifier = new CashoutNotifier();
