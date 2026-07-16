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
  if (/1º?\s*tempo|primeiro tempo|1st half|\b1t\b|1º set|1st set/.test(s)) return '1T';
  if (/2º?\s*tempo|segundo tempo|2nd half|\b2t\b|2º set|2nd set/.test(s)) return '2T';
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

/** Assunto do total/handicap (o que está sendo contado). */
function assunto(s: string): string {
  if (/escanteio|corner/.test(s)) return 'ESCANTEIOS';
  if (/cart[aã]o|card|cart[oõ]es/.test(s)) return 'CARTOES';
  if (/\bace/.test(s)) return 'ACES';
  if (/gol|goal/.test(s)) return 'GOLS';
  if (/game/.test(s)) return 'GAMES';
  if (/\bset/.test(s)) return 'SETS';
  if (/ponto|point/.test(s)) return 'PONTOS';
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
export function normalizarMercado(raw: string): string {
  const s = (raw || '').toString().toLowerCase();
  // Segmento: em e-sports usa o mapa (M1/M2/...); nos demais, o período (FT/1T/2T).
  const seg = mapa(s) || periodo(s);
  // DNB (Empate Anula / Draw No Bet) antes de tudo — não deve virar RESULTADO_FINAL.
  if (/empate anula|empate devolve|draw no bet|\bdnb\b/.test(s)) return `DNB_${periodo(s)}`;
  if (/handicap|desvantagem|spread|linha asi/.test(s)) return `HANDICAP_${assunto(s)}_${seg}`;
  if (/total|over|under|mais de|menos de|acima|abaixo/.test(s)) return `TOTAIS_${assunto(s)}_${seg}`;
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
