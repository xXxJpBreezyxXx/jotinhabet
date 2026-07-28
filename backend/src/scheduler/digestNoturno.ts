import { WhatsAppNotifier } from '../notify/whatsapp';
import { getValorAtivas } from '../core/valorRepo';
import { bancaParaAlertas } from '../core/bancaAtiva';

/**
 * DigestNoturnoService — resumo diário das VALUE BETS (+EV) da noite no WhatsApp.
 *
 * As value bets são radar-only (não disparam alerta individual). Este worker cobre a
 * janela em que o usuário tem mais disponibilidade: uma vez por dia, no horário
 * configurado (default 18:30 América/São_Paulo), junta as +EV cujos jogos começam nas
 * próximas horas, deduplica por aposta (mesma perna em várias casas vira UMA entrada),
 * dimensiona a stake pela banca ativa do painel (2%) e manda o plano pro grupo.
 *
 * Envs (todas opcionais):
 *  - DIGEST_NOTURNO_ENABLED       default true ('false' desliga)
 *  - DIGEST_NOTURNO_HORA          'HH:MM' em América/São_Paulo (default '18:30')
 *  - DIGEST_NOTURNO_JANELA_HORAS  quantas horas à frente olhar (default 9 → até ~3h30)
 *  - DIGEST_NOTURNO_MIN_EDGE      piso de edge % (default 3)
 *  - DIGEST_NOTURNO_MAX           máximo de entradas no plano (default 6)
 */
export class DigestNoturnoService {
  private intervalId: NodeJS.Timeout | null = null;
  private ultimoDiaEnviado = '';
  private enviando = false;

  private get horaAlvo(): string {
    const h = (process.env.DIGEST_NOTURNO_HORA || '18:30').trim();
    return /^\d{2}:\d{2}$/.test(h) ? h : '18:30';
  }

  start(): void {
    if (this.intervalId) return;
    console.log(`🌙 [DigestNoturno] Agendado para ${this.horaAlvo} (América/São_Paulo), diário.`);
    this.intervalId = setInterval(() => void this.tick(), 60 * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** "HH:MM" e "YYYY-MM-DD" atuais em América/São_Paulo. */
  private agoraSP(): { hhmm: string; dia: string } {
    const now = new Date();
    const hhmm = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(now);
    const dia = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    return { hhmm, dia };
  }

  private async tick(): Promise<void> {
    const { hhmm, dia } = this.agoraSP();
    if (hhmm !== this.horaAlvo || this.ultimoDiaEnviado === dia || this.enviando) return;
    this.enviando = true;
    try {
      await this.enviarDigest();
      this.ultimoDiaEnviado = dia;
    } catch (err: any) {
      console.error('❌ [DigestNoturno] Falha no envio:', err?.message || err);
    } finally {
      this.enviando = false;
    }
  }

  /** Monta e envia o digest. Público p/ disparo manual (testes/endpoint). */
  async enviarDigest(): Promise<boolean> {
    const janelaHoras = Number(process.env.DIGEST_NOTURNO_JANELA_HORAS) || 9;
    const minEdge = Number(process.env.DIGEST_NOTURNO_MIN_EDGE) || 3;
    const maxEntradas = Number(process.env.DIGEST_NOTURNO_MAX) || 6;

    const agora = Date.now();
    const fimJanela = agora + janelaHoras * 60 * 60 * 1000;

    const ativas = await getValorAtivas(200);
    const daNoite = ativas.filter((o) => {
      if (!(Number(o.edge_pct) >= minEdge)) return false;
      const t = o.starts_at ? Date.parse(o.starts_at) : NaN;
      return Number.isFinite(t) && t > agora && t <= fimJanela;
    });

    // Dedupe por APOSTA (evento+mercado+linha+opção): a mesma perna em várias casas
    // vira uma entrada só, listando as casas (melhor odd primeiro).
    const norm = (s: any) => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const porAposta = new Map<string, any[]>();
    for (const o of daNoite) {
      const chave = [norm(o.evento), norm(o.mercado), o.linha ?? '∅', norm(o.opcao)].join('||');
      const arr = porAposta.get(chave) || [];
      arr.push(o);
      porAposta.set(chave, arr);
    }
    const entradas = Array.from(porAposta.values())
      .map((grupo) => {
        grupo.sort((a, b) => Number(b.odd_casa) - Number(a.odd_casa));
        return { melhor: grupo[0], casas: grupo.map((g) => g.casa) };
      })
      .sort((a, b) => Number(b.melhor.edge_pct) - Number(a.melhor.edge_pct))
      .slice(0, maxEntradas)
      .sort((a, b) => Date.parse(a.melhor.starts_at) - Date.parse(b.melhor.starts_at));

    const notifier = new WhatsAppNotifier();

    if (entradas.length === 0) {
      console.log('🌙 [DigestNoturno] Sem value bets na janela — enviando aviso curto.');
      return notifier.enviarTexto(
        `🌙 *Digest da noite* — nenhuma value bet relevante (edge ≥ ${minEdge}%) começando nas próximas ${janelaHoras}h. ` +
        'O radar segue varrendo: se pintar surebet, o alerta normal dispara. 👍'
      );
    }

    const banca = await bancaParaAlertas();
    const stake = Math.max(2, Math.round(banca * 0.02));
    const horaJogo = (iso: string) =>
      new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));

    const linhas = entradas.map(({ melhor: o, casas }, i) => {
      const mercado = [o.mercado, o.linha != null ? `(${o.linha > 0 ? '+' : ''}${o.linha})` : null]
        .filter(Boolean).join(' ');
      const listaCasas = casas.slice(0, 3).join(' ou ');
      return [
        `${i + 1}️⃣ *${horaJogo(o.starts_at)}* — ${o.evento}${o.esporte ? ` (${o.esporte})` : ''}`,
        `   → *${o.opcao}* • ${mercado} @ *${Number(o.odd_casa).toFixed(2)}* (justa ${Number(o.fair_odd).toFixed(2)}, EV +${Number(o.edge_pct).toFixed(1)}%) — ${listaCasas}`,
      ].join('\n');
    });

    const msg = [
      '🌙 *DIGEST DA NOITE — VALUE BETS* 💎',
      '',
      `🏦 Banca ativa: *R$ ${banca.toFixed(2)}* → stake sugerida (2%): *R$ ${stake.toFixed(2)}* por entrada`,
      `📌 ${entradas.length} entrada(s) começando nas próximas ${janelaHoras}h (1 por jogo, melhor odd primeiro):`,
      '',
      linhas.join('\n\n'),
      '',
      '✅ *Antes de apostar, revalide:* só entre se a odd na casa ainda estiver ≥ justa × 1,03. Se caiu abaixo, o valor já foi — pule.',
      '⚠️ Value bet NÃO é surebet: lucro vem no volume. Stake fixa, sem dobrar em "certeza".',
      '📲 Registre em Radar Cashout → Minhas Apostas p/ acompanhar ao vivo.',
    ].join('\n');

    console.log(`🌙 [DigestNoturno] Enviando plano com ${entradas.length} entrada(s) (banca R$ ${banca.toFixed(2)}).`);
    return notifier.enviarTexto(msg);
  }
}
