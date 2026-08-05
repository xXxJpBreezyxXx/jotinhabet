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
import {
  calcularPromocao,
  ehFreebetSemCusto,
  ehTipoComBoost,
  promoTypeDoTipo,
  tipoPromocaoDeTexto,
  TIPOS_PROMOCAO,
  VALOR_BONUS_PADRAO_PCT,
} from '../../../core/promocoes';
import { WhatsAppNotifier } from '../../../notify/whatsapp';

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * null/''/NaN → undefined, para percentual OPCIONAL que segue para o core.
 *
 * Provedores de function calling mandam `null` em parâmetro opcional, e o núcleo lê
 * Number(null) como 0 — que é *entrada válida* em valorBonusPct ("esse bônus não vale
 * nada"). Sem esta limpeza, um null vira 0 e a devolução em bônus é contada como zero em
 * silêncio, quando o certo é cair no default de 70%.
 */
const pctOpcional = (v: any): number | undefined =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);

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
      linha: { type: 'number', description: 'Ex.: 2.5, -1.5. Omita se não houver.' },
      opcaoA: { type: 'string' },
      opcaoB: { type: 'string' },
      oddA: { type: 'number' },
      oddB: { type: 'number' },
      casaA: { type: 'string' },
      casaB: { type: 'string' },
      dataHora: { type: 'string', description: '"DD/MM/AAAA HH:MM" (Brasília).' },
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
    'ESCRITA: grava uma aposta de promoção (os 6 tipos, incl. SRR/super odd/lucro extra) no histórico do app. Só com pedido explícito.',
  grupo: 'acao',
  escrita: true,
  descricao:
    'Grava uma aposta de promoção no histórico do app (aba Promoções) em qualquer um dos 6 tipos — freebet SNR, ' +
    'freebet SRR, qualificativa, proteção, super odd e lucro extra: tipo, casas, valores, odds, lucro e ROI, mais ' +
    'os campos que o tipo usa (odd padrão da super odd, % do boost, face e valor efetivo do extra, odd efetiva da ' +
    'perna). Derivações automáticas: aporte equalizado da cobertura, lucro do pior cenário e ROI sobre o dinheiro ' +
    'REAL investido (freebet não conta a ficha). Use SÓ quando o usuário pedir para registrar/salvar a promoção.',
  parametros: {
    type: 'object',
    properties: {
      // enum do vocabulário do core (tipoPromocaoDeTexto aceita texto livre também): a lista
      // em prosa dos 6 tipos chegaria TRUNCADA ao modelo, escondendo o último tipo.
      tipo: { type: 'string', enum: [...TIPOS_PROMOCAO] },
      evento: { type: 'string' },
      mercado: { type: 'string' },
      casa_promocao: { type: 'string' },
      valor_promocao: { type: 'number' },
      odd_promocao: { type: 'number' },
      casa_cobertura: { type: 'string' },
      valor_cobertura: { type: 'number', description: 'Vazio = aporte equalizado.' },
      odd_cobertura: { type: 'number' },
      // Aqui a devolução entra em REAIS (já com o teto do regulamento aplicado): o %, o teto,
      // o valor do bônus e os tetos de regulamento são trabalho da calculadora, e cada param
      // exposto pesa em toda rodada. Do boost só entram os dois que o core NÃO deriva.
      cashback: { type: 'number', description: 'PROTEÇÃO: devolução em reais se perder.' },
      cashback_eh_bonus: { type: 'boolean', description: 'true = devolução/extra em BÔNUS.' },
      odd_padrao: { type: 'number', description: 'SUPERODD: a odd NORMAL, sem o boost.' },
      boost_pct: { type: 'number', description: 'LUCRO_EXTRA: % de lucro extra.' },
      // Sem este param a operação que a calculadora acabou de mandar executar ("aposte só
      // R$ 30, o teto") não era registrável: o modelo gravava a stake cheia e o lucro/ROI
      // saíam de uma stake que nunca foi à mesa.
      teto_stake: { type: 'number', description: 'Stake máxima que a promoção aceita.' },
    },
    required: ['evento', 'casa_promocao', 'valor_promocao', 'casa_cobertura'],
    additionalProperties: false,
  },
  async executar(args: any) {
    // Tradutores do core nas DUAS pontas: tipoPromocaoDeTexto entende o texto livre do
    // modelo e promoTypeDoTipo faz a única tradução para o banco (QUALIFICATIVA → QUALIFYING).
    // O mapeamento manual que existia aqui colava qualquer tipo novo em FREEBET_SNR — a
    // linha ficava gravada com a matemática de outro tipo e ninguém percebia.
    const tipo = tipoPromocaoDeTexto(args?.tipo);
    const promoType = promoTypeDoTipo(tipo);
    const comBoost = ehTipoComBoost(tipo);
    // Um flag só para "o benefício vem em BÔNUS": devolução (proteção) e extra (boost) são o
    // mesmo fato do regulamento, e dois booleanos gêmeos custariam cota em toda rodada.
    const emBonus = args?.cashback_eh_bonus === true;
    const valorPromocao = Number(args?.valor_promocao);
    const oddPromocao = Number(args?.odd_promocao);
    const oddCobertura = Number(args?.odd_cobertura);
    const aporteInformado = Number(args?.valor_cobertura);
    const temCashback = tipo === 'PROTECAO' || Number(args?.cashback) > 0 || Number(args?.cashback_pct) > 0;

    const calc =
      oddPromocao > 1 && oddCobertura > 1 && valorPromocao > 0
        ? calcularPromocao({
            tipo,
            promoStake: valorPromocao,
            promoOdd: oddPromocao,
            coverOdd: oddCobertura,
            coverStake: Number.isFinite(aporteInformado) && aporteInformado > 0 ? aporteInformado : null,
            cashback: args?.cashback,
            cashbackPct: args?.cashback_pct,
            cashbackTeto: args?.cashback_teto,
            cashbackEhBonus: emBonus,
            valorBonusPct: pctOpcional(args?.valor_bonus_pct),
            oddPadrao: args?.odd_padrao,
            tetoStake: args?.teto_stake,
            boostPct: args?.boost_pct,
            extraEmBonus: comBoost && emBonus,
            // As duas casas entram para a comissão de exchange valer aqui como vale na
            // calculadora: sem casaPromo, uma perna na Bolsa de Aposta era gravada com odd
            // crua e o histórico divergia do preview que o usuário viu antes de apostar.
            casaPromo: args?.casa_promocao ? canonizarCasa(args.casa_promocao) : null,
            casaCobertura: args?.casa_cobertura ? canonizarCasa(args.casa_cobertura) : null,
          })
        : null;
    // Sem as duas odds não há lucro derivável, e `lucro` é NOT NULL na tabela: antes o INSERT
    // ia até o banco e voltava como erro de constraint (mensagem que não diz o que fazer).
    if (!calc) {
      return {
        registrada: false,
        erro:
          'preciso de valor_promocao > 0, odd_promocao e odd_cobertura > 1 — sem as duas odds não dá para derivar o ' +
          'aporte equalizado, o lucro do pior cenário nem o ROI (e o histórico exige o lucro)',
      };
    }
    const valorCobertura = calc.coverStake;
    if (!(valorCobertura > 0)) {
      return { registrada: false, erro: 'o aporte de cobertura derivado ficou em zero — confira as odds informadas' };
    }
    const lucro = calc.lucroGarantido;
    // Investimento real e ROI vêm do core: ele já aplica ehFreebetSemCusto (SNR e SRR não
    // contam a ficha) sobre a stake ELEGÍVEL. Reimplementar a polaridade aqui foi o que
    // produziu as duas regras opostas do repo (blacklist no backend, whitelist no frontend).
    const investido = calc.investimentoReal;
    const roi = calc.roiPct;

    // Degradação sem migration: coluna nova só entra no INSERT quando o tipo realmente a usa.
    // O PostgREST rejeita o INSERT INTEIRO por uma coluna desconhecida, então mandar sempre
    // as colunas novas quebraria freebet/qualificativa num banco que ainda não recebeu a 022.
    const opcionais: Record<string, any> = {};
    if (temCashback) {
      opcionais.cashback = calc.cashbackNominal;
      opcionais.cashback_pct = Number(args?.cashback_pct) > 0 ? Number(args.cashback_pct) : null;
      opcionais.cashback_teto = Number(args?.cashback_teto) > 0 ? Number(args.cashback_teto) : null;
      opcionais.cashback_eh_bonus = emBonus;
      // `?? default` e não `|| default`: 0 é valor VÁLIDO (bônus que não dá para converter).
      opcionais.valor_bonus_pct = emBonus ? pctOpcional(args?.valor_bonus_pct) ?? VALOR_BONUS_PADRAO_PCT : null;
    }
    if (tipo === 'FREEBET_SRR') {
      // Sem gravar o v a linha não reproduz: ficha em dinheiro (100) e ficha em bônus (70)
      // dão lucros diferentes sob o MESMO tipo. Aqui é sempre o default do core (dinheiro),
      // porque valor_ficha_pct não é parâmetro desta skill.
      opcionais.valor_ficha_pct = 100;
    }
    if (comBoost) {
      if (tipo === 'SUPERODD') opcionais.odd_padrao = Number(args?.odd_padrao) > 1 ? Number(args.odd_padrao) : null;
      if (tipo === 'LUCRO_EXTRA') opcionais.boost_pct = Number(args?.boost_pct) > 0 ? Number(args.boost_pct) : null;
      opcionais.extra_em_bonus = emBonus;
      opcionais.valor_extra_pct = emBonus ? VALOR_BONUS_PADRAO_PCT : null;
      // Derivados do core: quem recalcula o boost em outra camada acaba divergindo do que
      // foi executado — o histórico tem de guardar o número que saiu daqui.
      opcionais.extra_nominal = calc.extraNominal;
      opcionais.extra_efetivo = calc.extraEfetivo;
    }
    // odd_efetiva_promo é da 022: só vai onde a migration já é obrigatória por outra coluna.
    // Nos tipos antigos ela é a própria odd_promocao e não vale arriscar o INSERT.
    if (tipo === 'FREEBET_SRR' || comBoost) opcionais.odd_efetiva_promo = calc.oddEfetivaPromo;
    // Teto de stake é cláusula de REGULAMENTO (vale em qualquer tipo) e a stake que foi à
    // mesa é a elegível: sem gravar as duas, o histórico soma a stake digitada e o
    // "Investido" da aba passa a divergir do roi_pct da própria linha.
    if (Number(args?.teto_stake) > 0) {
      opcionais.teto_stake = Number(args.teto_stake);
      opcionais.stake_elegivel = calc.stakeElegivel;
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
          odd_promocao: oddPromocao,
          odd_cobertura: oddCobertura,
          roi_pct: roi,
          lucro,
          ...opcionais,
        })
        .select()
        .single();
      if (error) throw error;
      return {
        registrada: true,
        promocao: data,
        tipo,
        lucro,
        investimento_real: r2(investido),
        // Base do ROI, explícita: na freebet (SNR e SRR) a ficha NÃO sai do bolso, então o
        // investimento é só a cobertura. A regra é a do core — este campo só a expõe.
        ficha_conta_no_investimento: !ehFreebetSemCusto(tipo),
        roi_pct: roi,
        avisos: calc.avisos,
      };
    } catch (e: any) {
      const msg = `${e?.message || e}`;
      // SCHEMA ANTES de tabela ausente: o 42703 de coluna inexistente ("column ... does not
      // exist") casa com a regex de tabela e mandava aplicar a 018 sem necessidade.
      // A mensagem NÃO cita número de migration: o texto fixo em "021" mandava reaplicar uma
      // migration já aplicada quando o que faltava era a 022 (a regex /cashback/ passou a
      // casar com o CHECK novo). Aqui dizemos o tipo e as colunas que ESTE insert usou.
      if (/PGRST204|42703|promo_type_check/i.test(msg) || /column .*(schema cache|does not exist)/i.test(msg)) {
        const colunas = Object.keys(opcionais);
        return {
          registrada: false,
          erro:
            `O banco recusou o tipo ${promoType} ou uma coluna desta promoção` +
            `${colunas.length ? ` (${colunas.join(', ')})` : ''}: aplique as migrations pendentes de promo_surebets ` +
            '(src/migrations/0*_promo_*.sql, em ordem) e recarregue o PostgREST.',
          detalhe: msg.slice(0, 160),
        };
      }
      if (/promo_surebets|PGRST205|relation .* does not exist/i.test(msg)) {
        return { registrada: false, erro: 'Tabela promo_surebets ausente no banco (aplique as migrations de promoção).' };
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
      mensagem: { type: 'string', description: 'Curto, direto.' },
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
