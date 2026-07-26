/**
 * Comissão de EXCHANGE (bolsa de apostas).
 *
 * Numa exchange você é a "casa" da outra ponta: a corretora cobra uma comissão sobre
 * o GANHO LÍQUIDO (não sobre o stake) quando a aposta vence. Numa back a odd O paga
 * lucro = stake·(O−1); com comissão c o lucro líquido vira stake·(O−1)·(1−c). Logo a
 * ODD EFETIVA para fins de cálculo (ROI, break-even, distribuição de stake) é:
 *
 *     oddEfetiva = 1 + (O − 1)·(1 − c)
 *
 * A odd EXIBIDA/clicada segue sendo a crua (é a que a exchange mostra); só a MATEMÁTICA
 * da oportunidade usa a efetiva, para o lucro informado já descontar a comissão. Sem
 * isto, uma "surebet" fininha com perna na exchange some do lucro real quando a
 * corretora leva 1,5% do ganho.
 *
 * Escopo pedido pelo usuário (25/07/2026): Bolsa de Aposta a 1,5%. O mapa é extensível
 * a outras exchanges (Betfair, etc.) quando a comissão de cada uma for confirmada.
 */

/** Comissão da exchange por casa (fração do ganho líquido). Chave normalizada (só [a-z0-9]). */
export const COMISSAO_EXCHANGE: Record<string, number> = {
  bolsadeaposta: 0.015, // Bolsa de Aposta — 1,5% sobre o lucro (confirmado 25/07/2026)
};

/** Normaliza o nome da casa para a chave do mapa: minúsculo, sem acento, só [a-z0-9]. */
function chaveCasa(casa: string): string {
  return (casa || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Comissão (fração 0..1) cobrada pela casa sobre o ganho líquido, ou 0 se não for exchange.
 *  Tolera o sufixo "(BR)" do template da calculadora ("Bolsa de Aposta (BR)" → "bolsadeapostabr"). */
export function comissaoDaCasa(casa: string): number {
  const k = chaveCasa(casa);
  if (k in COMISSAO_EXCHANGE) return COMISSAO_EXCHANGE[k];
  if (k.endsWith('br') && k.slice(0, -2) in COMISSAO_EXCHANGE) return COMISSAO_EXCHANGE[k.slice(0, -2)];
  return 0;
}

/** True se a casa é uma exchange com comissão configurada. */
export function ehExchangeComComissao(casa: string): boolean {
  return comissaoDaCasa(casa) > 0;
}

/**
 * Odd EFETIVA da casa depois da comissão de exchange (para ROI/break-even/stake).
 * Casas comuns (comissão 0) devolvem a própria odd — chamada 100% segura em qualquer perna.
 */
export function oddEfetiva(casa: string, odd: number): number {
  const c = comissaoDaCasa(casa);
  if (!(c > 0) || !(odd > 1)) return odd;
  return 1 + (odd - 1) * (1 - c);
}
