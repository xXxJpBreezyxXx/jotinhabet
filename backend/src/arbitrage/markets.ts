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

export type MercadoCanonico =
  | 'RESULTADO_FINAL'
  | 'TOTAIS'
  | 'HANDICAP'
  | 'AMBAS_MARCAM'
  | 'DESCONHECIDO';

const REGRAS: Array<[RegExp, MercadoCanonico]> = [
  [/resultado final|match winner|1\s*x\s*2|vencedor|money\s*line|full time result|resultado do jogo|1x2/i, 'RESULTADO_FINAL'],
  [/handicap|hcp|spread|linha asi[aá]tica/i, 'HANDICAP'],
  [/total|over\s*\/?\s*under|mais\s*\/?\s*menos|acima|abaixo|totais|under|over/i, 'TOTAIS'],
  [/ambas.*marcam|both teams to score|btts|ambos marcam|ambas equipes marcam/i, 'AMBAS_MARCAM'],
];

/** Reduz o nome cru do mercado a uma chave canônica. HANDICAP é testado antes de TOTAIS. */
export function normalizarMercado(raw: string): MercadoCanonico {
  const s = (raw || '').toString();
  for (const [re, canonico] of REGRAS) {
    if (re.test(s)) return canonico;
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
