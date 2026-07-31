/**
 * SKILLS DE REGRAS — Diretrizes de mercado, grupos de W.O. do tênis e políticas de
 * anulação por casa.
 *
 * Estas skills são a autoridade DETERMINÍSTICA do app (arbitrage/regras.ts +
 * IA/regrasCasas.ts). O modelo não deve "lembrar" a política de cada casa: ele
 * consulta aqui. Se a resposta é "desconhecida", o certo é bloquear, não chutar.
 */

import { Skill } from '../tipos';
import { regraPermiteOportunidade, grupoTenis, mercadoPermitido } from '../../../arbitrage/regras';
import { normalizarMercado } from '../../../arbitrage/markets';
import { REGRAS_CASAS } from '../../regrasCasas';
import { normalizarCasa } from '../../riskAnalyzer';
import { canonizarCasa } from '../../../signals/casasAliases';
import { comissaoDaCasa } from '../../../arbitrage/comissao';
import { DOUTRINA_MERCADOS } from '../../doutrinaMercados';

export const skillChecarPar: Skill = {
  nome: 'checar_regras_do_par',
  resumo:
    'Diz se esporte+mercado+casaA+casaB é permitido pelas Diretrizes (mercado proibido, grupos de W.O. do tênis, regra da KTO). Use antes de recomendar operação.',
  grupo: 'regras',
  descricao:
    'Verifica se um par (esporte + mercado + casa A + casa B) é PERMITIDO pelas Diretrizes do projeto: mercados ' +
    'proibidos (ex.: 1X2 no futebol, prorrogação no basquete), grupos de W.O. do tênis (A só cruza com A) e a ' +
    'regra própria da KTO. Use SEMPRE antes de recomendar uma operação ou explicar por que o app bloqueou algo.',
  parametros: {
    type: 'object',
    properties: {
      esporte: { type: 'string', description: 'Futebol | Basquete | Tênis | Tênis de Mesa | E-sports.' },
      mercado: { type: 'string', description: 'Nome do mercado como aparece na casa.' },
      casaA: { type: 'string' },
      casaB: { type: 'string' },
    },
    required: ['mercado', 'casaA', 'casaB'],
    additionalProperties: false,
  },
  async executar(args: any) {
    const casaA = canonizarCasa(args?.casaA || '');
    const casaB = canonizarCasa(args?.casaB || '');
    const veredito = regraPermiteOportunidade({
      esporte: args?.esporte,
      mercado: args?.mercado || '',
      casaA,
      casaB,
    });
    return {
      permitido: veredito.ok,
      motivo_bloqueio: veredito.ok ? null : veredito.motivo,
      mercado_informado: args?.mercado,
      mercado_canonico: normalizarMercado(args?.mercado || ''),
      mercado_permitido_no_esporte: mercadoPermitido(args?.esporte, args?.mercado || ''),
      grupo_wo_tenis: { [casaA]: grupoTenis(casaA), [casaB]: grupoTenis(casaB) },
      comissao_exchange_pct: {
        [casaA]: Math.round(comissaoDaCasa(casaA) * 10000) / 100,
        [casaB]: Math.round(comissaoDaCasa(casaB) * 10000) / 100,
      },
      diretrizes: DOUTRINA_MERCADOS,
    };
  },
};

export const skillRegrasCasa: Skill = {
  nome: 'regras_de_anulacao_da_casa',
  resumo:
    'Política catalogada de anulação (W.O./abandono) de uma casa por esporte, e o grupo de W.O. do tênis.',
  grupo: 'regras',
  descricao:
    'Política catalogada de anulação (void) de uma casa por esporte: W.O./desistência e partida abandonada. ' +
    'Use quando o usuário perguntar "essa casa anula em caso de W.O.?" ou para explicar risco de void divergente ' +
    'entre as duas pernas.',
  parametros: {
    type: 'object',
    properties: {
      casa: { type: 'string', description: 'Nome da casa.' },
      esporte: { type: 'string', description: 'tenis | basquete | futebol (vazio = todos).' },
    },
    required: ['casa'],
    additionalProperties: false,
  },
  async executar(args: any) {
    const casaCanon = canonizarCasa(args?.casa || '');
    const chave = normalizarCasa(casaCanon);
    const esporteFiltro = (args?.esporte || '')
      .toString()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();

    const porEsporte: Record<string, any> = {};
    for (const [esporte, regras] of Object.entries(REGRAS_CASAS)) {
      if (esporteFiltro && !esporte.includes(esporteFiltro)) continue;
      const pol = regras.casas[chave];
      porEsporte[esporte] = {
        descricao: regras.descricao,
        politica: pol || { walkover: 'desconhecida', abandono: 'desconhecida' },
        catalogada: !!pol,
      };
    }
    return {
      casa: casaCanon,
      chave,
      grupo_wo_tenis: grupoTenis(casaCanon),
      politicas: porEsporte,
      nota:
        'Política "desconhecida" NÃO é permissão: o app bloqueia o cruzamento no tênis quando o grupo de W.O. é ' +
        'desconhecido (fail-safe). Grupos A×B são incompatíveis: uma perna anula e a outra perde.',
    };
  },
};

export const SKILLS_REGRAS: Skill[] = [skillChecarPar, skillRegrasCasa];
