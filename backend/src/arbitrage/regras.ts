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
// Auditoria de W.O. das casas novas em 29/07/2026 (GRUPOS_WO_CASAS.md §lote 29/07):
//  - luvabet, rivalo, brazino777: NÃO classificadas → grupoTenis() = null → tênis
//    bloqueado (fail-safe). Brazino777 é o caso mais perigoso: a MESMA seção de tênis diz
//    "aposentadoria → apostas nulas" e depois "se pelo menos UM PONTO foi jogado e o
//    jogador se aposenta, todas as apostas são válidas" — não é A nem B (é mais agressivo
//    que B, que exige 1 SET), então cruzá-la com B também daria red.
//  - apostaganha REMOVIDA de A: estava aqui "por status quo" com confiança BAIXA, e o
//    único fundamento registrado era "sportsbook BETBY = mesma plataforma da Alfa/Blaze,
//    ambas void". Esse fundamento é FALSO — o recon de 29/07 provou que ela é **NSoft**
//    (tenant aposta_ganha_sportsbook). O doc /regras-de-apostas (25k chars) não tem
//    UMA menção a desistência/abandono/W.O. Como ela passou a ser FONTE de odds em
//    29/07, valia a mesma doutrina da Novibet: regra inacessível → desconhecida bloqueia.
// Auditoria de W.O. das casas novas em 31/07/2026 (GRUPOS_WO_CASAS.md §lote 31/07), cada
// classificação verificada por um segundo revisor tentando derrubá-la:
//  - brbet A: PDF oficial da casa ("Altenar Betting Rules v1.29" traduzido, 196 p.) diz VOID
//    duas vezes — p.61 §Tênis "se um jogador de ténis desistir antes da conclusão do último
//    ponto, o mercado do vencedor do jogo é nulo" e a mesma exceção na p.6. Desqualificação
//    e walkover estão DENTRO da mesma cláusula de anulação (não há regra de avanço).
//  - marjosports A: PDF "Regras de apostas aplicadas aos eventos de tênis V1.0.0 (16/07/2025)"
//    — "abandono ou desqualificação ... poderão ter as apostas não definidas como nulas",
//    "partidas definidas sem que sejam disputadas (WO), todos os mercados serão anulados" e,
//    ao vivo, "desqualificação, abandono ou WO ... gera a anulação de todas as apostas não
//    decididas".
//  - esportesdasorte A (auditada em 01/08): o rulebook do sportsbook Sportingtech
//    ("support-rules", §tênis) diz "No caso de aposentadoria ou desqualificação de uma
//    partida, todos os mercados que ainda não tiveram seu resultado determinado serão
//    considerados nulos" e "No caso de uma Passagem [walkover], todos os mercados serão
//    liquidados como nulos". Void puro, com DESQUALIFICAÇÃO anulando na MESMA frase (difere
//    de bet365/Vbet/SeuBet, que dão a vitória a quem avança em DQ). O preâmbulo declara que
//    as Regras Especiais do esporte prevalecem sobre as gerais. Tênis de mesa idem.
//    ATENÇÃO: isso NÃO estende para a Onabet, apesar de MESMO OPERADOR (Esportes Gaming
//    Brasil). O T&C do grupo é o mesmo texto nas duas e é MUDO sobre desistência; a regra
//    que classifica vem do SPORTSBOOK, e a Onabet roda outro (Altenar), com outra mesa.
//  - onabet e betesporte NÃO entram em grupo nenhum: as duas simplesmente NÃO publicam regra
//    de abandono no tênis (ausência PROVADA por enumeração da fonte autoritativa — o CMS da
//    Onabet lista 10 páginas e nenhuma é de regras; o regulamento da BetEsporte tem seção de
//    tênis que define mercados e não fala de desistência). Sem regra do OPERADOR, o
//    fail-safe vale: grupoTenis() = null → tênis bloqueado. A Onabet é Altenar, e Altenar tem
//    operador em A (Aposta1) e em B (KTO) — chutar aqui é a armadilha A×B que já custou caro.
// BETSSON classificada em B em 03/08/2026 (auditoria + aprovação do usuário no mesmo dia;
// GRUPOS_WO_CASAS.md §lote 03/08), ao integrar o scraper dela. O §17.57 do rulebook oficial
// é a redação de "1 SET CONCLUÍDO" ("um set completo deve ser completado para que as apostas
// sejam válidas; se menos de um set for completado, todas as apostas serão consideradas
// nulas") — estruturalmente IGUAL à da Pinnacle, que já estava em B. O mesmo documento prova
// que a casa escreve cláusula de avanço explícita quando é isso que quer (§17.50 Snooker) e
// NÃO tem void por desistência no mercado de vencedor do tênis.
// Ressalva anotada: no MESMO §17.57 o handicap de partida e o total de games são ANULADOS se
// a partida não terminar ("a menos que … já determinado incondicionalmente"). É a redação
// padrão do mercado (a Pinnacle tem igual), não a ambiguidade específica que motivou o
// bloqueio da KTO — mas se a Betsson ganhar volume em Handicap/Totais de tênis, reavaliar.
// ESTRELABET e 4PLAY classificadas em A em 03/08/2026 (auditoria + aprovação do usuário
// para aplicar direto o que fosse confiança ALTA; GRUPOS_WO_CASAS.md §lote 03/08). As duas
// publicam o MESMO texto (template Altenar traduzido), com a cláusula explícita de void:
// "se um tenista se retirar antes do último ponto concluído, o mercado vencedor da partida
// é anulado, mas todos os mercados relacionados a sets ou jogos específicos que são
// determinados são liquidados de acordo". É a mesma base que classificou a BrBET em A.
// Verificação adversarial feita nos dois documentos: NENHUMA ocorrência de "avanço"/"próxima
// rodada" se liga a tênis (o único hit é promo de pagamento antecipado do basquete), e todas
// as 40 ocorrências de "um set" são DEFINIÇÃO de mercado ("Jogador 1 para ganhar um set"),
// não condição de validade do vencedor — ou seja, não há a regra de 1-set do Grupo B.
// Fontes: estrelabet.bet.br/policy/sports-betting-rules e 4play.bet.br/info/regrasesportivas
// (as duas só cedem o texto via browser + shadow DOM; ver GRUPOS_WO_CASAS.md).
const GRUPO_A = new Set([
  'alfabet', 'aposta1', 'bet365', 'bet7k', 'betano', 'betao', 'betboom',
  'betnacional', 'betsul', 'blaze', 'brbet', 'esportesdasorte', 'marjosports', 'pixbet',
  'seubet', 'superbet', 'vbet', 'estrelabet', '4play',
]);
const GRUPO_B = new Set([
  'pinnacle', 'betwarrior', 'kto', 'stake', 'bolsadeaposta', 'reidopitaco', '1xbet', 'betsson',
]);

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
 * CASAS VETADAS NA OPERAÇÃO — bloqueio por CASA, não por mercado.
 *
 * Decisão do usuário em 31/07/2026 sobre a **EsporteNetBet** (e a irmã EsporteNet VIP):
 * não é operadora regulada bet.br (nenhum domínio .bet.br existe; é rede de banca/cambista
 * em .bet/.net), a margem mediana medida no feed é de ~17% (contra 2-5% de casa de verdade),
 * o teto por aposta é R$ 500 e as odds são derivadas do bet365. Com essa margem ela quase
 * nunca tem a melhor perna; quando tem, é erro de cotação — e erro de cotação em casa não
 * regulada é o cenário em que o operador simplesmente cancela.
 *
 * Sobrescrevível por `CASAS_BLOQUEADAS` no .env (lista por vírgula) para vetar outra casa
 * sem deploy. Cuidado ao editar: `esportenet*` é a VETADA, `esportesdasorte` é uma casa
 * INTEGRADA e legítima — os nomes são parecidos e a comparação aqui é exata/por prefixo
 * declarado, nunca por "contém".
 */
const CASAS_BLOQUEADAS_PADRAO = ['esportenetbet', 'esportenet', 'esportenetvip'];

function casasBloqueadas(): string[] {
  const doEnv = (process.env.CASAS_BLOQUEADAS || '')
    .split(',')
    .map((c) => normCasa(c))
    .filter(Boolean);
  return doEnv.length ? doEnv : CASAS_BLOQUEADAS_PADRAO;
}

/**
 * A casa está vetada? Compara a chave normalizada por igualdade E por prefixo declarado
 * ("esportenetvipbet" casa com "esportenetvip"), sem cair no "contém" — que confundiria
 * EsportesDaSorte com EsporteNet.
 */
export function casaBloqueada(casa: string): boolean {
  const chave = normCasa(casa);
  if (!chave) return false;
  return casasBloqueadas().some((b) => chave === b || chave.startsWith(b));
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
  // CASA VETADA vem antes de tudo: vale para qualquer fonte (SureRadar, sinal do Telegram,
  // motor próprio, value bet) e para qualquer mercado.
  for (const casa of [opp.casaA, opp.casaB]) {
    if (casaBloqueada(casa)) {
      return { ok: false, motivo: `casa vetada na operação: ${casa}` };
    }
  }
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
