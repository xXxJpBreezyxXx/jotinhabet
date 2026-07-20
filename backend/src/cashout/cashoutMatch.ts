// cashoutMatch.ts
// Alinhamento evento/mercado/seleção entre a bússola (Pinnacle) e as casas alvo,
// REUSANDO os matchers de produção (areEventsSame, mesmaOferta, areTeamsSame).
//
// O modelo de odds do projeto é 2-vias (ScrapedOdd opcaoA/opcaoB). A identidade do
// evento é sempre derivada da BÚSSOLA (fonte de referência); as casas alvo são
// alinhadas contra ela. Por convenção dos parsers, opcaoA = lado "home"/"over" e
// opcaoB = lado "away"/"under" — mas a orientação home/away pode vir invertida entre
// casas, então mercados de time são alinhados por IDENTIDADE DE TIME, não posição.

import { ScrapedOdd } from '../scraping/scraper_base';
import { normalizarMercado } from '../arbitrage/markets';
import { areTeamsSame, splitEvento, normalizeTeamName } from '../arbitrage/matcher';
import { CashoutSelection } from './cashoutEngine';

export type MarketKind = 'TOTAIS' | 'HANDICAP' | 'RESULTADO_FINAL' | 'DNB' | 'OUTRO';

export function marketKind(mercado: string): MarketKind {
  const c = normalizarMercado(mercado);
  if (c.startsWith('TOTAIS')) return 'TOTAIS';
  if (c.startsWith('HANDICAP')) return 'HANDICAP';
  if (c.startsWith('RESULTADO_FINAL')) return 'RESULTADO_FINAL';
  if (c.startsWith('DNB')) return 'DNB';
  return 'OUTRO';
}

/**
 * Chave natural de uma "instância de mercado" (partida + mercado + linha), estável
 * independente da orientação home/away — os nomes dos times entram ordenados. Usada
 * pra deduplicar o evento no banco e chavear o histórico em memória.
 */
export function eventKey(
  sport: string,
  team1: string,
  team2: string,
  mercado: string,
  linha?: number | null
): string {
  const times = [normalizeTeamName(team1), normalizeTeamName(team2)].sort().join('__');
  const mkt = normalizarMercado(mercado);
  const ln = linha === undefined || linha === null ? '' : String(linha);
  return `${sport.toLowerCase()}|${times}|${mkt}|${ln}`;
}

export interface AlignedLeg {
  selection: CashoutSelection;
  odd: number;
}

/**
 * Decompõe uma ScrapedOdd 2-vias nas duas pernas com a SELEÇÃO canônica (relativa à
 * orientação canônica canonHome/canonAway do evento). Retorna null para mercados que
 * não sabemos alinhar com segurança (OUTRO/desconhecido, dupla chance sintética, ou
 * quando não dá pra orientar os times).
 */
export function alignOdd(
  odd: ScrapedOdd,
  canonHome: string,
  canonAway: string
): AlignedLeg[] | null {
  const kind = marketKind(odd.mercado);

  if (kind === 'TOTAIS') {
    // opcaoA = over, opcaoB = under (convenção rotuloOver/rotuloUnder dos parsers).
    return [
      { selection: 'over', odd: odd.oddA },
      { selection: 'under', odd: odd.oddB },
    ];
  }

  if (kind === 'HANDICAP' || kind === 'RESULTADO_FINAL' || kind === 'DNB') {
    // Dupla chance sintética ("away ou Empate") NÃO é a mesma seleção que um 1X2
    // limpo — descarta pra não gerar sinal errado.
    const txt = `${odd.opcaoA} ${odd.opcaoB}`.toLowerCase();
    if (kind === 'RESULTADO_FINAL' && /ou empate|or draw/.test(txt)) return null;

    const split = splitEvento(odd.evento);
    if (!split) return null;
    const [ownHome, ownAway] = split;

    // Orienta as pernas desta casa contra o canônico por identidade de time.
    let aSel: CashoutSelection;
    let bSel: CashoutSelection;
    const mesmaOrientacao =
      areTeamsSame(ownHome, canonHome) || areTeamsSame(ownAway, canonAway);
    const orientacaoInvertida =
      areTeamsSame(ownHome, canonAway) || areTeamsSame(ownAway, canonHome);

    if (mesmaOrientacao) {
      aSel = 'home';
      bSel = 'away';
    } else if (orientacaoInvertida) {
      aSel = 'away';
      bSel = 'home';
    } else {
      return null; // times não bateram — não arrisca alinhar
    }

    return [
      { selection: aSel, odd: odd.oddA },
      { selection: bSel, odd: odd.oddB },
    ];
  }

  return null;
}
