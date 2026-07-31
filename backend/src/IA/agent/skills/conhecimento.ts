/**
 * SKILL DE CONHECIMENTO — doutrina de promoções/arbitragem + a conversa original com
 * o agente do Gemini (blank.pdf, 30/07/2026).
 *
 * Serve para o agente NÃO inventar regra: em vez de "lembrar" como funciona freebet
 * SNR ou cobertura sequencial, ele busca o trecho e responde citando.
 */

import { Skill } from '../tipos';
import { buscarConhecimento, listarConhecimento, obterConhecimento } from '../../conhecimento';

export const skillBuscarConhecimento: Skill = {
  nome: 'buscar_conhecimento',
  resumo:
    'Busca na doutrina de promoções/arbitragem e na conversa original com o Gemini. Use antes de explicar regra de promoção ou quando o usuário citar \'o que combinamos\'.',
  grupo: 'conhecimento',
  descricao:
    'Busca na base de conhecimento do projeto: doutrina de apostas de promoção (freebet SNR, retenção, ' +
    'qualificativa, cashback, múltipla qualificadora, cobertura sequencial, abuso de bônus, prazos de creditação, ' +
    'riscos de surebet) e a CONVERSA original com o agente do Gemini (com os números e decisões daquele dia). ' +
    'Use antes de explicar qualquer regra de promoção, e sempre que o usuário disser "o que combinamos", ' +
    '"na nossa conversa", "como fizemos antes".',
  parametros: {
    type: 'object',
    properties: {
      consulta: { type: 'string', description: 'Termos da busca (ex.: "retenção freebet odd alta", "cobertura sequencial múltipla").' },
      limite: { type: 'number', description: 'Quantos trechos retornar (default 3, teto 8).' },
      id: { type: 'string', description: 'Pega um trecho específico por id (ex.: "cobertura-sequencial", "conversa-14").' },
      listar: { type: 'boolean', description: 'true = devolve só o índice (ids + títulos) de tudo que existe na base.' },
    },
    additionalProperties: false,
  },
  async executar(args: any) {
    if (args?.listar === true) {
      const idx = listarConhecimento();
      return { total: idx.length, indice: idx };
    }
    if (args?.id) {
      const doc = obterConhecimento(args.id);
      return doc ? { trecho: doc } : { erro: `id "${args.id}" não existe`, dica: 'chame com listar=true para ver os ids' };
    }
    const consulta = (args?.consulta || '').toString();
    // Teto BAIXO de propósito (2, no máximo 4): cada trecho da doutrina tem 1-2,5k
    // caracteres e o resultado fica no histórico, reenviado em toda rodada seguinte —
    // 5 trechos estouravam o teto por request da Groq (413). Precisa de mais? Pede por id.
    const limite = Math.max(1, Math.min(4, Number(args?.limite) || 2));
    const achados = buscarConhecimento(consulta, limite).map((t) => ({
      ...t,
      texto: t.texto.length > 1400 ? `${t.texto.slice(0, 1400)}… [truncado — peça este trecho por id="${t.id}" se precisar do resto]` : t.texto,
    }));
    if (!achados.length) {
      return {
        consulta,
        total: 0,
        dica: 'Nada casou. Tente termos do domínio (freebet, retenção, qualificadora, sequencial, cashback) ou listar=true.',
      };
    }
    return {
      consulta,
      total: achados.length,
      trechos: achados,
      nota: 'fonte "doutrina" = regra que você DEVE seguir; "conversa_gemini" = histórico, pode conter conta ' +
        'otimista (a doutrina corrige o mito de que odd maior sempre retém mais).',
    };
  },
};

export const SKILLS_CONHECIMENTO: Skill[] = [skillBuscarConhecimento];
