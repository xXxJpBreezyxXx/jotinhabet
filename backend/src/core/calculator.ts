export interface CalculatorInput {
  banca1: number;         // Banca disponível na Casa 1
  banca2: number;         // Banca disponível na Casa 2
  maxStakePct?: number;   // Porcentagem máxima da banca a arriscar por turno (ex: 0.50 para 50%)
  odd1: number;           // Cotação na Casa 1
  odd2: number;           // Cotação na Casa 2
  roundStep1?: number;    // Arredondamento da Casa 1 (ex: 1.0 para inteiros, 0.50, 0.01)
  roundStep2?: number;    // Arredondamento da Casa 2 (ex: 1.0, 0.50, 0.01)
}

export interface CalculatorResult {
  isArbitrage: boolean;
  oddMinimaExigida: number;
  margemTeoricaPct: number; // Lucro teórico implícito na odd
  stake1: number;           // Aposta calculada e arredondada para Casa 1
  stake2: number;           // Aposta calculada e arredondada para Casa 2
  investimentoTotal: number;
  retornoCasa1: number;     // Retorno bruto caso vença a Casa 1
  retornoCasa2: number;     // Retorno bruto caso vença a Casa 2
  lucroCasa1: number;       // Lucro líquido caso vença a Casa 1
  lucroCasa2: number;       // Lucro líquido caso vença a Casa 2
  piorLucro: number;
  melhorLucro: number;
  piorRoiPct: number;
  melhorRoiPct: number;
}

/**
 * Valida a entrada e calcula a arbitragem ideal baseada nos limites de banca individual e arredondamento.
 */
export function calcularArbitragem(input: CalculatorInput): CalculatorResult | null {
  const {
    banca1,
    banca2,
    maxStakePct = 0.5, // 50% de stake máximo padrão (conforme regra da planilha)
    odd1,
    odd2,
    roundStep1 = 0.01, // Padrão centavos
    roundStep2 = 0.01
  } = input;

  // 1. Tratamento de exceção / dados corrompidos (regra.md item 8.2)
  if (odd1 <= 1.00 || odd2 <= 1.00 || banca1 <= 0 || banca2 <= 0) {
    return null;
  }

  // 2. Cálculo do gatilho mínimo para arbitragem
  const oddMinimaExigida = odd1 / (odd1 - 1);
  const margem = (1 / odd1) + (1 / odd2);
  const isArbitrage = odd2 > oddMinimaExigida;

  // Se não houver arbitragem viável, retornamos que não é arbitragem
  const margemTeoricaPct = Number(((1 - margem) * 100).toFixed(2));

  // 3. Cálculo de limites de aposta individuais (banca * maxStakePct)
  const limit1 = banca1 * maxStakePct;
  const limit2 = banca2 * maxStakePct;

  let rawStake1 = 0;
  let rawStake2 = 0;

  // Tentamos primeiro apostar o limite máximo na Casa 1 e calcular a Casa 2 proporcional
  rawStake1 = limit1;
  rawStake2 = rawStake1 * (odd1 / odd2);

  // Se ultrapassar o limite da Casa 2, reduzimos proporcionalmente baseado na Casa 2
  if (rawStake2 > limit2) {
    rawStake2 = limit2;
    rawStake1 = rawStake2 * (odd2 / odd1);
  }

  // 4. Aplicação das regras de arredondamento configuráveis por casa
  // Formata com toFixed(2) para contornar problemas de ponto flutuante do JavaScript
  const stake1 = Number((Math.round(rawStake1 / roundStep1) * roundStep1).toFixed(2));
  const stake2 = Number((Math.round(rawStake2 / roundStep2) * roundStep2).toFixed(2));

  // 5. Cálculo dos retornos reais pós-arredondamento
  const investimentoTotal = Number((stake1 + stake2).toFixed(2));
  
  const retornoCasa1 = Number((stake1 * odd1).toFixed(2));
  const retornoCasa2 = Number((stake2 * odd2).toFixed(2));
  
  const lucroCasa1 = Number((retornoCasa1 - investimentoTotal).toFixed(2));
  const lucroCasa2 = Number((retornoCasa2 - investimentoTotal).toFixed(2));
  
  const piorLucro = Math.min(lucroCasa1, lucroCasa2);
  const melhorLucro = Math.max(lucroCasa1, lucroCasa2);

  const piorRoiPct = investimentoTotal > 0 ? Number(((piorLucro / investimentoTotal) * 100).toFixed(2)) : 0;
  const melhorRoiPct = investimentoTotal > 0 ? Number(((melhorLucro / investimentoTotal) * 100).toFixed(2)) : 0;

  return {
    isArbitrage,
    oddMinimaExigida: Number(oddMinimaExigida.toFixed(3)),
    margemTeoricaPct,
    stake1,
    stake2,
    investimentoTotal,
    retornoCasa1,
    retornoCasa2,
    lucroCasa1,
    lucroCasa2,
    piorLucro,
    melhorLucro,
    piorRoiPct,
    melhorRoiPct
  };
}
