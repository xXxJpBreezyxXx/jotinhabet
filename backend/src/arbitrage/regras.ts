/**
 * Regras de risco da varredura (ver documento "Diretrizes" na raiz do projeto).
 * Rejeita mercados/cruzamentos que podem dar PREJUÍZO numa surebet.
 *
 * Resumo:
 *  - Futebol: PROIBIDO Resultado Final / 1X2 (3-way, risco do empate). Liberado:
 *    DNB, Handicap Asiático, Total de Gols, Ambas Marcam.
 *  - Basquete: vencedor só vale incluindo prorrogação (tratado nos scrapers).
 *  - Tênis: só cruzar casas do MESMO grupo de regra de abandono (W.O.).
 *    Grupo A×A ou B×B; A×B é rejeitado (uma perna anula e a outra perde = prejuízo).
 */
import { normalizarMercado } from './markets';

// Grupos de regra de W.O. do tênis (Diretrizes §3).
//  - Grupo A: ANULA a aposta (Void) em abandono/lesão.
//  - Grupo B: regra de "1 Set Concluído" — liquida quem AVANÇA como vencedor
//    (o outro lado perde). Cruzar A×B é prejuízo garantido: um anula, o outro perde.
// KTO rebaixada A→B em 17/07/2026 (ver KTO.md): o provedor dela (Altenar) NÃO anula
// no Vencedor da Partida — aplica avanço de fase. Ficar no Grupo A causou perda real
// (Jacob Brumm x Ivan Savkin: Superbet[A] anulou, KTO liquidou vitória/derrota).
// Vbet classificada A em 17/07/2026 (ver VBET.md): regra publicada anula partida não
// concluída; "quem avança vence" só em DESQUALIFICAÇÃO (raríssima, ressalva no doc).
// Auditoria das 23 casas em 17/07/2026 (GRUPOS_WO_CASAS.md), aplicada com aprovação:
//  - betano B→A: regra publicada é VOID puro (3.3.2/3.3.4) — estava na whitelist da KTO;
//  - stake, bolsadeaposta e reidopitaco A→B: template de avanço/1 set (red no desistente);
//  - 1xbet classificada B: entidade BR dá "derrota técnica" ao desistente pós-1º set;
//  - novibet REMOVIDA: regra inacessível + promo sugere avanço → desconhecida bloqueia;
//  - betnacional FICA em A: variante "win/void" (ATP: avança ganha + desistente DEVOLVIDO;
//    ITF/UTR: void) nunca dá red por abandono — em B perderia em ITF/UTR×B;
//  - apostaganha e bet7k mantidas em A por status quo, mas a regra de tênis delas não está
//    publicada acessível (só sinal de plataforma/regra genérica) — confirmar se ganharem volume.
const GRUPO_A = new Set([
  'alfabet', 'aposta1', 'apostaganha', 'bet365', 'bet7k', 'betano', 'betao', 'betboom',
  'betnacional', 'betsul', 'blaze', 'pixbet', 'seubet', 'superbet', 'vbet',
]);
const GRUPO_B = new Set(['pinnacle', 'betwarrior', 'kto', 'stake', 'bolsadeaposta', 'reidopitaco', '1xbet']);

/** Normaliza o nome da casa: sem acento, minúsculo, sem "(BR)" e sem pontuação. */
function normCasa(casa: string): string {
  return (casa || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(br\)/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Grupo de W.O. do tênis da casa, ou null se desconhecida (→ tratado como incompatível). */
export function grupoTenis(casa: string): 'A' | 'B' | null {
  const n = normCasa(casa);
  if (GRUPO_A.has(n)) return 'A';
  if (GRUPO_B.has(n)) return 'B';
  return null;
}

/** True só se ambas as casas têm grupo conhecido e IGUAL (A×A ou B×B). */
export function mesmoGrupoTenis(casaA: string, casaB: string): boolean {
  const ga = grupoTenis(casaA);
  const gb = grupoTenis(casaB);
  return ga !== null && ga === gb;
}

/** True se a casa é a KTO (após normalização — cobre "KTO", "KTO (BR)"). */
function ehKto(casa: string): boolean {
  return normCasa(casa) === 'kto';
}

function normEsporte(e?: string): 'futebol' | 'basquete' | 'tenis' | 'esports' | 'outro' {
  const s = (e || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/futebol|football|soccer/.test(s)) return 'futebol';
  if (/basquete|basket/.test(s)) return 'basquete';
  // INTENCIONAL: "Tenis de Mesa" também cai aqui (contém "tenis") e herda as regras
  // de W.O. do tênis (grupos A/B + bloqueio da KTO em Handicap/Totais). Liga Pro/TT Cup
  // têm desistência frequente e as regras de liquidação por casa não foram verificadas
  // para mesa — até verificar (como no KTO.md), o conservador é tratar igual ao tênis.
  if (/tenis|tennis/.test(s)) return 'tenis';
  if (/e-?sports?|eletronic|counter|cs2|cs:?go|valorant|league of legends|\blol\b|dota|honor of kings|rainbow/.test(s))
    return 'esports';
  return 'outro';
}

/**
 * Blacklist de mercados de E-Sports (Diretrizes §5). Regra escolhida: permitir 2 vias,
 * bloqueando SÓ o que a Diretriz proíbe explicitamente. O empate (1X2/3-vias de BO2) é
 * barrado nos parsers (não sintetizam dupla chance em e-sports); aqui cobrimos o resto.
 */
function mercadoEsportsBloqueado(mercado: string): boolean {
  const m = (mercado || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Resultado exato de mapas (ex.: "Resultado correto do mapa", 2-0/2-1).
  if (/resultado correto|correct (map )?score|placar exato|resultado exato/.test(m)) return true;
  // Kills/mortes de JOGADOR específico (regras de W.O. divergem por substituição/queda).
  if (/(kill|morte|abate).*(jogador|player)|(jogador|player).*(kill|morte|abate)|player occurrence/.test(m)) return true;
  // "Corrida" (Race to X): primeiro a N, primeira torre, first blood, pistol round.
  if (/primeiro a |first to |race to |primeira torre|first tower|first blood|primeiro sangue|pistol|round de pistola/.test(m))
    return true;
  return false;
}

/** Mercado permitido por esporte. Futebol: Resultado Final/1X2 é PROIBIDO. */
export function mercadoPermitido(esporte: string | undefined, mercado: string): boolean {
  const esp = normEsporte(esporte);
  const canon = normalizarMercado(mercado); // ex.: RESULTADO_FINAL_FT, TOTAIS_GOLS_FT, HANDICAP_..._FT
  if (esp === 'futebol' && canon.startsWith('RESULTADO_FINAL')) return false;
  if (esp === 'esports' && mercadoEsportsBloqueado(mercado)) return false;
  return true;
}

/**
 * Decide se uma oportunidade respeita as Diretrizes de risco.
 * @returns { ok, motivo } — motivo preenchido quando rejeitada (para log).
 */
export function regraPermiteOportunidade(opp: {
  esporte?: string;
  mercado: string;
  casaA: string;
  casaB: string;
}): { ok: boolean; motivo?: string } {
  if (!mercadoPermitido(opp.esporte, opp.mercado)) {
    return { ok: false, motivo: `mercado bloqueado (${opp.esporte}): ${opp.mercado}` };
  }
  if (normEsporte(opp.esporte) === 'tenis') {
    // KTO.md §3: bloqueia KTO em Handicap/Totais de tênis — o provedor anula o bilhete
    // em lesão, EXCETO se o limite já foi ultrapassado (interpretação ambígua = risco).
    const canon = normalizarMercado(opp.mercado);
    if ((ehKto(opp.casaA) || ehKto(opp.casaB)) && (canon.startsWith('HANDICAP') || canon.startsWith('TOTAIS'))) {
      return { ok: false, motivo: `tênis: KTO bloqueada em Handicap/Totais (KTO.md §3): ${opp.mercado}` };
    }
    // Grupos de W.O. incompatíveis (A×B) = uma perna anula e a outra perde.
    if (!mesmoGrupoTenis(opp.casaA, opp.casaB)) {
      return {
        ok: false,
        motivo: `tênis: grupos de W.O. incompatíveis (${opp.casaA}[${grupoTenis(opp.casaA) || '?'}] x ${opp.casaB}[${grupoTenis(opp.casaB) || '?'}])`,
      };
    }
  }
  return { ok: true };
}
