import { normalizarCasa } from '../IA/riskAnalyzer';

/**
 * Alias (como o grupo do Telegram escreve o nome da casa) → nome canônico de
 * EXIBIÇÃO. O canônico precisa ser compatível com:
 *  - SCRAPER_FACTORY (revalidationService): lowercase(canônico) ∈ {kto,
 *    betwarrior, superbet, aposta1, pinnacle, betboom, seubet, vbet,
 *    esportesdasorte, betnacional, betano, blaze, 1xbet};
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
  esportesdasorte: 'EsportesDaSorte',
  esportedasorte: 'EsportesDaSorte',
  betnacional: 'Betnacional',
  betano: 'Betano', // scraper de browser (só Resultado Final)
  blaze: 'Blaze',   // scraper de browser (só Resultado Final)
  '1xbet': '1xbet', // scraper de browser (só Resultado Final)
  betpix365: 'BetPix365', // Altenar (revalidação; não é fonte do scanner)
  estrelabet: 'EstrelaBet', // Altenar (fonte do scanner + revalidação)
  '4play': '4Play',         // Altenar "4play" (fonte do scanner + revalidação)
  mcgames: 'MC Games',      // Altenar "mcgames2" (revalidação; não é fonte do scanner)
  luvabet: 'Luvabet',       // Altenar "luvabet" (fonte do scanner + revalidação)
  luva: 'Luvabet',          // domínio é luva.bet.br — o feed às vezes rotula só "Luva"
  onabet: 'Onabet',         // Altenar "onabet"; domínio ona.bet.br (onabet.bet.br não existe)
  ona: 'Onabet',            // o feed/SureRadar pode rotular só "Ona" (pelo domínio)
  brbet: 'BrBET',           // Altenar "brbet"
  brbetbr: 'BrBET',         // variação com sufixo do domínio
  betesporte: 'BetEsporte', // plataforma própria "SA Esportes" (feed Sportradar)
  marjosports: 'MarjoSports', // NGX/BetPlus; licença LOTERJ (não federal)
  marjo: 'MarjoSports',     // o feed/SureRadar pode rotular só "Marjo"
  stake: 'Stake',           // browser-intercept (Futebol 1X2)
  rivalo: 'Rivalo',         // plataforma própria (matchserv); browser headed + Xvfb
  brazino777: 'Brazino777',  // NSoft AIO (API pública)
  brazino: 'Brazino777',     // o SureRadar rotula "Brazino 777" -> chave "brazino777"
  apostaganha: 'ApostaGanha', // NSoft AIO (mesmo parser)
  apostaganhasportsbook: 'ApostaGanha',
  betsson: 'Betsson',       // sportsbook próprio do Betsson Group (/api/sb/v1)
  // Casas sem scraper (alertadas com tag ⚠️ NÃO REVALIDADO)
  bet365: 'Bet365',
  pixbet: 'Pixbet',
  sportingbet: 'Sportingbet',
  novibet: 'Novibet',
  bolsadeaposta: 'Bolsa de Aposta',
  pitaco: 'Pitaco',
  betfair: 'Betfair',
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
