// browserOddsCache.ts
// Cache em memória das odds das casas de BROWSER (Betano/Blaze/1xBet), populado por um
// worker de cadência própria (BrowserScrapeWorker) e LIDO pela varredura. Assim essas
// casas participam do scan automático sem rodar Playwright inline (pesado na VPS 1-core).
//
// Enquanto o worker estiver DESLIGADO (env), o cache fica vazio → a leitura é no-op e o
// scan segue idêntico ao de hoje. As odds em cache podem estar defasadas (até a idade
// máxima aceita pelo leitor), mas o gate pré-alerta revalida cada perna AO VIVO na casa
// antes de disparar o WhatsApp — a defasagem do cache não vira alerta falso.

import { ScrapedOdd } from './scraper_base';

interface Entrada {
  odds: ScrapedOdd[];
  at: number; // epoch ms da coleta
}

const cache = new Map<string, Entrada>();

/** Grava (substitui) o snapshot de odds de uma casa de browser. */
export function setBrowserOdds(nome: string, odds: ScrapedOdd[]): void {
  cache.set(nome, { odds, at: Date.now() });
}

/** Entradas coletadas há no máximo `maxAgeMs` e não-vazias → [{ nome, odds }]. */
export function getBrowserOddsFresh(maxAgeMs: number): Array<{ nome: string; odds: ScrapedOdd[] }> {
  const agora = Date.now();
  const out: Array<{ nome: string; odds: ScrapedOdd[] }> = [];
  for (const [nome, e] of cache) {
    if (e.odds.length > 0 && agora - e.at <= maxAgeMs) out.push({ nome, odds: e.odds });
  }
  return out;
}

/** Idade (ms) do snapshot de uma casa, ou null se ausente — p/ status/diagnóstico. */
export function idadeBrowserOdds(nome: string): number | null {
  const e = cache.get(nome);
  return e ? Date.now() - e.at : null;
}

/** Limpa o cache (uso em testes). */
export function _limparBrowserOddsCache(): void {
  cache.clear();
}
