import { comissaoDaCasa } from '../arbitrage/comissao';

/** Comissão efetiva do lado: usa a explícita (fração 0..1) se válida; senão resolve pelo nome da casa. */
function comissaoResolvida(comissao?: number, casa?: string): number {
  if (typeof comissao === 'number' && Number.isFinite(comissao) && comissao > 0 && comissao < 1) return comissao;
  return casa ? comissaoDaCasa(casa) : 0;
}

export interface CalculatorInput {
  banca1: number;         // Banca disponível na Casa 1
  banca2: number;         // Banca disponível na Casa 2
  maxStakePct?: number;   // Porcentagem máxima da banca a arriscar por turno (ex: 0.50 para 50%)
  odd1: number;           // Cotação na Casa 1
  odd2: number;           // Cotação na Casa 2
  roundStep1?: number;    // Arredondamento da Casa 1 (ex: 1.0 para inteiros, 0.50, 0.01)
  roundStep2?: number;    // Arredondamento da Casa 2 (ex: 1.0, 0.50, 0.01)
  // Comissão de EXCHANGE por lado (fração do lucro, ex.: 0.015 = 1,5% da Bolsa de Aposta).
  // Quando informada, a odd efetiva do lado vira 1+(odd-1)*(1-comissão) e entra no
  // cálculo (arbitragem/stake/lucro). Aceita também o nome da casa (casa1/casa2) → a
  // comissão é resolvida pelo mapa de exchanges. 0/ausente = casa comum (sem efeito).
  comissao1?: number;
  comissao2?: number;
  casa1?: string;
  casa2?: string;
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

  // Odd EFETIVA por lado descontando comissão de exchange (Bolsa de Aposta 1,5% etc.).
  // A comissão vem explícita (comissao1/2) OU resolvida do nome da casa (casa1/2). A odd
  // exibida segue crua; TODA a matemática de arbitragem (gatilho, margem, stake, lucro)
  // usa a efetiva, para o lucro informado já sair líquido da comissão.
  const c1 = comissaoResolvida(input.comissao1, input.casa1);
  const c2 = comissaoResolvida(input.comissao2, input.casa2);
  const eff1 = c1 > 0 ? 1 + (odd1 - 1) * (1 - c1) : odd1;
  const eff2 = c2 > 0 ? 1 + (odd2 - 1) * (1 - c2) : odd2;

  // 2. Cálculo do gatilho mínimo para arbitragem (sobre as odds efetivas)
  const oddMinimaExigida = eff1 / (eff1 - 1);
  const margem = (1 / eff1) + (1 / eff2);
  const isArbitrage = eff2 > oddMinimaExigida;

  // Se não houver arbitragem viável, retornamos que não é arbitragem
  const margemTeoricaPct = Number(((1 - margem) * 100).toFixed(2));

  // 3. Cálculo de limites de aposta individuais (banca * maxStakePct)
  const limit1 = banca1 * maxStakePct;
  const limit2 = banca2 * maxStakePct;

  let rawStake1 = 0;
  let rawStake2 = 0;

  // Tentamos primeiro apostar o limite máximo na Casa 1 e calcular a Casa 2 proporcional
  // (pela odd EFETIVA, para igualar o retorno LÍQUIDO das duas pernas).
  rawStake1 = limit1;
  rawStake2 = rawStake1 * (eff1 / eff2);

  // Se ultrapassar o limite da Casa 2, reduzimos proporcionalmente baseado na Casa 2
  if (rawStake2 > limit2) {
    rawStake2 = limit2;
    rawStake1 = rawStake2 * (eff2 / eff1);
  }

  // 4. Aplicação das regras de arredondamento configuráveis por casa
  // Formata com toFixed(2) para contornar problemas de ponto flutuante do JavaScript
  const stake1 = Number((Math.round(rawStake1 / roundStep1) * roundStep1).toFixed(2));
  const stake2 = Number((Math.round(rawStake2 / roundStep2) * roundStep2).toFixed(2));

  // 5. Cálculo dos retornos reais pós-arredondamento (LÍQUIDOS de comissão via odd efetiva)
  const investimentoTotal = Number((stake1 + stake2).toFixed(2));

  const retornoCasa1 = Number((stake1 * eff1).toFixed(2));
  const retornoCasa2 = Number((stake2 * eff2).toFixed(2));
  
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
