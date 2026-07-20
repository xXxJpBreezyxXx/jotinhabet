// cashoutCapture.ts
// Worker do Radar Cashout: a cada ciclo puxa as BÚSSOLAS (linha afiada: Pinnacle, e
// futuramente Betfair/1xBet/Stake) e as casas ALVO (leves, por API), casa
// evento/mercado/seleção, grava a série temporal de odds e roda o motor pra detectar
// cotação desregulada (Dropping Odds).
//
// MULTI-BÚSSOLA: cada bússola contribui com uma tendência independente; o motor exige
// consenso (>= minConfirmingSources caindo). Isso dá REDUNDÂNCIA — quando uma fonte cai
// (ex.: a Pinnacle quando o exit node Tailscale do celular sai do ar), as outras seguram
// o módulo. Histórico é por casa: `${event_key}|${casa}|${selecao}`.
//
// CADÊNCIA: default 60s (não os 5-10s da spec) — a VPS é 1-core, ~10 stacks e swap no
// limite; cadência curta demais estoura a memória (incidente 20/07: build durante captura
// 30s levou o load a 186). A 60s a janela de 15min tem ~15 pontos, sobra pra regressão.
// APENAS bússolas LEVES (API) devem entrar no loop; Playwright (1xBet/Stake) só com mais
// RAM. Tudo configurável por env (CASHOUT_*). Ver deploy-swarm-vps e pinnacle-asn-bloqueio.

import { OddsScraper, ScrapedOdd } from '../scraping/scraper_base';
import { PinnacleScraper } from '../scraping/casa_pinnacle';
import { OneXBetScraper } from '../scraping/casa_1xbet';
import { StakeScraper } from '../scraping/casa_stake';
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
  type CompassTrend,
  type OddPoint,
  type CashoutSelection,
} from './cashoutEngine';
import { marketKind, eventKey, alignOdd, mercadoElegivel } from './cashoutMatch';
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

// Bússolas disponíveis (linha afiada). `heavy` = Playwright (navegador) → puxada com
// throttle (a cada CASHOUT_HEAVY_EVERY_N ciclos) pra não saturar a CPU de 1 core.
// Pinnacle é leve (API); 1xBet/Stake são pesadas (Chromium) — só habilitar com RAM livre.
const COMPASS_FACTORY: Record<string, { heavy: boolean; make: () => OddsScraper }> = {
  Pinnacle: { heavy: false, make: () => new PinnacleScraper() },
  '1xBet': { heavy: true, make: () => new OneXBetScraper() },
  Stake: { heavy: true, make: () => new StakeScraper() },
  // Betfair: { heavy: false, make: () => new BetfairScraper() },
};

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

/** Instância de mercado (partida+mercado+linha) vista neste ciclo, com orientação canônica. */
interface EventRef {
  ek: string;
  eventId: string;
  canonHome: string;
  canonAway: string;
  evento: string;       // representativo p/ areEventsSame com os alvos
  offerKey: string;     // `${mktNorm}|${linha}`
  sport: string;
  marketLabel: string;
  linha: number | null;
  startsAtIso: string | null;
}

export class CashoutCaptureService {
  private compasses: Array<{ scraper: OddsScraper; name: string; heavy: boolean }> = [];
  private targets: OddsScraper[] = [];
  private sports: string[] = [];
  private intervalSeconds = 60;
  private heavyEveryN = 4;   // bússola pesada (Playwright) puxada a cada N ciclos
  private cycleCount = 0;
  private bookmakers = new Map<string, BookmakerRow>();

  // key = `${event_key}|${casa}|${selection}` → série temporal da prob JUSTA daquela bússola.
  private history = new Map<string, OddPoint[]>();
  // key = `${event_key}|${selection}|${targetName}` → ms em que a oportunidade foi confirmada.
  private trendConfirmedAt = new Map<string, number>();
  // event_key → { id, orientação canônica } (evita upsert a cada ciclo + alinha todas as casas).
  private eventCache = new Map<string, { id: string; home: string; away: string }>();

  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastSummary = { at: 0, snapshots: 0, opportunities: 0, compassOdds: 0 };
  private lastFunnel: any = null;

  isEnabled(): boolean {
    return (process.env.CASHOUT_CAPTURE_ENABLED || 'true').toLowerCase() !== 'false';
  }

  status() {
    const nomes = this.compasses.map((c) => c.name);
    return {
      enabled: this.isEnabled(),
      running: !!this.intervalId,
      intervalSeconds: this.intervalSeconds,
      heavyEveryN: this.heavyEveryN,
      sports: this.sports,
      targets: this.targets.map((t) => t.getNome()),
      compass: nomes.join(', '),   // compat: o frontend lê `compass` como string
      compasses: nomes,
      minConfirmingSources: CASHOUT_CONFIG.minConfirmingSources,
      whatsappConfigurado: cashoutNotifier.isConfigured(),
      lastCycle: this.lastSummary,
      lastFunnel: this.lastFunnel,
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
    this.heavyEveryN = Math.max(1, parseInt(process.env.CASHOUT_HEAVY_EVERY_N || '4', 10) || 4);
    this.sports = envList('CASHOUT_SPORTS', ['Futebol', 'Basquete', 'Tenis']);

    const compassNames = envList('CASHOUT_COMPASS', ['Pinnacle']).filter((n) => COMPASS_FACTORY[n]);
    this.compasses = (compassNames.length ? compassNames : ['Pinnacle']).map((n) => ({
      scraper: COMPASS_FACTORY[n].make(), name: n, heavy: COMPASS_FACTORY[n].heavy,
    }));

    const targetNames = envList('CASHOUT_TARGETS', ['Superbet', 'KTO', 'BetWarrior', 'BetBoom', 'EsportesDaSorte']);
    this.targets = targetNames.filter((n) => TARGET_FACTORY[n]).map((n) => TARGET_FACTORY[n]());

    this.bookmakers = await ensureBookmakers(
      this.compasses.map((c) => c.name),
      this.targets.map((t) => t.getNome())
    );

    const heavies = this.compasses.filter((c) => c.heavy).map((c) => c.name);
    console.log(
      `🎯 [Cashout] Captura iniciada. Intervalo: ${this.intervalSeconds}s | Bússolas: ` +
        `${this.compasses.map((c) => c.name).join(', ')}${heavies.length ? ` (pesadas ${heavies.join(',')} a cada ${this.heavyEveryN} ciclos)` : ''} | ` +
        `Alvos: ${this.targets.map((t) => t.getNome()).join(', ')} | Esportes: ${this.sports.join(', ')}`
    );

    setTimeout(() => this.cycle(), 15_000); // respiro pós-boot
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
    this.cycleCount++;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffSec = nowMs / 1000 - CASHOUT_CONFIG.windowMinutes * 60;

    try {
      const datas = ['Hoje'];

      // 1) BÚSSOLAS (sequencial — poupa a VPS). Cada uma pode falhar sem derrubar o ciclo.
      //    Bússola PESADA (Playwright) só é puxada a cada heavyEveryN ciclos; nos demais,
      //    sua série persiste do último pull (dentro da janela) e ainda entra no consenso.
      const compassReadings: Array<{ name: string; row: BookmakerRow; odds: ScrapedOdd[] }> = [];
      let totalCompassOdds = 0;
      for (const { scraper, name, heavy } of this.compasses) {
        if (heavy && this.cycleCount % this.heavyEveryN !== 0) continue; // throttle
        const row = this.bookmakers.get(name);
        if (!row) continue;
        const odds = await scraper.executarCrawler(this.sports, datas, true).catch((e: any) => {
          console.warn(`[Cashout] bússola ${name} falhou:`, e?.message);
          return [] as ScrapedOdd[];
        });
        totalCompassOdds += odds.length;
        if (odds.length) compassReadings.push({ name, row, odds });
      }
      if (!compassReadings.length) {
        console.log('[Cashout] ciclo sem odds de NENHUMA bússola (Pinnacle: túnel Tailscale caiu?). Pulando.');
        this.lastSummary = { at: nowMs, snapshots: 0, opportunities: 0, compassOdds: 0 };
        return;
      }

      // 2) ALVOS (sequencial), indexados por oferta (`${mktNorm}|${linha}`).
      const targetIndex = new Map<string, Map<string, ScrapedOdd[]>>(); // targetName → offerKey → odds
      for (const t of this.targets) {
        const odds = await t.executarCrawler(this.sports, datas, true).catch(() => [] as ScrapedOdd[]);
        const byOffer = new Map<string, ScrapedOdd[]>();
        for (const o of odds) {
          if (!mercadoElegivel(o.mercado)) continue; // exclui GERAL/DESCONHECIDO
          const mkt = normalizarMercado(o.mercado);
          const k = `${mkt}|${o.linha ?? ''}`;
          (byOffer.get(k) || byOffer.set(k, []).get(k)!).push(o);
        }
        targetIndex.set(t.getNome(), byOffer);
      }

      const snapshots: SnapshotRow[] = [];
      const eventsThisCycle = new Map<string, EventRef>(); // ek → EventRef

      // 3) FASE A — processa as bússolas: cria/orienta o evento, grava snapshot da bússola
      //    e alimenta o histórico por casa (prob justa de-vigged por seleção).
      for (const { name, row, odds } of compassReadings) {
        for (const c of odds) {
          if (marketKind(c.mercado) === 'OUTRO' || !mercadoElegivel(c.mercado)) continue;
          const split = splitEvento(c.evento);
          if (!split) continue;
          const [ownHome, ownAway] = split;
          const devig = devig2Way(c.oddA, c.oddB);
          if (!devig) continue;

          const mktNorm = normalizarMercado(c.mercado);
          const linha = c.linha ?? null;
          const ek = eventKey(c.esporte, ownHome, ownAway, c.mercado, linha);

          // Orientação canônica: a 1ª bússola que vê o evento a define; as demais alinham nela.
          let cached = this.eventCache.get(ek);
          if (!cached) {
            const kickoff = parseKickoff(c.dataHora);
            const id = await upsertEvent({
              event_key: ek, sport: c.esporte, home_team: ownHome, away_team: ownAway,
              market: mktNorm, starts_at: kickoff ? new Date(kickoff).toISOString() : null,
            });
            if (!id) continue;
            cached = { id, home: ownHome, away: ownAway };
            this.eventCache.set(ek, cached);
          }

          const legs = alignOdd(c, cached.home, cached.away);
          if (!legs) continue;
          const fairBySel: Partial<Record<CashoutSelection, number>> = {
            [legs[0].selection]: devig.probA,
            [legs[1].selection]: devig.probB,
          };

          for (const leg of legs) {
            snapshots.push({
              event_id: cached.id, bookmaker_id: row.id, selection: leg.selection,
              line: linha, odd_value: leg.odd, captured_at: nowIso,
            });
            const hk = `${ek}|${name}|${leg.selection}`;
            const arr = (this.history.get(hk) || []).filter((p) => p.tSeconds >= cutoffSec);
            arr.push({ tSeconds: nowMs / 1000, fairProb: fairBySel[leg.selection]! });
            this.history.set(hk, arr);
          }

          if (!eventsThisCycle.has(ek)) {
            const kickoff = parseKickoff(c.dataHora);
            eventsThisCycle.set(ek, {
              ek, eventId: cached.id, canonHome: cached.home, canonAway: cached.away,
              evento: `${cached.home} vs ${cached.away}`,
              offerKey: `${mktNorm}|${c.linha ?? ''}`, sport: c.esporte, marketLabel: c.mercado,
              linha, startsAtIso: kickoff ? new Date(kickoff).toISOString() : null,
            });
          }
        }
      }

      // 4) FASE B — para cada evento visto, cruza os alvos e roda o motor com o CONSENSO
      //    das bússolas (todas que têm série pra aquela seleção).
      const opps: OpportunityRow[] = [];
      const compassNames = this.compasses.map((c) => c.name);
      // Diagnóstico do funil de detecção (por que dá 0 oportunidades): quantas
      // seleções foram avaliadas, quantas têm histórico suficiente p/ regressão,
      // quantas têm bússola "caindo", melhor R² e MAIOR gap visto (mesmo sem passar).
      const diag = { avaliadas: 0, comHist3: 0, comQueda: 0, acima: 0, maxR2: 0, maxGap: -Infinity, maxGapCaindo: -Infinity };
      for (const ev of eventsThisCycle.values()) {
        for (const [name, byOffer] of targetIndex) {
          const tRow = this.bookmakers.get(name);
          if (!tRow) continue;
          const candidatos = byOffer.get(ev.offerKey);
          if (!candidatos?.length) continue;
          const match = candidatos.find(
            (o) => areEventsSame(o.evento, ev.evento) && mesmaOferta(o.mercado, o.linha, ev.marketLabel, ev.linha)
          );
          if (!match) continue;
          const legsT = alignOdd(match, ev.canonHome, ev.canonAway);
          if (!legsT) continue;

          for (const legT of legsT) {
            snapshots.push({
              event_id: ev.eventId, bookmaker_id: tRow.id, selection: legT.selection,
              line: match.linha ?? null, odd_value: legT.odd, captured_at: nowIso,
            });

            // Consenso: uma tendência por bússola que tenha série pra esta seleção.
            const trends: CompassTrend[] = [];
            for (const cn of compassNames) {
              const hist = this.history.get(`${ev.ek}|${cn}|${legT.selection}`);
              if (hist && hist.length) trends.push(evaluateCompassTrend(cn, hist));
            }
            if (!trends.length) continue;

            const targetImplied = 1 / legT.odd;

            // --- funil (independe do resultado) ---
            diag.avaliadas++;
            if (trends.some((t) => t.sampleSize >= 3)) diag.comHist3++;
            const r2 = Math.max(...trends.map((t) => t.rSquared));
            if (r2 > diag.maxR2) diag.maxR2 = r2;
            const caindo = trends.filter((t) => t.oddDirection === 'dropping');
            if (caindo.length) diag.comQueda++;
            const validos = trends.filter((t) => t.sampleSize >= CASHOUT_CONFIG.minSampleSize);
            const meanFair = (validos.length ? validos : trends).reduce((s, t) => s + t.fairProbability, 0) / (validos.length || trends.length);
            const rawGap = (meanFair - targetImplied) / targetImplied;
            if (rawGap > diag.maxGap) diag.maxGap = rawGap;
            if (validos.length && rawGap >= CASHOUT_CONFIG.minGapPct) diag.acima++;
            if (caindo.length) {
              const mfc = caindo.reduce((s, t) => s + t.fairProbability, 0) / caindo.length;
              const gc = (mfc - targetImplied) / targetImplied;
              if (gc > diag.maxGapCaindo) diag.maxGapCaindo = gc;
            }
            // --------------------------------------

            const det = detectOpportunity(trends, targetImplied);

            const tk = `${ev.ek}|${legT.selection}|${name}`;
            if (!det.isOpportunity) {
              this.trendConfirmedAt.delete(tk);
              continue;
            }
            if (!this.trendConfirmedAt.has(tk)) this.trendConfirmedAt.set(tk, nowMs);
            const secsSince = (nowMs - this.trendConfirmedAt.get(tk)!) / 1000;
            const ttl = estimateTTL(tRow.avg_update_latency_seconds, secsSince);
            const graceMs = Math.max(ttl * 1000, this.intervalSeconds * 2 * 1000 + 15_000);
            // slope/R² exibidos = da bússola confirmadora mais forte (maior R²).
            const melhor = det.confirmingSources.length
              ? trends.filter((t) => det.confirmingSources.includes(t.bookmakerName)).sort((a, b) => b.rSquared - a.rSquared)[0]
              : trends[0];

            opps.push({
              signature: tk,
              event_id: ev.eventId,
              selection: legT.selection,
              line: match.linha ?? null,
              target_bookmaker_id: tRow.id,
              fair_probability: det.consensusFairProbability,
              target_odd_value: legT.odd,
              target_implied_prob: targetImplied,
              gap_pct: det.gapPct,
              slope: melhor?.slope ?? null,
              r_squared: melhor?.rSquared ?? null,
              confirming_sources: det.confirmingSources,
              ttl_estimated_seconds: Math.round(ttl),
              expires_at: new Date(nowMs + graceMs).toISOString(),
              event_label: ev.evento,
              sport: ev.sport,
              market_label: ev.marketLabel,
              selection_label: selectionLabel(legT.selection, ev.canonHome, ev.canonAway, match.linha ?? null),
              target_name: name,
              compass_fair_odd: det.consensusFairProbability > 0 ? 1 / det.consensusFairProbability : 0,
              starts_at: ev.startsAtIso,
            });
          }
        }
      }

      // Funil: por que N oportunidades? (calibração dos thresholds)
      const pct = (x: number) => (x === -Infinity ? 'n/a' : `${(x * 100).toFixed(1)}%`);
      this.lastFunnel = {
        avaliadas: diag.avaliadas, comHist3: diag.comHist3, acimaThreshold: diag.acima, comQueda: diag.comQueda,
        melhorR2: Number(diag.maxR2.toFixed(3)),
        maiorGapPct: diag.maxGap === -Infinity ? null : Number((diag.maxGap * 100).toFixed(2)),
      };
      console.log(
        `🔎 [Cashout] funil: avaliadas=${diag.avaliadas}, comHist≥3=${diag.comHist3}, ` +
          `acima${(CASHOUT_CONFIG.minGapPct * 100).toFixed(0)}%=${diag.acima}, comQueda(selo)=${diag.comQueda}, ` +
          `maiorGap=${pct(diag.maxGap)}, melhorR²=${diag.maxR2.toFixed(2)}`
      );

      // 5) Persiste.
      await insertSnapshots(snapshots);
      await expireOldOpportunities(nowIso);
      await upsertOpportunities(opps);

      // 6) Alerta no WhatsApp (grupo de cashout) — as mais "gordas" primeiro, com teto por
      //    ciclo; o cooldown por assinatura evita reenviar a mesma a cada ciclo.
      if (opps.length && cashoutNotifier.isConfigured()) {
        const maxPorCiclo = Math.max(1, parseInt(process.env.CASHOUT_ALERT_MAX_PER_CYCLE || '8', 10) || 8);
        const ordenadas = [...opps].sort((a, b) => b.gap_pct - a.gap_pct).slice(0, maxPorCiclo);
        let enviadas = 0;
        for (const o of ordenadas) {
          if (await cashoutNotifier.alertar(o, nowMs)) enviadas++;
        }
        if (enviadas) console.log(`📲 [Cashout] ${enviadas} alerta(s) enviado(s) ao WhatsApp.`);
      }

      // Limpeza de séries órfãs (evento que as bússolas pararam de ver).
      for (const [k, arr] of this.history) {
        const viva = arr.filter((p) => p.tSeconds >= cutoffSec);
        if (viva.length === 0) this.history.delete(k);
        else this.history.set(k, viva);
      }
      // Guarda contra vazamento do cache de eventos (dias de uptime): zera se crescer demais.
      if (this.eventCache.size > 50_000) this.eventCache.clear();

      this.lastSummary = {
        at: nowMs, snapshots: snapshots.length, opportunities: opps.length, compassOdds: totalCompassOdds,
      };
      console.log(
        `🎯 [Cashout] ciclo: ${totalCompassOdds} odds bússola (${compassReadings.map((r) => `${r.name}:${r.odds.length}`).join(', ')}), ` +
          `${snapshots.length} snapshots, ${opps.length} oportunidades, ${this.history.size} séries em janela.`
      );
    } catch (err: any) {
      console.error('❌ [Cashout] erro no ciclo:', err?.message);
    } finally {
      this.isRunning = false;
    }
  }
}

export const cashoutCapture = new CashoutCaptureService();
