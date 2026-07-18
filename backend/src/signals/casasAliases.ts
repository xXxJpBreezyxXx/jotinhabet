import { normalizarCasa } from '../IA/riskAnalyzer';

/**
 * Alias (como o grupo do Telegram escreve o nome da casa) → nome canônico de
 * EXIBIÇÃO. O canônico precisa ser compatível com:
 *  - SCRAPER_FACTORY (revalidationService): lowercase(canônico) ∈ {kto,
 *    betwarrior, superbet, aposta1, pinnacle, betboom, seubet, vbet};
 *  - obterLinkCasa (whatsapp.ts): matching por substring lowercase;
 *  - grupos de W.O. do tênis (regras.ts) e REGRAS_CASAS (normalizarCasa).
 * Chaves do mapa já normalizadas via normalizarCasa (lowercase, sem acento,
 * só [a-z0-9]) — "KTO (BR)" e "kto br" caem na mesma chave.
 */
const ALIAS_PARA_CANONICO: Record<string, string> = {
  // Casas com scraper próprio (revalidáveis)
  kto: 'KTO',
  ktobr: 'KTO',
  betwarrior: 'BetWarrior',
  warrior: 'BetWarrior',
  superbet: 'Superbet',
  superbetbr: 'Superbet',
  aposta1: 'Aposta1',
  apostaum: 'Aposta1',
  pinnacle: 'Pinnacle',
  betboom: 'BetBoom',
  seubet: 'SeuBet',
  vbet: 'Vbet',
  // Casas sem scraper (alertadas com tag ⚠️ NÃO REVALIDADO)
  betano: 'Betano',
  betsson: 'Betsson',
  bet365: 'Bet365',
  betnacional: 'Betnacional',
  pixbet: 'Pixbet',
  betpix365: 'BetPix365',
  blaze: 'Blaze',
  '1xbet': '1xbet',
  sportingbet: 'Sportingbet',
  stake: 'Stake',
  novibet: 'Novibet',
  esportesdasorte: 'EsportesDaSorte',
  esportedasorte: 'EsportesDaSorte',
  bolsadeaposta: 'Bolsa de Aposta',
  pitaco: 'Pitaco',
  betfair: 'Betfair',
  estrelabet: 'EstrelaBet',
  mcgames: 'MC Games',
};

/** Nome canônico de exibição da casa; desconhecida → nome original trimado
 *  (cai em não-revalidável e o alerta usa link de busca do Google). */
export function canonizarCasa(nome: string): string {
  const chave = normalizarCasa(nome || '');
  if (ALIAS_PARA_CANONICO[chave]) return ALIAS_PARA_CANONICO[chave];
  // O template da calculadora sufixa "(BR)" no nome ("Novibet (BR)" → chave
  // "novibetbr"): sem match direto, tenta de novo sem o "br" final.
  if (chave.endsWith('br') && ALIAS_PARA_CANONICO[chave.slice(0, -2)]) {
    return ALIAS_PARA_CANONICO[chave.slice(0, -2)];
  }
  return (nome || '').toString().trim();
}
