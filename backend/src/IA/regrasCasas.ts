/**
 * Base de conhecimento CURADA de políticas de anulação (void) por casa/esporte.
 *
 * Implementada como módulo .ts (e não .json) de propósito: o `tsc` não copia
 * arquivos .json para `dist/`, então um `import './regras_casas.json'` quebraria
 * em produção. Como .ts, compila e é resolvido normalmente.
 *
 * A comparação de conflito é DETERMINÍSTICA (feita em riskAnalyzer.ts); a IA
 * apenas EXPLICA a divergência em linguagem natural. Curar/expandir esta tabela
 * é mais confiável e barato do que pedir ao LLM para "lembrar" a política de
 * cada casa.
 *
 * Valores possíveis de política:
 *  - 'resolvida'    → a casa mantém/resolve a aposta (ex.: quem avançou vence)
 *  - 'anulada'      → a casa anula (void) e devolve o stake
 *  - 'desconhecida' → não catalogado (não gera alerta de conflito)
 */

export type PoliticaVoid = 'resolvida' | 'anulada' | 'desconhecida';

export interface PoliticaCasa {
  /** Desistência/W.O. antes de completar (walkover / retirement). */
  walkover: PoliticaVoid;
  /** Partida abandonada/suspensa após iniciada. */
  abandono: PoliticaVoid;
}

export interface RegrasEsporte {
  descricao: string;
  casas: Record<string, PoliticaCasa>;
}

/**
 * Chaves de casa em minúsculas e sem espaços/acentos (ver normalizarCasa()).
 * Chaves de esporte normalizadas (ver normalizarEsporte()).
 */
export const REGRAS_CASAS: Record<string, RegrasEsporte> = {
  tenis: {
    descricao:
      'No tênis, casas divergem no tratamento de desistência (retirement/walkover): ' +
      'algumas consideram resolvida a favor de quem avançou, outras anulam a aposta.',
    casas: {
      bet365: { walkover: 'resolvida', abandono: 'resolvida' },
      betano: { walkover: 'anulada', abandono: 'anulada' },
      kto: { walkover: 'anulada', abandono: 'anulada' },
      superbet: { walkover: 'anulada', abandono: 'anulada' },
      '1xbet': { walkover: 'resolvida', abandono: 'anulada' },
      blaze: { walkover: 'desconhecida', abandono: 'desconhecida' },
    },
  },
  basquete: {
    descricao:
      'No basquete, o tratamento de prorrogação (overtime) e de jogos encerrados ' +
      'antes do tempo regulamentar varia entre casas.',
    casas: {
      bet365: { walkover: 'resolvida', abandono: 'anulada' },
      betano: { walkover: 'resolvida', abandono: 'anulada' },
      kto: { walkover: 'desconhecida', abandono: 'anulada' },
      superbet: { walkover: 'desconhecida', abandono: 'anulada' },
      '1xbet': { walkover: 'desconhecida', abandono: 'anulada' },
      blaze: { walkover: 'desconhecida', abandono: 'desconhecida' },
    },
  },
  futebol: {
    descricao:
      'No futebol pré-jogo (mercados de resultado final), a maioria das casas ' +
      'anula apostas em partidas adiadas/abandonadas — divergência menor, mas existe.',
    casas: {
      bet365: { walkover: 'anulada', abandono: 'anulada' },
      betano: { walkover: 'anulada', abandono: 'anulada' },
      kto: { walkover: 'anulada', abandono: 'anulada' },
      superbet: { walkover: 'anulada', abandono: 'anulada' },
      '1xbet': { walkover: 'anulada', abandono: 'anulada' },
      blaze: { walkover: 'desconhecida', abandono: 'desconhecida' },
    },
  },
};
