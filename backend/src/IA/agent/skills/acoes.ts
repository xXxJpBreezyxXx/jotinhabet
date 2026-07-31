/**
 * SKILLS DE AÇÃO — as únicas que MUDAM estado. Todas exigem pedido EXPLÍCITO do
 * usuário (o system prompt do agente diz isso) e nenhuma delas aposta: o app nunca
 * envia aposta para casa nenhuma.
 *
 *  - criar_oportunidade_no_radar: passa pelo MESMO SignalPipeline dos sinais do
 *    Telegram (gates de risco → dedup → revalidação ao vivo → alerta), então uma
 *    oportunidade inventada pelo modelo é barrada pelos gates, não vai pro WhatsApp.
 *  - registrar_promocao: grava no histórico de promoções (mesma tabela da aba).
 *  - avisar_no_whatsapp: DESLIGADA por padrão (AGENT_WHATSAPP_SKILL=1 para ligar) —
 *    o destino é o grupo de alertas e ninguém quer o grupo virando chat do copiloto.
 */

import { Skill, ContextoSkills } from '../tipos';
import { supabase } from '../../../db/client';
import { SignalPipeline } from '../../../signals/signalPipeline';
import { SinalExtraido } from '../../extractors/telegramSignalExtractor';
import { resumirResultadoCriacao } from '../../copilot';
import { canonizarCasa } from '../../../signals/casasAliases';
import { calcularPromocao, TipoPromocao } from '../../../core/promocoes';
import { WhatsAppNotifier } from '../../../notify/whatsapp';

const r2 = (v: number) => Math.round(v * 100) / 100;

export const skillCriarOportunidade: Skill = {
  nome: 'criar_oportunidade_no_radar',
  resumo:
    'ESCRITA: registra uma surebet no radar (passa por gates de risco, dedup e revalidação). Só com pedido explícito.',
  grupo: 'acao',
  escrita: true,
  descricao:
    'Registra uma surebet no radar do app (passa pelos gates de risco, dedup e revalidação ao vivo antes de ' +
    'qualquer alerta). Use SOMENTE quando o usuário pedir explicitamente para lançar/criar/registrar a ' +
    'oportunidade. NUNCA invente odd, casa ou evento: use o que o usuário disse ou o que veio de uma skill.',
  parametros: {
    type: 'object',
    properties: {
      evento: { type: 'string', description: 'Ex.: "Grêmio x Bolívar".' },
      esporte: { type: 'string' },
      mercado: { type: 'string' },
      linha: { type: 'number', description: 'Linha do mercado (2.5, -1.5). Omita se não houver.' },
      opcaoA: { type: 'string' },
      opcaoB: { type: 'string' },
      oddA: { type: 'number' },
      oddB: { type: 'number' },
      casaA: { type: 'string' },
      casaB: { type: 'string' },
      dataHora: { type: 'string', description: 'Início da partida em "DD/MM/AAAA HH:MM" (horário de Brasília).' },
    },
    required: ['evento', 'esporte', 'mercado', 'opcaoA', 'opcaoB', 'oddA', 'oddB', 'casaA', 'casaB'],
    additionalProperties: false,
  },
  async executar(args: any, ctx: ContextoSkills) {
    const oddA = Number(args?.oddA);
    const oddB = Number(args?.oddB);
    if (!(oddA > 1) || !(oddB > 1)) return { erro: 'oddA e oddB devem ser > 1' };
    const soma = 1 / oddA + 1 / oddB;
    if (soma >= 1) {
      return {
        criada: false,
        erro: `esse par NÃO fecha arbitragem: 1/${oddA} + 1/${oddB} = ${soma.toFixed(4)} ≥ 1`,
        faltaPct: r2((soma - 1) * 100),
      };
    }
    const dh = (args?.dataHora || '').toString().trim();
    if (dh && !/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}$/.test(dh)) {
      return { erro: 'dataHora deve ser "DD/MM/AAAA HH:MM" (ou omitida)' };
    }

    const sinal: SinalExtraido = {
      eh_sinal: true,
      confianca: 100, // dados estruturados vindos do chat (não há incerteza de OCR)
      evento: `${args.evento}`.trim(),
      esporte: `${args.esporte}`.trim(),
      mercado: `${args.mercado}`.trim(),
      // Number(null) e Number('') são 0 (finitos!) e modelos preenchem opcional com null:
      // sem este guarda, uma surebet SEM linha entrava com linha 0 e a revalidação não
      // achava mais nenhuma perna (mesmaOferta compara linha).
      linha:
        args?.linha === null || args?.linha === undefined || args?.linha === '' || !Number.isFinite(Number(args.linha))
          ? null
          : Number(args.linha),
      opcaoA: `${args.opcaoA}`.trim(),
      opcaoB: `${args.opcaoB}`.trim(),
      oddA,
      oddB,
      casaA: canonizarCasa(args.casaA),
      casaB: canonizarCasa(args.casaB),
      dataHora: dh || null,
    };
    const resultado = await new SignalPipeline(ctx.revalidation).processarSinal(sinal, { fonte: 'copiloto' });
    return {
      criada: resultado.acao !== 'erro' && resultado.acao !== 'bloqueada_regras',
      acao: resultado.acao,
      motivo: resultado.motivo || null,
      resumo_para_o_usuario: resumirResultadoCriacao(resultado),
      roi_pct: r2((1 / soma - 1) * 100),
    };
  },
};

export const skillRegistrarPromocao: Skill = {
  nome: 'registrar_promocao',
  resumo:
    'ESCRITA: grava uma aposta de promoção no histórico do app. Só com pedido explícito.',
  grupo: 'acao',
  escrita: true,
  descricao:
    'Grava uma aposta de promoção no histórico do app (aba Promoções): tipo, casas, valores, odds, lucro e ROI. ' +
    'Derivações automáticas quando faltarem: aporte equalizado da cobertura, lucro do pior cenário e ROI. ' +
    'Use SÓ quando o usuário pedir para registrar/salvar a promoção.',
  parametros: {
    type: 'object',
    properties: {
      tipo: { type: 'string', description: 'FREEBET_SNR (default) ou QUALIFICATIVA.' },
      evento: { type: 'string' },
      mercado: { type: 'string' },
      casa_promocao: { type: 'string' },
      valor_promocao: { type: 'number' },
      odd_promocao: { type: 'number' },
      casa_cobertura: { type: 'string' },
      valor_cobertura: { type: 'number', description: 'Vazio = calcula o aporte equalizado.' },
      odd_cobertura: { type: 'number' },
    },
    required: ['evento', 'casa_promocao', 'valor_promocao', 'casa_cobertura'],
    additionalProperties: false,
  },
  async executar(args: any) {
    const tipo: TipoPromocao = /QUALIF/i.test(`${args?.tipo}`) ? 'QUALIFICATIVA' : 'FREEBET_SNR';
    const promoType = tipo === 'QUALIFICATIVA' ? 'QUALIFYING' : 'FREEBET_SNR';
    const valorPromocao = Number(args?.valor_promocao);
    const oddPromocao = Number(args?.odd_promocao);
    const oddCobertura = Number(args?.odd_cobertura);
    let valorCobertura = Number(args?.valor_cobertura);
    let lucro: number | null = null;
    let roi: number | null = null;

    if (oddPromocao > 1 && oddCobertura > 1 && valorPromocao > 0) {
      const calc = calcularPromocao({
        tipo,
        promoStake: valorPromocao,
        promoOdd: oddPromocao,
        coverOdd: oddCobertura,
        coverStake: Number.isFinite(valorCobertura) && valorCobertura > 0 ? valorCobertura : null,
        casaCobertura: args?.casa_cobertura ? canonizarCasa(args.casa_cobertura) : null,
      });
      if (calc) {
        valorCobertura = calc.coverStake;
        lucro = calc.lucroGarantido;
        roi = calc.roiPct;
      }
    }
    if (!Number.isFinite(valorCobertura) || valorCobertura <= 0) {
      return { erro: 'informe valor_cobertura OU as odds das duas pernas (para derivar o aporte equalizado)' };
    }

    try {
      const { data, error } = await supabase
        .from('promo_surebets')
        .insert({
          promo_type: promoType,
          casa_promocao: canonizarCasa(args.casa_promocao),
          valor_promocao: valorPromocao,
          evento: `${args.evento}`.trim(),
          mercado: args?.mercado ? `${args.mercado}`.trim() : null,
          casa_cobertura: canonizarCasa(args.casa_cobertura),
          valor_cobertura: r2(valorCobertura),
          odd_promocao: oddPromocao > 1 ? oddPromocao : null,
          odd_cobertura: oddCobertura > 1 ? oddCobertura : null,
          roi_pct: roi,
          lucro,
        })
        .select()
        .single();
      if (error) throw error;
      return { registrada: true, promocao: data, lucro, roi_pct: roi };
    } catch (e: any) {
      const msg = `${e?.message || e}`;
      if (/promo_surebets|does not exist|PGRST205/i.test(msg)) {
        return { registrada: false, erro: 'Tabela promo_surebets ausente no banco (aplique a migration 018).' };
      }
      return { registrada: false, erro: msg.slice(0, 200) };
    }
  },
};

export const skillAvisarWhatsApp: Skill = {
  nome: 'avisar_no_whatsapp',
  resumo:
    'ESCRITA: manda UMA mensagem no WhatsApp de alertas. Só se o usuário pedir; desligada por padrão.',
  grupo: 'acao',
  escrita: true,
  descricao:
    'Envia UMA mensagem de texto para o destino de alertas do WhatsApp. Use apenas se o usuário pedir ' +
    'explicitamente ("me manda no zap"). Desligada por padrão em produção.',
  parametros: {
    type: 'object',
    properties: {
      mensagem: { type: 'string', description: 'Texto a enviar (curto, direto).' },
    },
    required: ['mensagem'],
    additionalProperties: false,
  },
  async executar(args: any) {
    if (process.env.AGENT_WHATSAPP_SKILL !== '1') {
      return {
        enviado: false,
        motivo:
          'skill desabilitada (AGENT_WHATSAPP_SKILL != 1). O destino é o grupo de alertas de surebet — ' +
          'habilite no .env se quiser que o agente escreva lá.',
      };
    }
    const texto = `${args?.mensagem || ''}`.trim();
    if (!texto) return { enviado: false, motivo: 'mensagem vazia' };
    const ok = await new WhatsAppNotifier().enviarTexto(`🤖 *Copiloto JotinhaBet*\n\n${texto.slice(0, 1500)}`);
    return { enviado: ok, motivo: ok ? null : 'Evolution API indisponível ou mal configurada' };
  },
};

export const SKILLS_ACOES: Skill[] = [skillCriarOportunidade, skillRegistrarPromocao, skillAvisarWhatsApp];
