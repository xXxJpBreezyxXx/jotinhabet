import { CasaAlvo } from './tipos';

/**
 * Universo de casas .bet.br a sondar (base: bookmakers do feed do SureRadar + KTO).
 *
 * ATENÇÃO: domínios e paths são HIPÓTESES iniciais — o probe captura a URL final real
 * e o feed de verdade, então um path "errado" ainda rende dados (a home de esportes
 * dispara os XHR de odds de qualquer forma). Ajuste conforme os relatórios.
 *
 * pesoCobertura: casas grandes (mais eventos = mais cruzamentos no engine) valem mais.
 */
export const CASAS_ALVO: CasaAlvo[] = [
  { nome: 'Blaze', dominio: 'https://blaze.bet.br', pathsPrematch: ['/pt/sports/futebol', '/pt/sports'], pathsAoVivo: ['/pt/sports/live'], pesoCobertura: 2 },
  { nome: 'Betano', dominio: 'https://www.betano.bet.br', pathsPrematch: ['/sport/futebol/jogos-de-hoje/', '/sport/'], pathsAoVivo: ['/live/'], pesoCobertura: 3 },
  { nome: 'Bet365', dominio: 'https://www.bet365.bet.br', pathsPrematch: ['/#/AC/B1/C1/', '/'], pathsAoVivo: ['/#/IP/'], pesoCobertura: 3 },
  { nome: 'Betnacional', dominio: 'https://betnacional.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 3 },
  { nome: 'Superbet', dominio: 'https://superbet.bet.br', pathsPrematch: ['/apostas/futebol?day=hoje', '/apostas'], pathsAoVivo: ['/apostas/ao-vivo'], pesoCobertura: 3 },
  { nome: 'Novibet', dominio: 'https://www.novibet.bet.br', pathsPrematch: ['/apostas-esportivas', '/'], pathsAoVivo: ['/apostas-esportivas/ao-vivo'], pesoCobertura: 3 },
  { nome: 'Sportingbet', dominio: 'https://sports.sportingbet.bet.br', pathsPrematch: ['/pt-br/sports', '/'], pathsAoVivo: ['/pt-br/sports/live'], pesoCobertura: 3 },
  { nome: 'EsportesDaSorte', dominio: 'https://esportesdasorte.bet.br', pathsPrematch: ['/ptb/sports', '/'], pathsAoVivo: ['/ptb/sports/live'], pesoCobertura: 3 },
  { nome: 'KTO', dominio: 'https://www.kto.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/in-play'], pesoCobertura: 2 },
  { nome: 'Bet7k', dominio: 'https://7k.bet.br', pathsPrematch: ['/esportes/futebol', '/esportes'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 2 },
  { nome: 'Stake', dominio: 'https://stake.bet.br', pathsPrematch: ['/sports/soccer', '/sports'], pathsAoVivo: ['/sports/live'], pesoCobertura: 2 },
  { nome: 'PixBet', dominio: 'https://pixbet.bet.br', pathsPrematch: ['/sports', '/'], pathsAoVivo: ['/sports/live'], pesoCobertura: 2 },
  { nome: 'BetPix365', dominio: 'https://betpix365.bet.br', pathsPrematch: ['/sports', '/'], pathsAoVivo: ['/sports/live'], pesoCobertura: 1 },
  { nome: 'BetWarrior', dominio: 'https://apostas.betwarrior.bet.br', pathsPrematch: ['/pt-br/sports', '/'], pathsAoVivo: ['/pt-br/sports/live'], pesoCobertura: 1 },
  { nome: 'AlfaBet', dominio: 'https://alfa.bet.br', pathsPrematch: ['/soccer', '/'], pathsAoVivo: ['/live'], pesoCobertura: 1 },
  { nome: 'Aposta1', dominio: 'https://www.aposta1.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'Apostaganha', dominio: 'https://apostaganha.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'Betao', dominio: 'https://betao.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'BetBoom', dominio: 'https://betboom.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'Vbet', dominio: 'https://vbet.bet.br', pathsPrematch: ['/pt/sportsbook', '/pt/sports', '/'], pathsAoVivo: ['/pt/live'], pesoCobertura: 3 },
  { nome: 'BetEsporte', dominio: 'https://betesporte.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'Betsul', dominio: 'https://betsul.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'BolsaDeAposta', dominio: 'https://bolsadeaposta.bet.br', pathsPrematch: ['/exchange/apostas-esportivas', '/'], pathsAoVivo: ['/exchange/ao-vivo'], pesoCobertura: 1 },
  { nome: 'CasaDeApostas', dominio: 'https://casadeapostas.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'Donald', dominio: 'https://donald.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'Onabet', dominio: 'https://onabet.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: 'Reidopitaco', dominio: 'https://pitaco.bet.br', pathsPrematch: ['/betting', '/'], pathsAoVivo: ['/betting/live'], pesoCobertura: 1 },
  // Domínio real é seu.bet.br (seubet.bet.br não resolve — conferido em 17/07/2026).
  { nome: 'SeuBet', dominio: 'https://seu.bet.br', pathsPrematch: ['/esportes', '/sports', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  // Lote 25/07/2026 (pedido do usuário). Recon:
  //  - 4Play: Altenar integration "4play" (FEITO — FourPlayScraper, fonte do scanner).
  //  - EstrelaBet: Altenar "estrelabet" (FEITO — já existia p/ revalidação, agora fonte).
  //  - BetMGM: Digitain (goldrush.llc). Odds via GraphQL WS (wss://www.betmgm.bet.br/api/graphql);
  //    REST só entrega config (groupConfig 2.6MB). Bot: Incapsula. Scraper novo (classe do Stake) — PENDENTE.
  //  - Betsson: Digitain proxied (/sb/fe-api/v2/), auth so_browser. Mesmo parser do BetMGM — PENDENTE.
  //  - JogaJunto (jogajunto.bet): SPA sem feed de odds observável — INVIÁVEL por ora.
  { nome: 'BetMGM', dominio: 'https://betmgm.bet.br', pathsPrematch: ['/aposta-esportiva', '/esportes', '/'], pathsAoVivo: ['/aposta-esportiva/ao-vivo'], pesoCobertura: 2 },
  { nome: 'Betsson', dominio: 'https://www.betsson.bet.br', pathsPrematch: ['/apostas-esportivas', '/esportes', '/'], pathsAoVivo: ['/apostas-esportivas/ao-vivo'], pesoCobertura: 2 },
  { nome: 'JogaJunto', dominio: 'https://jogajunto.bet', pathsPrematch: ['/esportes', '/sports', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  { nome: '4Play', dominio: 'https://4play.bet.br', pathsPrematch: ['/esportes', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 1 },
  // Lote 29/07/2026 (pedido do usuário). Domínios CONFERIDOS por DNS + <title>, porque
  // vários não seguem o padrão <marca>.bet.br:
  //  - Brazino777 → www.brazino777.bet.br (brazino777.bet.br redireciona pra www)
  //  - Luvabet    → luva.bet.br  (luvabet.bet.br NÃO existe; manifest confirma "luva.bet")
  //  - BravoBet   → bravo.bet.br (bravobet.bet.br NÃO existe; título "Bravo Bet")
  //  - PokerStars → NÃO tem .bet.br. No feed do SureRadar vem sem o sufixo "(BR)" que as
  //    regulamentadas têm, ou seja é o PokerStars internacional (pokerstars.bet).
  //    Provável geobloqueio do Brasil — o recon confirma.
  { nome: 'Brazino777', dominio: 'https://www.brazino777.bet.br', pathsPrematch: ['/esportes', '/sports', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 2 },
  { nome: 'PokerStars', dominio: 'https://www.pokerstars.bet', pathsPrematch: ['/sports/', '/pt-br/sports/', '/'], pathsAoVivo: ['/sports/live/'], pesoCobertura: 2 },
  { nome: 'Rivalo', dominio: 'https://www.rivalo.bet.br', pathsPrematch: ['/esportes', '/apostas-esportivas', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 2 },
  { nome: 'Luvabet', dominio: 'https://luva.bet.br', pathsPrematch: ['/esportes', '/sports', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 2 },
  { nome: 'BetVip', dominio: 'https://betvip.bet.br', pathsPrematch: ['/esportes', '/sports', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 2 },
  { nome: 'BravoBet', dominio: 'https://bravo.bet.br', pathsPrematch: ['/esportes', '/sports', '/'], pathsAoVivo: ['/esportes/ao-vivo'], pesoCobertura: 2 },
];

/** Busca uma casa pelo nome (case-insensitive), para o runner de casa única. */
export function acharCasa(nome: string): CasaAlvo | undefined {
  const alvo = nome.trim().toLowerCase();
  return CASAS_ALVO.find((c) => c.nome.toLowerCase() === alvo);
}
