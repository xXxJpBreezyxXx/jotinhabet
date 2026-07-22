// cashoutBetMonitor.ts
// Monitor POR-APOSTA do Radar Cashout ("Minha aposta"). Diferente do cashoutCapture
// (scanner automático bússola × alvo sobre TODOS os eventos), aqui só rastreamos os
// poucos eventos que o usuário tem aposta ABERTA. Como são poucos, cabe busca dirigida
// AO VIVO — inclusive a Betano por navegador (1 evento por vez).
//
// A cada ciclo, por aposta: (1) prob JUSTA ao vivo da bússola (Pinnacle) e (2) odd ao
// vivo da MESMA seleção na casa; roda estimateCashout (valor justo + oferta estimada da
// casa + hedge) e persiste em cashout_user_bets.last_*. Alerta no WhatsApp (grupo de
// cashout, mesmo do cashoutNotifier) quando o sinal de "hora de sacar" dispara — com
// cooldown por aposta.

import {
  estimateCashout,
  CASHOUT_ESTIMATE_CONFIG,
  type CashoutEstimateConfig,
  type CashoutSelection,
} from './cashoutEngine';
import { justaAoVivo, oddCasaAoVivo, casaTemFonteLive, type ApostaRef } from './cashoutSources';
import { listUserBets, updateUserBetEval, type UserBetEval } from './cashoutRepo';
import { cashoutNotifier } from './cashoutNotifier';

function envNum(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

function brl(v: number): string {
  return `R$ ${v.toFixed(2)}`;
}

export class CashoutBetMonitorService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private intervalSeconds = 30;
  private cfg: CashoutEstimateConfig = CASHOUT_ESTIMATE_CONFIG;
  private cooldownMs = 30 * 60_000;
  private moveThr = 0.05;              // variação da odd justa p/ avisar movimento
  private moveCooldownMs = 4 * 60_000; // intervalo mínimo entre avisos de movimento por aposta
  private lastAlertAt = new Map<string, number>();                       // betId → ms do último alerta de SAQUE
  private lastNotify = new Map<string, { fairOdd: number; at: number }>(); // betId → baseline do último aviso (movimento/saque)
  private lastSummary = { at: 0, avaliadas: 0, comJusta: 0, sinais: 0 };

  isEnabled(): boolean {
    return (process.env.CASHOUT_BET_MONITOR_ENABLED || 'true').toLowerCase() !== 'false';
  }

  status() {
    return {
      enabled: this.isEnabled(),
      running: !!this.intervalId,
      intervalSeconds: this.intervalSeconds,
      lastCycle: this.lastSummary,
    };
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) {
      console.log('ℹ️ [Cashout/Bets] Monitor por-aposta desabilitado (CASHOUT_BET_MONITOR_ENABLED=false).');
      return;
    }
    if (this.intervalId) return;
    this.intervalSeconds = Math.max(15, parseInt(process.env.CASHOUT_BET_INTERVAL_SECONDS || '30', 10) || 30);
    this.cfg = {
      houseMargin: envNum('CASHOUT_HOUSE_MARGIN', CASHOUT_ESTIMATE_CONFIG.houseMargin),
      signalDropPct: envNum('CASHOUT_SIGNAL_DROP_PCT', CASHOUT_ESTIMATE_CONFIG.signalDropPct),
    };
    const min = parseInt(process.env.CASHOUT_ALERT_COOLDOWN_MINUTES || '30', 10);
    this.cooldownMs = (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
    this.moveThr = envNum('CASHOUT_BET_MOVE_ALERT_PCT', 0.05);
    const moveMin = parseInt(process.env.CASHOUT_BET_MOVE_COOLDOWN_MINUTES || '4', 10);
    this.moveCooldownMs = (Number.isFinite(moveMin) && moveMin > 0 ? moveMin : 4) * 60_000;

    console.log(
      `💰 [Cashout/Bets] Monitor por-aposta iniciado. Intervalo: ${this.intervalSeconds}s | ` +
        `haircut casa: ${(this.cfg.houseMargin * 100).toFixed(0)}% | sinal de saque: odd caiu ≥ ${(this.cfg.signalDropPct * 100).toFixed(0)}% | ` +
        `aviso de movimento: ≥ ${(this.moveThr * 100).toFixed(0)}% (cooldown ${Math.round(this.moveCooldownMs / 60000)}min)`
    );
    setTimeout(() => this.cycle(), 20_000); // respiro pós-boot (depois do cashoutCapture)
    this.intervalId = setInterval(() => this.cycle(), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 [Cashout/Bets] Monitor por-aposta parado.');
    }
  }

  /**
   * Avalia UMA aposta ao vivo e persiste o resultado. `alertar` controla os avisos no
   * WhatsApp (o ciclo passa true; o endpoint "monitorar" sob demanda passa false p/ não
   * spammar). Exportado p/ o endpoint "monitorar".
   */
  async avaliarAposta(bet: any, nowMs = Date.now(), alertar = true): Promise<UserBetEval> {
    const ref: ApostaRef = {
      event_label: bet.event_label,
      sport: bet.sport,
      market_label: bet.market_label,
      selection: bet.selection as CashoutSelection,
      line: bet.line == null ? null : Number(bet.line),
    };
    const oddEntrada = Number(bet.odd_entrada);
    const stake = bet.stake == null ? 0 : Number(bet.stake);

    const base: UserBetEval = {
      last_fair_prob: null, last_fair_odd: null, last_house_odd: null,
      last_cashout_value: null, last_profit: null, last_drop_pct: null,
      last_signal: null, last_note: null, last_eval_at: new Date(nowMs).toISOString(),
    };

    const justa = await justaAoVivo(ref).catch(() => null);
    if (!justa) {
      base.last_note = 'Bússola (Pinnacle) sem o evento ao vivo agora, ou mercado de 3 vias (futebol 1X2) ainda não suportado no cálculo.';
      await updateUserBetEval(bet.id, base);
      return base;
    }

    const casa = await oddCasaAoVivo(ref, bet.casa).catch(() => null);
    const est = estimateCashout(
      {
        stake,
        oddEntrada,
        fairProbNow: justa.fairProb,
        oddCasaNow: casa?.odd ?? null,
        oddOpostoNow: casa?.oddOposto ?? justa.oddOposto ?? null,
      },
      this.cfg
    );

    const evalRow: UserBetEval = {
      last_fair_prob: round(justa.fairProb, 6),
      last_fair_odd: round(justa.fairOdd, 3),
      last_house_odd: casa?.odd != null ? round(casa.odd, 3) : null,
      // Valor/lucro PRIMÁRIOS = base na JUSTA (Pinnacle), NÃO na odd da casa: a casa
      // pode estar defasada/enviesada e nem sempre temos a odd dela ao vivo (Superbet/
      // Betano). A oferta estimada da casa (est.houseCashout) entra só como referência
      // nos alertas. Assim o valor reflete a linha afiada, não a recreativa.
      last_cashout_value: round(est.fairValue, 2),
      last_profit: round(est.fairProfit, 2),
      last_drop_pct: round(est.dropPctSinceEntry, 4),
      last_signal: est.sacarAgora,
      last_note: casa
        ? null
        : casaTemFonteLive(bet.casa)
          ? `Odd da ${bet.casa} indisponível ao vivo agora — mostrando o valor JUSTO (bússola).`
          : `${bet.casa} não tem odd ao vivo integrada — valor JUSTO (bússola) apenas.`,
      last_eval_at: new Date(nowMs).toISOString(),
    };
    await updateUserBetEval(bet.id, evalRow);

    if (alertar) {
      await this.processarAlertas(bet, est, oddEntrada, stake, nowMs);
    }
    return evalRow;
  }

  /**
   * Decide os avisos no WhatsApp: (1) "hora de SACAR" tem prioridade e cooldown longo;
   * (2) senão, avisa MOVIMENTO (odd justa subiu/caiu) quando variou ≥ moveThr desde o
   * último aviso, com cooldown curto. A 1ª avaliação só registra a baseline (sem avisar).
   */
  private async processarAlertas(bet: any, est: ReturnType<typeof estimateCashout>, oddEntrada: number, stake: number, nowMs: number): Promise<void> {
    if (!cashoutNotifier.isConfigured() || !est.valida) return;

    if (est.sacarAgora) {
      const last = this.lastAlertAt.get(bet.id);
      if (last && nowMs - last < this.cooldownMs) return;
      const ok = await this.enviarSacar(bet, est, oddEntrada, stake);
      if (ok) { this.lastAlertAt.set(bet.id, nowMs); this.lastNotify.set(bet.id, { fairOdd: est.fairOddNow, at: nowMs }); }
      return;
    }

    const prev = this.lastNotify.get(bet.id);
    if (!prev) { this.lastNotify.set(bet.id, { fairOdd: est.fairOddNow, at: nowMs }); return; } // baseline
    const move = Math.abs(est.fairOddNow - prev.fairOdd) / prev.fairOdd;
    if (move >= this.moveThr && nowMs - prev.at >= this.moveCooldownMs) {
      const ok = await this.enviarMovimento(bet, est, oddEntrada, stake, prev.fairOdd);
      if (ok) this.lastNotify.set(bet.id, { fairOdd: est.fairOddNow, at: nowMs });
    }
  }

  private async enviarSacar(bet: any, est: ReturnType<typeof estimateCashout>, oddEntrada: number, stake: number): Promise<boolean> {
    const drop = (est.dropPctSinceEntry * 100).toFixed(1);
    const linhas = [
      '💰 *CASHOUT: hora de sacar* 💰',
      '',
      `🏆 *${bet.event_label}*`,
      `🎯 ${bet.market_label} → *${bet.selection_label || bet.selection}*  (${bet.casa})`,
      `🟢 Entrada: *${oddEntrada.toFixed(2)}* → justa agora: *${est.fairOddNow.toFixed(2)}* (odd caiu ${drop}%)`,
    ];
    if (stake > 0) {
      linhas.push(`💵 Valor JUSTO (Pinnacle): *${brl(est.fairValue)}* (lucro ~${brl(est.fairProfit)})`);
      if (est.houseCashout != null) {
        linhas.push(`🏠 Oferta estimada ${bet.casa}: ~${brl(est.houseCashout)}${est.houseCashout < est.fairValue ? ' — *abaixo do justo* (segure/hedge)' : ''}`);
      }
    }
    if (est.hedge && est.hedge.lucroTravado > 0) {
      linhas.push(`🧮 Ou trave por hedge: banque *${brl(est.hedge.stakeHedge)}* no lado oposto @ ${est.hedge.oddOposto.toFixed(2)} (lucro garantido ~${brl(est.hedge.lucroTravado)})`);
    }
    linhas.push('', '⚡ _A odd afiada caiu desde a sua entrada — sua aposta ganhou valor. Considere sacar/hedgear antes de reverter._');
    return cashoutNotifier.avisarTexto(linhas.join('\n'));
  }

  private async enviarMovimento(bet: any, est: ReturnType<typeof estimateCashout>, oddEntrada: number, stake: number, fairOddPrev: number): Promise<boolean> {
    const subiu = est.fairOddNow > fairOddPrev; // odd SOBE = seleção menos provável = posição perde valor
    const linhas = [
      `${subiu ? '📈' : '📉'} *Cashout — odd ${subiu ? 'subiu' : 'caiu'}*`,
      '',
      `🏆 *${bet.event_label}*`,
      `🎯 ${bet.market_label} → *${bet.selection_label || bet.selection}*  (${bet.casa})`,
      `🧭 Justa: ${fairOddPrev.toFixed(2)} → *${est.fairOddNow.toFixed(2)}*  (entrada ${oddEntrada.toFixed(2)})`,
    ];
    if (stake > 0) {
      linhas.push(`💵 Valor JUSTO (Pinnacle): *${brl(est.fairValue)}* (${est.fairProfit >= 0 ? '+' : ''}${brl(est.fairProfit)})`);
      if (est.houseCashout != null) linhas.push(`🏠 Oferta estimada ${bet.casa}: ~${brl(est.houseCashout)}`);
    }
    linhas.push('', subiu ? '⚠️ _Sua posição perdeu valor._' : '✅ _Sua posição ganhou valor — de olho no saque._');
    return cashoutNotifier.avisarTexto(linhas.join('\n'));
  }

  private async cycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    const nowMs = Date.now();
    try {
      const bets = await listUserBets(['open']);
      let comJusta = 0;
      let sinais = 0;
      for (const bet of bets) {
        try {
          const ev = await this.avaliarAposta(bet, nowMs);
          if (ev.last_fair_prob != null) comJusta++;
          if (ev.last_signal) sinais++;
        } catch (err: any) {
          console.warn(`[Cashout/Bets] avaliação da aposta ${bet.id} falhou:`, err?.message);
        }
      }
      this.lastSummary = { at: nowMs, avaliadas: bets.length, comJusta, sinais };
      if (bets.length) {
        console.log(`💰 [Cashout/Bets] ciclo: ${bets.length} aposta(s), ${comJusta} com justa ao vivo, ${sinais} sinal(is) de saque.`);
      }
    } catch (err: any) {
      console.error('❌ [Cashout/Bets] erro no ciclo:', err?.message);
    } finally {
      this.isRunning = false;
    }
  }
}

function round(v: number, casas: number): number {
  const f = Math.pow(10, casas);
  return Math.round(v * f) / f;
}

export const cashoutBetMonitor = new CashoutBetMonitorService();
