// cashoutSources.ts
// Fontes AO VIVO (in-play) ISOLADAS do Radar Cashout. Constrói os scrapers com
// incluirAoVivo:true e faz busca DIRIGIDA (oddsDoEvento) de UM evento. NÃO passa pelo
// SCRAPER_FACTORY da revalidação de surebet (que é pré-jogo de propósito) — assim o
// scanner de surebets nunca vê odds ao vivo. Usado pelo monitor por-aposta e pelos
// endpoints de "monitorar".
//
// Escopo de fontes (decisão do usuário): bússola AO VIVO = Pinnacle; alvos com odd AO
// VIVO = KTO/BetWarrior (Kambi) e Betano (navegador, 1 evento por vez). Os demais alvos
// só têm pré-jogo — se a aposta for numa dessas casas, o valor JUSTO (bússola) ainda é
// calculado; só a "oferta da casa" fica indisponível (o monitor registra a nota).

import { ScrapedOdd } from '../scraping/scraper_base';
import { PinnacleScraper } from '../scraping/casa_pinnacle';
import { KtoScraper, BetWarriorScraper } from '../scraping/casa_kambi';
import { BetanoScraper } from '../scraping/casa_a';
import { SuperbetScraper } from '../scraping/casa_superbet';
import { BetBoomScraper } from '../scraping/casa_betboom';
import { EsportesDaSorteScraper } from '../scraping/casa_esportesdasorte';
import { Aposta1Scraper } from '../scraping/casa_altenar';
import { areEventsSame, splitEvento } from '../arbitrage/matcher';
import { mesmaOferta } from '../arbitrage/markets';
import { alignOdd } from './cashoutMatch';
import { devig2Way, type CashoutSelection } from './cashoutEngine';

/** Referência mínima de uma aposta p/ localizar a oferta no feed. */
export interface ApostaRef {
  event_label: string;
  sport: string;
  market_label: string;
  selection: CashoutSelection;
  line: number | null;
}

interface DirectedScraper {
  getNome(): string;
  oddsDoEvento(evento: string, esporte?: string): Promise<ScrapedOdd[]>;
}

// Casas que EFETIVAMENTE entregam odd AO VIVO (in-play) hoje. As demais existem como
// alvo mas só pré-jogo — mantidas fora daqui de propósito.
const LIVE_TARGET_FACTORY: Record<string, () => DirectedScraper> = {
  KTO: () => new KtoScraper({ incluirAoVivo: true }),
  BetWarrior: () => new BetWarriorScraper({ incluirAoVivo: true }),
  Betano: () => new BetanoScraper({ incluirAoVivo: true }),
};

// Alvos por API SEM in-play (fallback pré-jogo — melhor que nada quando o jogo ainda
// não começou). Não prometem odd ao vivo.
const PREMATCH_TARGET_FACTORY: Record<string, () => DirectedScraper> = {
  Superbet: () => new SuperbetScraper(),
  BetBoom: () => new BetBoomScraper(),
  EsportesDaSorte: () => new EsportesDaSorteScraper(),
  Aposta1: () => new Aposta1Scraper(),
};

/** Nomes de casas com odd AO VIVO de verdade (p/ a UI orientar a escolha). */
export function casasComFonteLive(): string[] {
  return Object.keys(LIVE_TARGET_FACTORY);
}

/** True se a casa entrega odd AO VIVO (não só pré-jogo). */
export function casaTemFonteLive(casa: string): boolean {
  return !!LIVE_TARGET_FACTORY[casa];
}

// Memo curto por (casa|evento|esporte): dedupe fetches quando várias apostas
// compartilham o mesmo evento/casa no mesmo ciclo e evita relançar o Chromium da
// Betano à toa. TTL propositalmente baixo (odds ao vivo mudam rápido).
const memo = new Map<string, { at: number; odds: ScrapedOdd[] }>();
const MEMO_MS = 15_000;

async function fetchDirigido(make: () => DirectedScraper, casa: string, evento: string, esporte?: string): Promise<ScrapedOdd[]> {
  const key = `${casa}|${evento}|${esporte || ''}`;
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < MEMO_MS) return hit.odds;
  let odds: ScrapedOdd[] = [];
  try {
    odds = (await make().oddsDoEvento(evento, esporte)) || [];
  } catch (err: any) {
    console.warn(`[cashout-live] ${casa} oddsDoEvento falhou:`, err?.message);
    odds = [];
  }
  memo.set(key, { at: now, odds });
  // Poda simples pra não vazar em uptime longo.
  if (memo.size > 500) for (const [k, v] of memo) if (now - v.at > MEMO_MS) memo.delete(k);
  return odds;
}

/** Localiza a oferta da aposta no feed e devolve as 2 pernas alinhadas (ou null). */
function acharPernas(odds: ScrapedOdd[], bet: ApostaRef): { oddA: number; oddB: number; legs: { selection: CashoutSelection; odd: number }[] } | null {
  const split = splitEvento(bet.event_label);
  if (!split) return null;
  const [canonHome, canonAway] = split;
  const match = odds.find(
    (o) => areEventsSame(o.evento, bet.event_label) && mesmaOferta(o.mercado, o.linha ?? null, bet.market_label, bet.line ?? null)
  );
  if (!match) return null;
  const legs = alignOdd(match, canonHome, canonAway);
  if (!legs) return null; // mercado não alinhável (ex.: futebol 1X2 → dupla chance sintética)
  return { oddA: match.oddA, oddB: match.oddB, legs };
}

/**
 * Prob JUSTA ao vivo da bússola (Pinnacle) p/ a seleção da aposta, via de-vig 2-vias.
 * `oddOposto` = odd justa do lado oposto (p/ hedge teórico). null se a bússola não tem
 * o evento ao vivo ou o mercado não é alinhável (ex.: futebol 1X2 de 3 vias).
 */
export async function justaAoVivo(bet: ApostaRef): Promise<{ fairProb: number; fairOdd: number; oddOposto: number | null } | null> {
  const odds = await fetchDirigido(() => new PinnacleScraper({ incluirAoVivo: true }), 'Pinnacle', bet.event_label, bet.sport);
  const p = acharPernas(odds, bet);
  if (!p) return null;
  const dv = devig2Way(p.oddA, p.oddB);
  if (!dv) return null;
  const probBySel: Partial<Record<CashoutSelection, number>> = {
    [p.legs[0].selection]: dv.probA,
    [p.legs[1].selection]: dv.probB,
  };
  const fairProb = probBySel[bet.selection];
  if (fairProb == null || !(fairProb > 0 && fairProb < 1)) return null;
  const probOposto = p.legs[0].selection === bet.selection ? dv.probB : dv.probA;
  const oddOposto = probOposto > 0 && probOposto < 1 ? 1 / probOposto : null;
  return { fairProb, fairOdd: 1 / fairProb, oddOposto };
}

/**
 * Odd AO VIVO da MESMA seleção na casa da aposta (p/ estimar a oferta de saque) +
 * a odd do lado oposto (p/ hedge real na própria casa). null se a casa não entrega o
 * evento ao vivo. Casas só-pré-jogo entram no fallback (retornam se o jogo ainda não começou).
 */
export async function oddCasaAoVivo(bet: ApostaRef, casa: string): Promise<{ odd: number; oddOposto: number | null } | null> {
  const make = LIVE_TARGET_FACTORY[casa] || PREMATCH_TARGET_FACTORY[casa];
  if (!make) return null;
  const odds = await fetchDirigido(make, casa, bet.event_label, bet.sport);
  const p = acharPernas(odds, bet);
  if (!p) return null;
  const perna = p.legs.find((l) => l.selection === bet.selection);
  if (!perna) return null;
  const oposto = p.legs.find((l) => l.selection !== bet.selection);
  return { odd: perna.odd, oddOposto: oposto ? oposto.odd : null };
}
