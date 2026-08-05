/**
 * SKILLS DE REGRAS — Diretrizes de mercado, grupos de W.O. do tênis e políticas de
 * anulação por casa.
 *
 * Estas skills são a autoridade DETERMINÍSTICA do app (arbitrage/regras.ts +
 * IA/regrasCasas.ts). O modelo não deve "lembrar" a política de cada casa: ele
 * consulta aqui. Se a resposta é "desconhecida", o certo é bloquear, não chutar.
 */

import { Skill } from '../tipos';
import { regraPermiteOportunidade, grupoTenis, mercadoPermitido, casaBloqueada } from '../../../arbitrage/regras';
import { normalizarMercado } from '../../../arbitrage/markets';
import { REGRAS_CASAS } from '../../regrasCasas';
import { normalizarCasa } from '../../riskAnalyzer';
import { canonizarCasa } from '../../../signals/casasAliases';
import { comissaoDaCasa } from '../../../arbitrage/comissao';
import { DOUTRINA_MERCADOS } from '../../doutrinaMercados';

export const skillChecarPar: Skill = {
  nome: 'checar_regras_do_par',
  resumo:
    'Diz se esporte+mercado+casaA+casaB é permitido pelas Diretrizes de SUREBET (mercado proibido, grupos de W.O., regra da KTO). Em promoção (finalidade="promocao") as Diretrizes NÃO bloqueiam — só informam risco.',
  grupo: 'regras',
  descricao:
    'Verifica se um par (esporte + mercado + casa A + casa B) é PERMITIDO pelas Diretrizes do projeto: mercados ' +
    'proibidos (ex.: 1X2 no futebol, prorrogação no basquete), grupos de W.O. do tênis (A só cruza com A) e a ' +
    'regra própria da KTO. Use SEMPRE antes de recomendar uma operação ou explicar por que o app bloqueou algo.',
  parametros: {
    type: 'object',
    properties: {
      esporte: { type: 'string', description: 'Futebol | Basquete | Tênis | Tênis de Mesa | E-sports.' },
      mercado: { type: 'string', description: 'Como aparece na casa.' },
      casaA: { type: 'string' },
      casaB: { type: 'string' },
      // Enum em vez da prosa de 166 chars: ela era TRUNCADA em 67 antes de chegar ao modelo,
      // ou seja a metade que explicava "promocao" nunca chegava — e o modelo, sem saber que o
      // valor existia, deixava as Diretrizes de surebet bloquearem operações de promoção.
      // O resumo da skill carrega a semântica; aqui basta o vocabulário aceito.
      finalidade: { type: 'string', enum: ['surebet', 'promocao'] },
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
    // PROMOÇÃO não é arbitragem: o mercado é o que o regulamento exige (1X2 numa
    // qualificativa é o caso comum) e o resultado não é lucro garantido, então mercado
    // proibido e grupo de W.O. — que existem para não transformar lucro garantido em
    // prejuízo garantido — não têm o que bloquear. O diagnóstico continua vindo, como AVISO.
    // CASA VETADA não é regra de mercado: vale também em promoção (a EsporteNetBet não é
    // operadora regulada — não há promoção legítima a cobrir lá).
    const vetada = [casaA, casaB].find((c) => casaBloqueada(c));
    if (vetada) {
      return {
        permitido: false,
        motivo_bloqueio: `casa vetada na operação: ${vetada}`,
        vale_para_promocao_tambem: true,
        nota: 'Bloqueio por CASA (decisão da operação), não por mercado — não é contornável com finalidade="promocao".',
      };
    }
    const ehPromocao = /promo|freebet|qualific|cashback|multipla|aposte/i.test(`${args?.finalidade || ''}`);
    if (ehPromocao) {
      return {
        finalidade: 'promocao',
        permitido: true,
        regras_de_surebet_aplicadas: false,
        aviso: veredito.ok
          ? null
          : `As Diretrizes bloqueariam este par em SUREBET (${veredito.motivo}), mas em promoção isso NÃO impede a operação.`,
        risco_residual:
          /t[êe]nis/i.test(`${args?.esporte || ''}`) && grupoTenis(casaA) !== grupoTenis(casaB)
            ? 'Tênis com casas de grupos de W.O. diferentes: em abandono uma perna pode anular e a outra liquidar — a exposição é o aporte da cobertura, não red garantido. Prefira mesmo grupo quando houver escolha.'
            : null,
        mercado_informado: args?.mercado,
        mercado_canonico: normalizarMercado(args?.mercado || ''),
        grupo_wo_tenis: { [casaA]: grupoTenis(casaA), [casaB]: grupoTenis(casaB) },
        nota:
          'Em promoção o que manda é o REGULAMENTO da casa (odd mínima, mercados elegíveis, prazo) — ' +
          'use calcular_cobertura_promocao / calcular_multipla_qualificadora / montar_multipla_promocao.',
      };
    }
    return {
      finalidade: 'surebet',
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
      casa: { type: 'string' },
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
