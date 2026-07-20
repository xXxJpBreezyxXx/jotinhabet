// cashoutCapture.ts
// Worker do Radar Cashout: a cada ciclo puxa a BÚSSOLA (Pinnacle) e as casas ALVO
// (leves, por API), casa evento/mercado/seleção, grava a série temporal de odds e roda
// o motor pra detectar cotação desregulada (Dropping Odds).
//
// CADÊNCIA: default 60s (não os 5-10s da spec) — a VPS é 1-core, com ~10 stacks e swap
// no limite; um ciclo puxa a bússola + N alvos, então cadência curta demais estoura a
// memória (incidente 20/07: build durante captura 30s levou o load a 186). A 60s a
// janela de 15min ainda tem ~15 pontos, sobra pra regressão. Tudo configurável por env
// (CASHOUT_*) e o worker degrada em silêncio se a bússola vier vazia. Ver deploy-swarm-vps.

import { OddsScraper, ScrapedOdd } from '../scraping/scraper_base';
import { PinnacleScraper } from '../scraping/casa_pinnacle';
import { SuperbetScraper } from '../scraping/casa_superbet';
import { KtoScraper, BetWarriorScraper } from '../scraping/casa_kambi';
import { BetBoomScraper } from '../scraping/casa_betboom';
import { EsportesDaSorteScraper } from '../scraping/casa_esportesdasorte';
import { Aposta1Scraper } from '../scraping/casa_altenar';
import { areEventsSame, splitEvento, parseKickoff } from '../arbitrage/matcher';
import { normalizarMercado, mesmaOferta } from '../arbitrage/markets';
import {
  CASHOUT_CONFIG,
  devig2Way,
  evaluateCompassTrend,
  detectOpportunity,
  estimateTTL,
  type OddPoint,
  type CashoutSelection,
} from './cashoutEngine';
import { marketKind, eventKey, alignOdd } from './cashoutMatch';
import { cashoutNotifier } from './cashoutNotifier';
import {
  ensureBookmakers,
  upsertEvent,
  insertSnapshots,
  upsertOpportunities,
  expireOldOpportunities,
  type BookmakerRow,
  type SnapshotRow,
  type OpportunityRow,
} from './cashoutRepo';

const COMPASS_NAME = 'Pinnacle';

// Alvos leves por API disponíveis (todos sem Playwright). Configurável por CASHOUT_TARGETS.
const TARGET_FACTORY: Record<string, () => OddsScraper> = {
  Superbet: () => new SuperbetScraper(),
  KTO: () => new KtoScraper(),
  BetWarrior: () => new BetWarriorScraper(),
  BetBoom: () => new BetBoomScraper(),
  EsportesDaSorte: () => new EsportesDaSorteScraper(),
  Aposta1: () => new Aposta1Scraper(),
};

function envList(name: string, fallback: string[]): string[] {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function selectionLabel(sel: CashoutSelection, home: string, away: string, linha: number | null): string {
  if (sel === 'over') return linha != null ? `Mais de ${linha}` : 'Mais';
  if (sel === 'under') return linha != null ? `Menos de ${linha}` : 'Menos';
  if (sel === 'draw') return 'Empate';
  const base = sel === 'home' ? home : away;
  return linha != null ? `${base} (${linha > 0 ? '+' : ''}${linha})` : base;
}

export class CashoutCaptureService {
  private compass = new PinnacleScraper();
  private targets: OddsScraper[] = [];
  private sports: string[] = [];
  private intervalSeconds = 60;
  private bookmakers = new Map<string, BookmakerRow>();

  // key = `${event_key}|${selection}` → série temporal da prob JUSTA da bússola.
  private history = new Map<string, OddPoint[]>();
  // key = `${event_key}|${selection}|${targetName}` → ms em que a oportunidade foi confirmada.
  private trendConfirmedAt = new Map<string, number>();
  // event_key → event_id (evita upsert do evento a cada ciclo).
  private eventIdCache = new Map<string, string>();

  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastSummary = { at: 0, snapshots: 0, opportunities: 0, compassOdds: 0 };

  isEnabled(): boolean {
    return (process.env.CASHOUT_CAPTURE_ENABLED || 'true').toLowerCase() !== 'false';
  }

  status() {
    return {
      enabled: this.isEnabled(),
      running: !!this.intervalId,
      intervalSeconds: this.intervalSeconds,
      sports: this.sports,
      targets: this.targets.map((t) => t.getNome()),
      compass: COMPASS_NAME,
      minConfirmingSources: CASHOUT_CONFIG.minConfirmingSources,
      whatsappConfigurado: cashoutNotifier.isConfigured(),
      lastCycle: this.lastSummary,
      trackedSeries: this.history.size,
    };
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) {
      console.log('ℹ️ [Cashout] Captura desabilitada (CASHOUT_CAPTURE_ENABLED=false).');
      return;
    }
    if (this.intervalId) return;

    this.intervalSeconds = Math.max(10, parseInt(process.env.CASHOUT_INTERVAL_SECONDS || '60', 10) || 60);
    this.sports = envList('CASHOUT_SPORTS', ['Futebol', 'Basquete', 'Tenis']);
    const targetNames = envList('CASHOUT_TARGETS', ['Superbet', 'KTO', 'BetWarrior', 'BetBoom', 'EsportesDaSorte']);
    this.targets = targetNames
      .filter((n) => TARGET_FACTORY[n])
      .map((n) => TARGET_FACTORY[n]());

    this.bookmakers = await ensureBookmakers([COMPASS_NAME], this.targets.map((t) => t.getNome()));

    console.log(
      `🎯 [Cashout] Captura iniciada. Intervalo: ${this.intervalSeconds}s | Bússola: ${COMPASS_NAME} | ` +
        `Alvos: ${this.targets.map((t) => t.getNome()).join(', ')} | Esportes: ${this.sports.join(', ')}`
    );

    // Primeiro ciclo depois de um respiro (não competir com o boot do scanner).
    setTimeout(() => this.cycle(), 15_000);
    this.intervalId = setInterval(() => this.cycle(), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 [Cashout] Captura parada.');
    }
  }

  private async cycle(): Promise<void> {
    if (this.isRunning) return; // ciclo anterior ainda rodando — pula
    this.isRunning = true;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffSec = nowMs / 1000 - CASHOUT_CONFIG.windowMinutes * 60;

    try {
      const datas = ['Hoje'];
      // 1) BÚSSOLA
      const compassOdds = await this.compass
        .executarCrawler(this.sports, datas, true)
        .catch((e: any) => {
          console.warn('[Cashout] bússola falhou:', e?.message);
          return [] as ScrapedOdd[];
        });
      if (!compassOdds.length) {
        console.log('[Cashout] ciclo sem odds da bússola (túnel Tailscale caiu?). Pulando.');
        return;
      }

      // 2) ALVOS (sequencial — poupa a VPS 1-core), indexados por oferta.
      const targetIndex = new Map<string, Map<string, ScrapedOdd[]>>(); // targetName → offerKey → odds
      for (const t of this.targets) {
        const odds = await t.executarCrawler(this.sports, datas, true).catch(() => [] as ScrapedOdd[]);
        const byOffer = new Map<string, ScrapedOdd[]>();
        for (const o of odds) {
          const mkt = normalizarMercado(o.mercado);
          if (mkt === 'DESCONHECIDO') continue;
          const k = `${mkt}|${o.linha ?? ''}`;
          (byOffer.get(k) || byOffer.set(k, []).get(k)!).push(o);
        }
        targetIndex.set(t.getNome(), byOffer);
      }

      const snapshots: SnapshotRow[] = [];
      const opps: OpportunityRow[] = [];
      const compassRow = this.bookmakers.get(COMPASS_NAME);
      if (!compassRow) {
        console.warn('[Cashout] bookmaker da bússola ausente — abortando ciclo.');
        return;
      }

      // 3) Para cada odd da bússola alinhável, grava snapshot + histórico e cruza os alvos.
      for (const c of compassOdds) {
        if (marketKind(c.mercado) === 'OUTRO') continue;
        const split = splitEvento(c.evento);
        if (!split) continue;
        const [homeC, awayC] = split;
        const legsC = alignOdd(c, homeC, awayC);
        if (!legsC) continue;
        const devig = devig2Way(c.oddA, c.oddB);
        if (!devig) continue;

        const mktNorm = normalizarMercado(c.mercado);
        const linha = c.linha ?? null;
        const ek = eventKey(c.esporte, homeC, awayC, c.mercado, linha);

        // event_id (cache → upsert só na 1ª vez)
        let eventId = this.eventIdCache.get(ek);
        if (!eventId) {
          const kickoff = parseKickoff(c.dataHora);
          const id = await upsertEvent({
            event_key: ek,
            sport: c.esporte,
            home_team: homeC,
            away_team: awayC,
            market: mktNorm,
            starts_at: kickoff ? new Date(kickoff).toISOString() : null,
          });
          if (!id) continue;
          eventId = id;
          this.eventIdCache.set(ek, id);
        }

        // prob justa por seleção (legsC[0]↔oddA↔probA, legsC[1]↔oddB↔probB)
        const fairBySel: Partial<Record<CashoutSelection, number>> = {
          [legsC[0].selection]: devig.probA,
          [legsC[1].selection]: devig.probB,
        };

        for (const leg of legsC) {
          snapshots.push({
            event_id: eventId, bookmaker_id: compassRow.id, selection: leg.selection,
            line: linha, odd_value: leg.odd, captured_at: nowIso,
          });
          const hk = `${ek}|${leg.selection}`;
          const arr = (this.history.get(hk) || []).filter((p) => p.tSeconds >= cutoffSec);
          arr.push({ tSeconds: nowMs / 1000, fairProb: fairBySel[leg.selection]! });
          this.history.set(hk, arr);
        }

        // 4) Cruza cada alvo p/ esta mesma oferta.
        const offerKey = `${mktNorm}|${c.linha ?? ''}`;
        const kickoffIso = parseKickoff(c.dataHora) ? new Date(parseKickoff(c.dataHora)!).toISOString() : null;
        for (const [name, byOffer] of targetIndex) {
          const tRow = this.bookmakers.get(name);
          if (!tRow) continue;
          const candidatos = byOffer.get(offerKey);
          if (!candidatos?.length) continue;
          const match = candidatos.find(
            (o) => areEventsSame(o.evento, c.evento) && mesmaOferta(o.mercado, o.linha, c.mercado, c.linha)
          );
          if (!match) continue;
          const legsT = alignOdd(match, homeC, awayC);
          if (!legsT) continue;

          for (const legT of legsT) {
            snapshots.push({
              event_id: eventId, bookmaker_id: tRow.id, selection: legT.selection,
              line: match.linha ?? null, odd_value: legT.odd, captured_at: nowIso,
            });

            const hist = this.history.get(`${ek}|${legT.selection}`) || [];
            const trend = evaluateCompassTrend(COMPASS_NAME, hist);
            const targetImplied = 1 / legT.odd;
            const det = detectOpportunity([trend], targetImplied);

            const tk = `${ek}|${legT.selection}|${name}`;
            if (!det.isOpportunity) {
              this.trendConfirmedAt.delete(tk);
              continue;
            }
            if (!this.trendConfirmedAt.has(tk)) this.trendConfirmedAt.set(tk, nowMs);
            const secsSince = (nowMs - this.trendConfirmedAt.get(tk)!) / 1000;
            const ttl = estimateTTL(tRow.avg_update_latency_seconds, secsSince);
            const graceMs = Math.max(ttl * 1000, this.intervalSeconds * 2 * 1000 + 15_000);

            opps.push({
              signature: tk,
              event_id: eventId,
              selection: legT.selection,
              line: match.linha ?? null,
              target_bookmaker_id: tRow.id,
              fair_probability: det.consensusFairProbability,
              target_odd_value: legT.odd,
              target_implied_prob: targetImplied,
              gap_pct: det.gapPct,
              slope: trend.slope,
              r_squared: trend.rSquared,
              confirming_sources: det.confirmingSources,
              ttl_estimated_seconds: Math.round(ttl),
              expires_at: new Date(nowMs + graceMs).toISOString(),
              event_label: `${homeC} vs ${awayC}`,
              sport: c.esporte,
              market_label: c.mercado,
              selection_label: selectionLabel(legT.selection, homeC, awayC, match.linha ?? null),
              target_name: name,
              compass_fair_odd: det.consensusFairProbability > 0 ? 1 / det.consensusFairProbability : 0,
              starts_at: kickoffIso,
            });
          }
        }
      }

      // 5) Persiste.
      await insertSnapshots(snapshots);
      await expireOldOpportunities(nowIso);
      await upsertOpportunities(opps);

      // 6) Alerta no WhatsApp (grupo de cashout) — as mais "gordas" primeiro, com teto
      //    por ciclo; o cooldown por assinatura evita reenviar a mesma a cada ciclo.
      if (opps.length && cashoutNotifier.isConfigured()) {
        const maxPorCiclo = Math.max(1, parseInt(process.env.CASHOUT_ALERT_MAX_PER_CYCLE || '8', 10) || 8);
        const ordenadas = [...opps].sort((a, b) => b.gap_pct - a.gap_pct).slice(0, maxPorCiclo);
        let enviadas = 0;
        for (const o of ordenadas) {
          if (await cashoutNotifier.alertar(o, nowMs)) enviadas++;
        }
        if (enviadas) console.log(`📲 [Cashout] ${enviadas} alerta(s) enviado(s) ao WhatsApp.`);
      }

      // Limpeza de séries órfãs (evento que a bússola parou de ver).
      for (const [k, arr] of this.history) {
        const viva = arr.filter((p) => p.tSeconds >= cutoffSec);
        if (viva.length === 0) this.history.delete(k);
        else this.history.set(k, viva);
      }

      this.lastSummary = {
        at: nowMs, snapshots: snapshots.length, opportunities: opps.length, compassOdds: compassOdds.length,
      };
      console.log(
        `🎯 [Cashout] ciclo: ${compassOdds.length} odds bússola, ${snapshots.length} snapshots, ` +
          `${opps.length} oportunidades ativas, ${this.history.size} séries em janela.`
      );
    } catch (err: any) {
      console.error('❌ [Cashout] erro no ciclo:', err?.message);
    } finally {
      this.isRunning = false;
    }
  }
}

export const cashoutCapture = new CashoutCaptureService();
