/**
 * Normalização de mercados e seleções para casamento cross-casa.
 *
 * Casas diferentes nomeiam o mesmo mercado de formas distintas ("Resultado Final",
 * "Vencedor do Encontro", "1X2"...). Para o engine cruzar odds entre casas, o nome
 * do mercado precisa ser normalizado para uma chave canônica, e o campo `linha`
 * (over/under, handicap) precisa entrar na chave — Over 2.5 nunca cruza com Over 3.0.
 *
 * Convenção que os parsers DEVEM seguir ao emitir ScrapedOdd (para o alinhamento
 * de lados opostos funcionar):
 *  - RESULTADO_FINAL: opcaoA = time da casa, opcaoB = time visitante (2-way);
 *    3-way (futebol) → dupla chance sintética, como o BlazeScraper já faz.
 *  - TOTAIS: opcaoA = rotuloOver(linha), opcaoB = rotuloUnder(linha), linha preenchida.
 *  - HANDICAP: opcaoA = time da casa, opcaoB = visitante, linha = handicap (sinal da casa).
 */

/**
 * A chave canônica de um mercado NÃO pode colapsar assunto e período: "Total de gols"
 * e "Total de escanteios" são mercados DIFERENTES; "Total 1º tempo" ≠ "Total do jogo".
 * Colapsá-los gera surebets falsas (ex.: cruzar over de escanteios com under de gols).
 * Por isso a chave carrega ASSUNTO (gols/escanteios/...) e PERÍODO (FT/1T/2T).
 */

/** Período do mercado a partir do rótulo cru. */
function periodo(s: string): string {
  // Segmentos específicos ANTES dos tempos — "1º quarto"/"3º set"/"2º período" não
  // podem virar FT nem colidir entre si (mesma família do bug Mapa 1 × Mapa 2:
  // total do 1º quarto a 43.5 não pode cruzar com o do 2º quarto a 43.5).
  // Aceita o ordinal DEPOIS da palavra ("Set 3", padrão Kambi vôlei/mesa) e o símbolo
  // de grau "°" no lugar do ordinal "º" (padrão Superbet) — sem isso, "Handicap de
  // Pontos - Set 3" colapsava em FT e cruzava com o handicap da partida inteira.
  const q = s.match(/([1-4])[º°]?\s*quarto|\bq([1-4])\b|([1-4])(?:st|nd|rd|th)\s*quarter|quarto\s*([1-4])\b/);
  if (q) return `Q${q[1] || q[2] || q[3] || q[4]}`;
  const st = s.match(/([1-7])[º°]?\s*set|([1-7])(?:st|nd|rd|th)\s*set|\bset\s*([1-7])\b/);
  if (st) return `S${st[1] || st[2] || st[3]}`;
  const pr = s.match(/([1-3])[º°]?\s*per[ií]odo|per[ií]odo\s*([1-3])\b/);
  if (pr) return `P${pr[1] || pr[2]}`;
  // Beisebol: "após/primeiro(s) N entradas/innings" (parcial agregado, ex.: F5) e
  // "entrada/turno N" (uma entrada só) são períodos distintos entre si e do jogo
  // completo. Cobre as variações reais: "Primeiros 5 innings" (BetWarrior),
  // "Primeiro(s) 5 Innings", "Após 5 Entradas" (Superbet), "Turnos 1" (Kambi).
  const ea = s.match(/(?:ap[oó]s|primeir[\w()]*|first|after)\s*(\d+)\s*(?:entradas?|innings?|turnos?)/);
  if (ea) return `E${ea[1]}`;
  const e1 = s.match(/entradas?\s*(\d+)|(\d+)ª?\s*entrada|innings?\s*(\d+)|turnos?\s*(\d+)/);
  if (e1) return `I${e1[1] || e1[2] || e1[3] || e1[4]}`;
  if (/1[º°]?\s*tempo|primeiro tempo|1st half|\b1t\b/.test(s)) return '1T';
  if (/2[º°]?\s*tempo|segundo tempo|2nd half|\b2t\b/.test(s)) return '2T';
  return 'FT';
}

/**
 * Segmento de MAPA em e-sports ("Mapa 1" → "M1"), ou "" quando não houver.
 * Essencial para não colapsar "Mapa 1 - Total de rodadas" com "Mapa 2 - ...":
 * over 21.5 do mapa 1 nunca pode cruzar com under 21.5 do mapa 2.
 */
function mapa(s: string): string {
  const m = s.match(/mapa\s*(\d+)|\bmap\s*(\d+)\b/);
  return m ? `M${m[1] || m[2]}` : '';
}

// Termos que indicam que um sufixo pós-hífen é TEXTO DE MERCADO, não nome de time.
const TERMO_MERCADO =
  /total|mais|menos|over|under|handicap|vencedor|resultado|placar|rodada|round|mapa|\bmap\b|kill|gol|goal|ponto|game|\bset\b|escanteio|cart[aã]o|cart[oõ]es|chute|shot|prorroga|[ií]mpar|\bpar\b|corret|margem|dura[cç][aã]o|jogador|player|pistol|d[uú]pla|quarto|quarter|per[ií]odo|tempo|half|corrida|entrada|inning|turno|rebatedor/;

/**
 * Escopo POR TIME no fim do rótulo ("Total de cartões - Chapecoense" → "_CHAPECOENSE").
 * Sem isto, o total por-time colidia com o total da PARTIDA (e com o do outro time),
 * cruzando mercados diferentes como se fossem o mesmo. Sufixos que são texto de
 * mercado ("Mapa 1 - Total de rodadas") são ignorados.
 */
function escopoTime(s: string): string {
  const m = s.match(/-\s*([^-]+?)\s*$/);
  if (!m) return '';
  const suf = m[1].trim().toLowerCase();
  if (!suf || TERMO_MERCADO.test(suf)) return '';
  return '_' + suf.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').toUpperCase();
}

/** Assunto do total/handicap (o que está sendo contado). */
function assunto(s: string): string {
  if (/escanteio|corner/.test(s)) return 'ESCANTEIOS';
  if (/cart[aã]o|card|cart[oõ]es/.test(s)) return 'CARTOES';
  if (/\bace/.test(s)) return 'ACES';
  // Chutes ANTES de gols: "total de chutes a gol" contém "gol" e colidia com
  // TOTAIS_GOLS (pareava chutes com gols/escanteios de outra casa).
  if (/chute|shot|finaliza/.test(s)) return 'CHUTES';
  // Beisebol: corridas (runs) têm assunto próprio — em GERAL, "total de corridas 8.5"
  // poderia colidir com outro total desconhecido de linha igual (ex.: hits).
  if (/corrida|\brun\b|\bruns\b/.test(s)) return 'CORRIDAS';
  if (/gol|goal/.test(s)) return 'GOLS';
  if (/game/.test(s)) return 'GAMES';
  // PONTOS antes de SETS: em "Total de pontos - Set 3" o "Set 3" é o PERÍODO
  // (extraído por periodo()), não o assunto — o que se conta ali são pontos.
  // "Total de sets"/"Handicap de Set" não contêm "ponto" e seguem caindo em SETS.
  if (/ponto|point/.test(s)) return 'PONTOS';
  if (/\bset/.test(s)) return 'SETS';
  // E-sports: o ASSUNTO da estatística separa mercados que senão colapsariam em GERAL
  // (kills ≠ torres ≠ minutos) e poderiam cruzar falso ao coincidir a linha.
  if (/kill|abate/.test(s)) return 'KILLS';
  if (/torre|tower/.test(s)) return 'TORRES';
  if (/minuto|minute/.test(s)) return 'MINUTOS';
  // Rodadas antes de mapas (ex.: "Mapa 1 - Total de rodadas" é ROUNDS, não MAPAS).
  if (/rodada|\bround/.test(s)) return 'ROUNDS';
  if (/mapa|\bmap\b/.test(s)) return 'MAPAS';
  return 'GERAL';
}

/**
 * Reduz o nome cru do mercado a uma chave canônica composta (assunto + período).
 * Ordem importa: handicap/total antes de "resultado final" para combos não se
 * disfarçarem de match-winner.
 */
const memoNormalizar = new Map<string, string>();

export function normalizarMercado(raw: string): string {
  // Memoizado: com 7 casas o motor faz milhões de normalizações por varredura sobre
  // poucos milhares de rótulos distintos — sem o memo, os regex desta função eram
  // parte do gargalo que levou a varredura a >7 min (load 56 na VPS em 17/07/2026).
  const key = (raw || '').toString();
  const hit = memoNormalizar.get(key);
  if (hit !== undefined) return hit;
  const r = normalizarMercadoCru(key);
  if (memoNormalizar.size > 20000) memoNormalizar.clear();
  memoNormalizar.set(key, r);
  return r;
}

function normalizarMercadoCru(raw: string): string {
  const s = raw.toLowerCase();
  // Segmento: em e-sports usa o mapa (M1/M2/...); nos demais, o período (FT/1T/2T).
  const seg = mapa(s) || periodo(s);
  // DNB (Empate Anula / Draw No Bet) antes de tudo — não deve virar RESULTADO_FINAL.
  if (/empate anula|empate devolve|draw no bet|\bdnb\b/.test(s)) return `DNB_${periodo(s)}`;
  if (/handicap|desvantagem|spread|linha asi/.test(s)) return `HANDICAP_${assunto(s)}_${seg}${escopoTime(s)}`;
  if (/total|over|under|mais de|menos de|acima|abaixo/.test(s)) return `TOTAIS_${assunto(s)}_${seg}${escopoTime(s)}`;
  // BTTS — aceita "ambas"/"ambos ... marcam" e variações.
  if (/amb[oa]s.*marcam|both teams to score|btts/.test(s)) return `AMBAS_MARCAM_${periodo(s)}`;
  // Vencedor de MAPA específico em e-sports ("Mapa 1"/"Mapa 2", 2-vias) — distinto do
  // vencedor da partida. Totais/handicap já foram tratados acima, então aqui só sobra o
  // vencedor de mapa cru.
  {
    const m = s.match(/\bmapa\s*(\d+)\b|\bmap\s*(\d+)\s*winner\b/);
    if (m) return `VENCEDOR_MAPA_M${m[1] || m[2]}`;
  }
  if (/resultado final|match winner|1\s*x\s*2|vencedor|money\s*line|full time result|resultado do jogo|1x2/.test(s)) {
    return `RESULTADO_FINAL_${periodo(s)}`;
  }
  return 'DESCONHECIDO';
}

/** Compara duas linhas (2.5, -1.5...) com tolerância de ponto flutuante. */
export function linhasIguais(a?: number | null, b?: number | null): boolean {
  const na = a ?? null;
  const nb = b ?? null;
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) < 1e-9;
}

/**
 * True se dois mercados de casas diferentes são "a mesma oferta" (mesmo mercado + linha).
 * DESCONHECIDO cai para comparação exata de string (conservador) — evita cruzar
 * mercados que não sabemos normalizar.
 */
export function mesmaOferta(
  mercado1: string,
  linha1: number | undefined | null,
  mercado2: string,
  linha2: number | undefined | null
): boolean {
  const c1 = normalizarMercado(mercado1);
  const c2 = normalizarMercado(mercado2);
  if (c1 === 'DESCONHECIDO' || c2 === 'DESCONHECIDO') {
    return (
      (mercado1 || '').trim().toLowerCase() === (mercado2 || '').trim().toLowerCase() &&
      linhasIguais(linha1, linha2)
    );
  }
  return c1 === c2 && linhasIguais(linha1, linha2);
}

/** Rótulos canônicos de totais — parsers emitem estes para o alinhamento bater entre casas. */
export const rotuloOver = (linha: number): string => `Mais de ${linha}`;
export const rotuloUnder = (linha: number): string => `Menos de ${linha}`;

/** True se a linha é quarter asiática (.25/.75) — aposta dividida nas duas linhas vizinhas. */
export function ehLinhaQuarter(linha: number): boolean {
  const f = Math.abs(linha) % 1;
  return Math.abs(f - 0.25) < 1e-9 || Math.abs(f - 0.75) < 1e-9;
}

/**
 * Linha ARBITRÁVEL em 2 pernas: meia-linha (.5) ou quarter asiática (.25/.75).
 * Linha INTEIRA fica de fora: o push devolve as duas pernas e o "arb" vira lucro zero.
 * Na quarter, o cenário do MEIO (resultado exatamente na linha vizinha inteira)
 * devolve metade de cada perna → o lucro GARANTIDO é o PISO = metade do nominal.
 * O piso é aplicado em ArbitrageEngine.enriquecer/calcularDistribuicaoStake e na
 * revalidação pré-alerta — o ROI exibido/alertado de quarter é sempre o piso.
 */
export function linhaArbitravel(linha: number): boolean {
  const f = Math.abs(linha) % 1;
  return Math.abs(f - 0.5) < 1e-9 || ehLinhaQuarter(linha);
}
