import { supabase } from '../db/client';
import { WhatsAppNotifier } from '../notify/whatsapp';

/**
 * GreenMonitorService — acompanhamento pós-partida das ENTRADAS (tabela operacoes).
 *
 * Quando a partida de uma entrada termina, manda um WhatsApp de parabéns com o lucro
 * e a banca atual. MODELO "ASSUMIR GREEN": arbitragem é lucro GARANTIDO e o painel já
 * soma o lucro na banca no momento da entrada — então este alerta é a CONFIRMAÇÃO de
 * que o jogo acabou; NÃO mexe na banca (só reporta a de app_config['banca_ativa']).
 *
 * "Terminou" = estimativa pelo relógio: kickoff salvo no evento "(DD/MM/AAAA HH:MM)"
 * (horário de Brasília) + margem de duração por esporte. Sem placar ao vivo (isso seria
 * a verificação de placar real — v2, precisa de API de placares). Margem generosa nunca
 * dá "green prematuro errado" (o arb greena de qualquer jeito).
 *
 * Idempotente: só alerta entradas com green_alertado_em NULL e marca após enviar.
 * Entradas cujo jogo terminou há mais de 24h (backlog do 1º deploy) são marcadas em
 * SILÊNCIO (sem WhatsApp) — evita rajada de parabéns retroativos.
 */
export class GreenMonitorService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private notifier = new WhatsAppNotifier();
  private colunaAusente = false; // migration 011 não aplicada → desliga sem crashar

  /** Margem-base (h) após o kickoff pra considerar o jogo encerrado (override por env). */
  private bufferBaseHoras(): number {
    const v = Number(process.env.GREEN_MONITOR_BUFFER_HORAS);
    return Number.isFinite(v) && v >= 1 && v <= 12 ? v : 3;
  }

  start(intervalSeconds = 900): void {
    if (this.intervalId) return;
    console.log(`🎉 [GreenMonitor] Iniciado. Ciclo: ${intervalSeconds}s (margem base ${this.bufferBaseHoras()}h).`);
    void this.verificar();
    this.intervalId = setInterval(() => void this.verificar(), intervalSeconds * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Detalhes serializados no campo `resultado` (JSON) — fallback das colunas dedicadas. */
  private detalhes(op: any): any {
    const r = op?.resultado;
    if (typeof r === 'string' && r.startsWith('{')) {
      try { return JSON.parse(r); } catch { /* ignora */ }
    }
    return {};
  }

  private campo(op: any, coluna: string, chaveJson: string): any {
    return op?.[coluna] ?? this.detalhes(op)?.[chaveJson] ?? null;
  }

  /** Kickoff (ms UTC) do sufixo "(DD/MM/AAAA HH:MM)" do evento, interpretado como BR (-03:00). */
  kickoffFromEvento(evento: string): number | null {
    const m = (evento || '').match(/\((\d{2})\/(\d{2})(?:\/(\d{4}))?\s+(\d{2}):(\d{2})\)/);
    if (!m) return null;
    const [, dd, mm, yyyy, hh, min] = m;
    const ano = yyyy || String(new Date().getFullYear());
    // Brasil sem horário de verão desde 2019 → America/Sao_Paulo é UTC-3 constante.
    const t = Date.parse(`${ano}-${mm}-${dd}T${hh}:${min}:00-03:00`);
    return isNaN(t) ? null : t;
  }

  /** Margem de duração (ms) por esporte, inferida do mercado (tênis dura mais). */
  bufferMs(mercado: string): number {
    const base = this.bufferBaseHoras() * 3600_000;
    const m = (mercado || '').toLowerCase();
    if (/\bgame|\bset\b|sets/.test(m)) return Math.max(base, 4 * 3600_000); // tênis
    return base;
  }

  /** Instante estimado de FIM da partida (ms). kickoff+margem; fallback: entrada+5h. */
  matchEndMs(op: any): number | null {
    const evento = String(this.campo(op, 'evento', 'evento') || '');
    const mercado = String(this.campo(op, 'mercado', 'mercado') || '');
    const ko = this.kickoffFromEvento(evento);
    if (ko !== null) return ko + this.bufferMs(mercado);
    const conf = Date.parse(op?.confirmado_em || '');
    return isNaN(conf) ? null : conf + 5 * 3600_000; // sem kickoff: assume jogo dentro de 5h da entrada
  }

  /** Decisão pura por entrada (testável): aguardar / antigo (silêncio) / green (alerta). */
  decisao(op: any, agora: number): 'aguardar' | 'antigo' | 'green' {
    const fim = this.matchEndMs(op);
    if (fim === null || fim > agora) return 'aguardar';
    return agora - fim > 24 * 3600_000 ? 'antigo' : 'green';
  }

  private async bancaAtual(): Promise<number | null> {
    try {
      const { data } = await supabase
        .from('app_config').select('valor').eq('chave', 'banca_ativa').maybeSingle();
      const n = data ? Number(data.valor) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  formatarMensagem(op: any, banca: number | null): string {
    const evento = String(this.campo(op, 'evento', 'evento') || 'sua entrada');
    const mercado = String(this.campo(op, 'mercado', 'mercado') || '');
    const casaA = String(this.campo(op, 'casa_a', 'casaA') || 'Casa 1');
    const casaB = String(this.campo(op, 'casa_b', 'casaB') || 'Casa 2');
    const lucro = Number(op?.lucro_real);
    const linhaBanca = banca !== null ? `\n🏦 Sua banca agora: *R$ ${banca.toFixed(2)}*` : '';
    return (
      `🎉 *GREEN!* Parabéns! 🎉\n\n` +
      `✅ Sua entrada foi concluída:\n` +
      `🏆 ${evento}\n` +
      (mercado ? `🎯 ${mercado}\n` : '') +
      `🟢 *${casaA}* × *${casaB}*\n` +
      (Number.isFinite(lucro) ? `💰 Lucro: *R$ ${lucro.toFixed(2)}*` : '') +
      linhaBanca
    );
  }

  async verificar(): Promise<void> {
    if (this.isRunning || this.colunaAusente) return;
    this.isRunning = true;
    try {
      const { data: ops, error } = await supabase
        .from('operacoes').select('*').is('green_alertado_em', null).limit(100);
      if (error) {
        if (/column|schema cache|green_alertado_em/i.test(error.message || '')) {
          console.warn('⚠️ [GreenMonitor] Coluna green_alertado_em ausente — aplique a migration 011. Monitor desligado até lá.');
          this.colunaAusente = true;
        } else {
          console.error('⚠️ [GreenMonitor] Erro ao buscar entradas:', error.message);
        }
        return;
      }
      if (!ops || ops.length === 0) return;

      const agora = Date.now();
      let banca: number | null = null;
      let bancaCarregada = false;
      for (const op of ops) {
        const d = this.decisao(op, agora);
        if (d === 'aguardar') continue;
        if (d === 'antigo') {
          await this.marcarAlertado(op.id); // backlog: marca sem enviar
          continue;
        }
        // green: carrega a banca só quando for realmente alertar
        if (!bancaCarregada) { banca = await this.bancaAtual(); bancaCarregada = true; }
        const enviado = await this.notifier.enviarTexto(this.formatarMensagem(op, banca));
        if (enviado) {
          await this.marcarAlertado(op.id);
          console.log(`🎉 [GreenMonitor] GREEN alertado: ${this.campo(op, 'evento', 'evento')}`);
        } else {
          console.warn(`⚠️ [GreenMonitor] Falha ao enviar WhatsApp da entrada ${op.id} — re-tenta no próximo ciclo.`);
        }
      }
    } catch (e: any) {
      console.error('❌ [GreenMonitor] Erro no ciclo:', e?.message || e);
    } finally {
      this.isRunning = false;
    }
  }

  private async marcarAlertado(id: string): Promise<void> {
    try {
      await supabase.from('operacoes').update({ green_alertado_em: new Date().toISOString() }).eq('id', id);
    } catch { /* silencioso */ }
  }
}
