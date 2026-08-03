/**
 * LOOP DO AGENTE (aba "IA & Automação").
 *
 * Substitui o chat de turno único por um agente ReAct com ferramentas: o modelo pede
 * skills (odds ao vivo nas casas, radar, banca, regras, calculadoras, conhecimento),
 * o backend executa e devolve o resultado, e isso repete até ele responder em texto.
 *
 * Guardas que existem por motivo, não por estilo:
 *  - AGENT_MAX_PASSOS (default 6): teto de rodadas de ferramenta por pergunta.
 *  - MAX_CUSTOSAS (default 4): teto de skills que sobem browser/varrem várias casas —
 *    a VPS tem 1 core e um "compara tudo" sem limite a derruba.
 *  - Fallback de provedor NO MEIO do loop: erro do motor (429/5xx/timeout) troca de
 *    provedor mantendo o histórico de ferramentas já colhido.
 *  - Skills de ESCRITA só rodam se a mensagem do usuário pedir explicitamente; o
 *    prompt reforça e o loop registra tudo no trace devolvido ao frontend.
 */

import { RevalidationService } from '../../core/revalidationService';
import { montarContextoAgente } from '../copilot';
import { DOUTRINA_MERCADOS } from '../doutrinaMercados';
import { RESUMO_DOUTRINA_PROMOCOES } from '../conhecimento';
import { resumoCasasParaPrompt } from './catalogoCasas';
import { acharSkill, ferramentasParaModelo, SKILLS } from './registry';
import { cadeiaAgente, criarMotor, MotorChat, MotorNome, MsgAgente } from './chatModels';
import { ContextoSkills, PassoAgente } from './tipos';

export interface MensagemCliente {
  role: 'user' | 'assistant';
  content: string;
}

/** Ajustes por canal de origem (a aba do painel × o grupo do WhatsApp). */
export interface OpcoesAgente {
  /** 'web' (default) = aba IA & Automação; 'whatsapp' = grupo do agente no celular. */
  canal?: 'web' | 'whatsapp';
}

export interface RespostaAgente {
  reply: string;
  provider: MotorNome | 'nenhum';
  modelo: string | null;
  passos: PassoAgente[];
  /** Compatibilidade com o front antigo: preenchido quando uma skill de escrita rodou. */
  acao?: { tipo: string; [k: string]: any };
  avisos: string[];
}

const MAX_PASSOS = () => {
  const n = Number(process.env.AGENT_MAX_PASSOS);
  return Number.isFinite(n) && n > 0 ? Math.min(10, n) : 6;
};
const MAX_CUSTOSAS = () => {
  const n = Number(process.env.AGENT_MAX_SKILLS_CUSTOSAS);
  return Number.isFinite(n) && n > 0 ? Math.min(8, n) : 4;
};
/**
 * Teto de caracteres do payload de UMA skill devolvido ao modelo (~1k tokens).
 * Apertado de propósito: cada resultado fica no histórico e é reenviado em toda rodada
 * seguinte, e o free tier da Groq limita tokens POR MINUTO. Skill que precisa devolver
 * mais deve paginar/filtrar (é por isso que todas têm `limite`).
 */
const MAX_CHARS_RESULTADO = Number(process.env.AGENT_MAX_CHARS_SKILL) > 0
  ? Number(process.env.AGENT_MAX_CHARS_SKILL)
  : 2600;

/** Teto de chamadas de ferramenta na pergunta inteira (soma de todas as rodadas). */
const MAX_CHAMADAS_TOTAL = Number(process.env.AGENT_MAX_CHAMADAS) > 0 ? Number(process.env.AGENT_MAX_CHAMADAS) : 8;
/** Teto de chamadas da MESMA skill (o modelo tende a repetir busca variando a frase). */
const MAX_POR_SKILL = 3;
/** Resultados de ferramenta mais antigos que isto são comprimidos no histórico. */
const RODADAS_EM_DETALHE = 2;
const CHARS_RESULTADO_ANTIGO = 320;

/** Orçamento de tempo de UMA pergunta (o loop para de chamar skill e vai fechar). */
const DEADLINE_MS = Number(process.env.AGENT_DEADLINE_MS) > 0 ? Number(process.env.AGENT_DEADLINE_MS) : 110_000;

/**
 * Comprime resultados de ferramenta de RODADAS ANTIGAS (nunca da rodada corrente).
 *
 * O histórico é reenviado INTEIRO em cada rodada; sem isso, três buscas de 2,6k
 * caracteres somadas ao system prompt estouram o teto por request da Groq (HTTP 413
 * "request too large") e o agente morre no meio do raciocínio — foi exatamente o que
 * aconteceu no smoke de 30/07.
 *
 * O corte é por RODADA, não por quantidade de mensagens: uma rodada pode ter várias
 * tool calls (os modelos da Groq pedem 3 de uma vez com frequência) e contar mensagens
 * mutilava resultados que o modelo ainda ia ler na MESMA rodada.
 */
function comprimirHistorico(historico: MsgAgente[], limiteIndice: number): void {
  for (let i = 0; i < Math.min(limiteIndice, historico.length); i++) {
    const m = historico[i];
    if (m.papel === 'tool' && m.tool && m.tool.conteudo.length > CHARS_RESULTADO_ANTIGO) {
      m.tool.conteudo = `${m.tool.conteudo.slice(0, CHARS_RESULTADO_ANTIGO)}… [resultado de rodada anterior, resumido — chame a skill de novo só se precisar do detalhe]`;
    }
  }
}

/** Mensagem de erro do provedor SEM o corpo cru da resposta (que vai para o log, não para o cliente). */
function resumoErroProvedor(nome: string, err: any): string {
  const msg = `${err?.message || err}`;
  const status = err?.statusHttp ? ` HTTP ${err.statusHttp}` : '';
  if (/credits|quota|insufficient|depleted/i.test(msg)) return `${nome}: sem crédito/cota${status}`;
  if (/rate limit|429/i.test(msg)) return `${nome}: limite de uso momentâneo${status}`;
  if (/request too large|413/i.test(msg)) return `${nome}: pedido acima do limite do modelo${status}`;
  if (/tool_use_failed|did not match schema/i.test(msg)) return `${nome}: erro de formato na chamada de ferramenta${status}`;
  if (/timeout|aborted|ETIMEDOUT/i.test(msg)) return `${nome}: tempo esgotado${status}`;
  if (/API key|401|403/i.test(msg)) return `${nome}: credencial rejeitada${status}`;
  return `${nome}: falha de comunicação${status}`;
}

/**
 * O usuário pediu EXPLICITAMENTE uma ação de escrita nesta mensagem?
 *
 * Só a ÚLTIMA mensagem conta (antes, a regex varria as 40 últimas e uma vez aberto o
 * gate ficava aberto para sempre), exige verbo em forma de pedido com fronteira de
 * palavra + substantivo do domínio, e uma negação/"só me explica" fecha o gate.
 */
export function pediuEscritaExplicita(textoUltimaMensagem: string): boolean {
  const t = (textoUltimaMensagem || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const nega = /\bnao\s+(quero|precisa|preciso|registre|registra|registrar|crie|cria|criar|lance|lanca|lancar|salve|salva|salvar|envie|envia|enviar|mande|manda|mandar)\b|\bso\s+(me\s+)?(explic|calcul|simul|mostr|diga|dizer|responde|responda)/.test(t);
  if (nega) return false;

  // Verbo em forma de ORDEM (imperativo), não no infinitivo dentro de pergunta: "quanto
  // rende CRIAR uma surebet no radar?" é dúvida, "CRIE essa oportunidade" é pedido. O
  // infinitivo só conta acompanhado de marcador de pedido ("pode criar", "quero criar").
  const imperativo = /\b(crie|cria|registre|registra|lance|lanca|salve|salva|cadastre|cadastra|mande|manda|envie|envia|avise|avisa)\b/.test(t);
  const infinitivoComPedido =
    /\b(pode|podes|poderia|consegue|quero|queria|gostaria|preciso|precisa|vamos|favor|deixa)\b[^.?!]{0,40}\b(criar|registrar|lancar|salvar|cadastrar|mandar|enviar|avisar)\b/.test(t);
  const objeto = /\b(oportunidade|surebet|radar|promo|promocao|freebet|historico|whats|whatsapp|zap)\b/.test(t);
  return (imperativo || infinitivoComPedido) && objeto;
}

/**
 * Instrução extra do canal WhatsApp. Sem ela o agente responde como no painel — com
 * tabela de 6 colunas e 40 linhas, ilegível no celular (e a conversão para o dialeto do
 * WhatsApp só resolve a SINTAXE, não o tamanho).
 */
const ESTILO_WHATSAPP = `CANAL: WhatsApp, no celular.
- Seja BREVE: até ~12 linhas. Uma resposta longa é ilegível no celular.
- Nada de tabela com mais de 3 colunas: prefira uma linha por item ("Casa — lado @odd").
- Negrito com **assim** e lista com "- " (o sistema converte para o formato do WhatsApp).
- Números primeiro, ressalva em UMA linha no fim.`;

function systemPrompt(contextoApp: string, canal: OpcoesAgente['canal'] = 'web'): string {
  return `Você é o AGENTE do JotinhaBet: copiloto de arbitragem esportiva (surebets), apostas de promoção (matched betting), gestão de banca e regras de casas de apostas. Responda SEMPRE em português do Brasil, objetivo e prático, com números.

COMO VOCÊ TRABALHA
- Você TEM FERRAMENTAS (skills) com acesso real ao sistema: odds ao vivo nas casas integradas, radar de surebets/value bets, banca e saldos, regras/W.O. por casa, calculadoras e a base de conhecimento. USE-AS em vez de estimar.
- NUNCA peça o nome do jogo quando o usuário quer uma VARREDURA. "quais jogos ao vivo tem na casa X", "vê o que tem de tênis na Y", "tem surebet ao vivo entre X e Y" se resolvem com varrer_jogos_casa (lista os jogos de uma casa) e varrer_surebets_casas (cruza 2-4 casas) — ambas aceitam situacao="ao_vivo" | "pre_jogo" | "todos" e NÃO precisam do nome do evento. Só depois, para detalhar um jogo específico, use consultar_odds_casa/comparar_odds_casas com o nome que a varredura devolveu.
- Casa fora da lista "VARREM jogo em andamento" não coleta partida em andamento: nesse caso diga isso explicitamente — NÃO afirme que "não há jogo ao vivo" na casa.
- NUNCA invente odd, casa, evento, valor de bônus ou regra de promoção. Se não está no CONTEXTO_APP, não veio de uma skill e o usuário não disse: pergunte ou consulte.
- Cálculo de dinheiro é sempre por skill (calcular_surebet, calcular_cobertura_promocao, calcular_multipla_qualificadora). Não faça aritmética de cabeça para dizer aporte.
- Antes de recomendar uma SUREBET entre duas casas, verifique checar_regras_do_par (mercado proibido, grupos de W.O. do tênis).
- ATENÇÃO AO ESCOPO DAS DIRETRIZES: mercado proibido (1X2 etc.) e grupo de W.O. valem para SUREBET. Em operação de PROMOÇÃO (freebet SNR, aposta qualificativa, cashback, "aposte e ganhe", múltipla qualificadora) elas NÃO bloqueiam nada — chame checar_regras_do_par com finalidade="promocao" e trate o retorno como AVISO, nunca como impedimento. Nunca diga a ele que a promoção "não pode" por causa de mercado proibido ou de grupo de W.O.
- Para MONTAR uma múltipla de promoção com odds reais, use montar_multipla_promocao: ele varre a casa da promoção, escolhe as pernas que cumprem o regulamento (odd mínima por seleção e odd total) e já traz a odd de cobertura em outra casa + a cobertura sequencial. Se o usuário mandar o regulamento, extraia dele: odd total mínima, odd mínima por seleção, valor do bilhete e prazo.
- Skills marcadas como lentas (consultar_odds_casa, comparar_odds_casas, revalidar_surebet) custam tempo real: use no máximo o necessário e diga ao usuário o que consultou.
- Skills de ESCRITA (criar_oportunidade_no_radar, registrar_promocao, avisar_no_whatsapp) SÓ com pedido explícito do usuário nesta conversa.
- O sistema NUNCA aposta: a execução é manual. Termine recomendações operacionais lembrando de conferir a odd na tela antes de confirmar.
- Se uma skill falhar ou não achar o evento, diga isso com franqueza (e o motivo) em vez de improvisar um número.

ESTILO
- Vá direto ao ponto: números primeiro, ressalva depois. Nada de promessa de lucro sem risco.
- Ao explicar um alerta, traduza os dois rótulos para o MESMO evento binário; se não conseguir, avise que pode ser falso positivo de matching.

${canal === 'whatsapp' ? `\n${ESTILO_WHATSAPP}\n` : ''}
${DOUTRINA_MERCADOS}

${RESUMO_DOUTRINA_PROMOCOES}

${resumoCasasParaPrompt()}

${contextoApp}`;
}

/** Resumo curto do payload de uma skill para o trace da UI. */
function resumirResultado(nome: string, payload: any): string {
  if (payload == null) return 'sem retorno';
  if (payload.erro) return `erro: ${`${payload.erro}`.slice(0, 120)}`;
  const p = payload;
  if (nome === 'listar_casas') return `${p.total_integradas} casas integradas`;
  if (nome === 'consultar_odds_casa')
    return p.encontrado === false ? `${p.casa}: evento não encontrado` : `${p.casa}: ${p.total_mercados} mercado(s)`;
  if (nome === 'comparar_odds_casas')
    return p.encontrado === false
      ? 'evento não encontrado nas casas consultadas'
      : `${p.casas_com_o_evento?.length || 0} casa(s), ${p.total_mercados_comparados} mercado(s), ${p.surebets_encontradas} surebet(s)`;
  if (nome === 'varrer_jogos_casa')
    return p.erro ? `erro: ${`${p.erro}`.slice(0, 90)}` : `${p.casa}: ${p.total_jogos ?? 0} jogo(s) no recorte ${p.situacao}`;
  if (nome === 'varrer_surebets_casas')
    return p.encontrado === false
      ? 'menos de 2 casas com jogo no recorte'
      : `${p.casas_consultadas?.length || 0} casa(s), ${p.jogos_em_2_ou_mais_casas ?? 0} jogo(s) em comum, ${p.surebets_encontradas ?? 0} surebet(s)`;
  if (nome === 'surebets_no_radar') return `${p.total} surebet(s) no radar`;
  if (nome === 'revalidar_surebet') return `status ${p.status} (ROI atual ${p.roi_atual ?? '—'})`;
  if (nome === 'banca_e_saldos') return `banca R$ ${p.banca_ativa_reais ?? '—'}, ${p.casas_com_saldo?.length || 0} casa(s) com saldo`;
  if (nome === 'historico_entradas') return `${p.agregado?.total_entradas ?? 0} entradas, lucro R$ ${p.agregado?.lucro_total ?? 0}`;
  if (nome === 'historico_promocoes') return `${p.total} promoção(ões), lucro R$ ${p.lucro_total ?? 0}`;
  if (nome === 'checar_regras_do_par') return p.permitido ? 'par PERMITIDO' : `BLOQUEADO: ${`${p.motivo_bloqueio}`.slice(0, 90)}`;
  if (nome === 'calcular_surebet') return p.eh_surebet ? `lucro R$ ${p.lucro_garantido} (ROI ${p.roi_garantido_pct}%)` : 'não fecha arbitragem';
  if (nome === 'calcular_cobertura_promocao')
    return `cobrir R$ ${p.coverStake} → lucro R$ ${p.lucroGarantido}${p.retencaoPct !== null && p.retencaoPct !== undefined ? ` (retenção ${p.retencaoPct}%)` : ''}`;
  if (nome === 'otimizar_odd_freebet') return `odd ideal ${p.odd_ideal} (retenção ${p.retencao_no_ideal_pct}%)`;
  if (nome === 'montar_multipla_promocao')
    return p.erro
      ? `erro: ${`${p.erro}`.slice(0, 90)}`
      : `${p.pernas?.length || 0} perna(s), odd total ${p.odd_total}${p.qualifica ? ' (qualifica)' : ' (NÃO qualifica)'}, caixa de pico R$ ${p.cobertura?.caixa_pico ?? '—'}`;
  if (nome === 'calcular_multipla_qualificadora')
    return `odd total ${p.oddTotal}${p.qualifica ? ' (qualifica)' : ' (NÃO qualifica)'}, caixa de pico R$ ${p.cobertura?.caixaPico}`;
  if (nome === 'buscar_conhecimento') return `${p.total ?? p.indice?.length ?? 0} trecho(s)`;
  if (nome === 'criar_oportunidade_no_radar') return `${p.acao || (p.criada ? 'criada' : 'não criada')}`;
  if (nome === 'registrar_promocao') return p.registrada ? 'promoção registrada' : `não registrada: ${`${p.erro}`.slice(0, 80)}`;
  if (nome === 'avisar_no_whatsapp') return p.enviado ? 'mensagem enviada' : `não enviado: ${`${p.motivo}`.slice(0, 80)}`;
  const json = JSON.stringify(p);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

function truncarParaModelo(payload: any): string {
  let txt: string;
  try {
    txt = JSON.stringify(payload);
  } catch {
    txt = `${payload}`;
  }
  if (txt.length <= MAX_CHARS_RESULTADO) return txt;
  return `${txt.slice(0, MAX_CHARS_RESULTADO)}… [RESULTADO TRUNCADO — refine os filtros da skill se precisar do resto]`;
}

/**
 * Roda o agente sobre o histórico do chat.
 * @param mensagens histórico multi-turno vindo do frontend (últimas N).
 * @param revalidation instância compartilhada (memo de odds de 60s).
 * @param opcoes canal de origem (ajusta o estilo da resposta: painel × WhatsApp).
 */
export async function rodarAgente(
  mensagens: MensagemCliente[],
  revalidation: RevalidationService,
  opcoes: OpcoesAgente = {}
): Promise<RespostaAgente> {
  const ctx: ContextoSkills = { revalidation, origem: opcoes.canal === 'whatsapp' ? 'agente-whatsapp' : 'agente' };
  const passos: PassoAgente[] = [];
  const avisos: string[] = [];
  let acao: RespostaAgente['acao'] | undefined;

  // Pedido explícito de escrita? Cinto de segurança sobre o prompt: vale só a ÚLTIMA
  // mensagem do usuário (o gate não pode ficar aberto pelo resto da conversa).
  const ultimaDoUsuario = [...mensagens].reverse().find((m) => m.role === 'user')?.content || '';
  const pediuEscrita = pediuEscritaExplicita(ultimaDoUsuario);

  const contextoApp = await montarContextoAgente().catch(() => '(CONTEXTO indisponível)');
  const system = systemPrompt(contextoApp, opcoes.canal);

  const historico: MsgAgente[] = mensagens
    .filter((m) => m.content && m.content.trim())
    .map((m) => ({ papel: m.role === 'assistant' ? 'assistant' : 'user', texto: m.content.trim() }));

  const ferramentas = ferramentasParaModelo();
  const cadeia = cadeiaAgente();
  let idxMotor = 0;
  let motor: MotorChat = criarMotor(cadeia[0]);
  const motoresFalhos = new Set<MotorNome>();

  const trocarMotor = (erro: any): boolean => {
    motoresFalhos.add(motor.nome);
    // Log com o corpo cru (para depurar); resposta ao cliente só com o motivo classificado.
    console.warn(`⚠️ [Agente] ${motor.nome}/${motor.modelo}: ${`${erro?.message || erro}`.slice(0, 300)}`);
    avisos.push(resumoErroProvedor(motor.nome, erro));
    while (++idxMotor < cadeia.length) {
      const proximo = criarMotor(cadeia[idxMotor]);
      if (!motoresFalhos.has(proximo.nome) && proximo.configurado) {
        motor = proximo;
        console.warn(`🔁 [Agente] trocando para ${motor.nome} (${motor.modelo}).`);
        return true;
      }
    }
    return false;
  };

  // Pula motores sem chave configurada já na largada.
  while (!motor.configurado && idxMotor < cadeia.length - 1) {
    avisos.push(`${motor.nome} sem chave configurada`);
    motor = criarMotor(cadeia[++idxMotor]);
  }
  if (!motor.configurado) {
    return {
      reply:
        '❌ Nenhum provedor de IA está configurado (GROQ_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY). ' +
        'Configure uma chave no .env do backend para o agente funcionar.',
      provider: 'nenhum',
      modelo: null,
      passos,
      avisos,
    };
  }

  const maxPassos = MAX_PASSOS();
  const maxCustosas = MAX_CUSTOSAS();
  let custosasUsadas = 0;
  let chamadasTotais = 0;
  const chamadasPorSkill = new Map<string, number>();
  /** (skill + args) já executados nesta pergunta → evita a mesma consulta em looping. */
  const jaChamado = new Map<string, string>();
  /** Índice em `historico` onde cada rodada começou (para comprimir por rodada). */
  const inicioRodadas: number[] = [];
  const fim = Date.now() + DEADLINE_MS;
  /** Trocas de motor por falha de infra: teto para o loop não virar eterno. */
  let trocasDeMotor = 0;

  for (let passo = 0; passo < maxPassos; passo++) {
    if (Date.now() > fim) {
      avisos.push('orçamento de tempo da pergunta esgotado — fechando com o que já foi coletado');
      break;
    }
    // Comprime resultados de rodadas antigas ANTES de montar o request (é aqui que o
    // tamanho importa), preservando as RODADAS_EM_DETALHE mais recentes.
    if (inicioRodadas.length > RODADAS_EM_DETALHE) {
      comprimirHistorico(historico, inicioRodadas[inicioRodadas.length - RODADAS_EM_DETALHE]);
    }

    let resposta;
    try {
      resposta = await motor.completar(system, historico, ferramentas);
    } catch (err: any) {
      if (trocasDeMotor < cadeia.length && trocarMotor(err)) {
        trocasDeMotor++;
        passo--; // não gasta rodada por falha de infraestrutura
        continue;
      }
      return {
        reply:
          `❌ Não consegui falar com nenhum provedor de IA agora (${avisos.join('; ')}).` +
          (passos.length
            ? `\n\nJá havia executado: ${passos.map((p) => `${p.skill} → ${p.resumo}`).join(' | ')}`
            : '') +
          '\nTente de novo em alguns minutos.',
        provider: motor.nome,
        modelo: motor.modelo,
        passos,
        acao,
        avisos,
      };
    }

    if (!resposta.chamadas.length) {
      const texto = (resposta.texto || '').trim();
      return {
        reply: texto || '(o modelo não retornou texto — tente reformular a pergunta)',
        provider: motor.nome,
        modelo: motor.modelo,
        passos,
        acao,
        avisos,
      };
    }

    historico.push({ papel: 'assistant', texto: resposta.texto, chamadas: resposta.chamadas });
    inicioRodadas.push(historico.length); // 1º resultado de ferramenta desta rodada

    for (const chamada of resposta.chamadas) {
      const skill = acharSkill(chamada.nome);
      const inicio = Date.now();

      if (!skill) {
        const payload = {
          erro: `skill "${chamada.nome}" não existe`,
          skills_disponiveis: SKILLS.map((s) => s.nome),
        };
        historico.push({ papel: 'tool', tool: { id: chamada.id, nome: chamada.nome, conteudo: truncarParaModelo(payload) } });
        passos.push({ skill: chamada.nome, args: chamada.args, ok: false, ms: 0, resumo: 'skill inexistente', erro: 'nome inválido' });
        continue;
      }

      if (skill.escrita && !pediuEscrita) {
        const payload = {
          erro: 'ação de ESCRITA bloqueada: o usuário não pediu explicitamente nesta conversa',
          instrucao: 'Confirme com o usuário ("quer que eu registre/crie?") antes de tentar de novo.',
        };
        historico.push({ papel: 'tool', tool: { id: chamada.id, nome: skill.nome, conteudo: truncarParaModelo(payload) } });
        passos.push({ skill: skill.nome, args: chamada.args, ok: false, ms: 0, resumo: 'escrita bloqueada (sem pedido explícito)', erro: 'gate de escrita' });
        continue;
      }

      // Repetição da MESMA chamada (mesma skill + mesmos args): devolve o resultado
      // anterior com uma ordem clara em vez de re-executar. O modelo costuma insistir
      // reformulando a consulta quando não gostou da resposta, e cada repetição infla o
      // histórico até o request estourar.
      const assinatura = `${skill.nome}|${JSON.stringify(chamada.args || {})}`;
      if (jaChamado.has(assinatura)) {
        const payload = {
          erro: 'chamada IDÊNTICA já executada nesta pergunta',
          resultado_anterior: jaChamado.get(assinatura),
          instrucao: 'Use o resultado que você já tem e RESPONDA ao usuário; não repita a mesma consulta.',
        };
        historico.push({ papel: 'tool', tool: { id: chamada.id, nome: skill.nome, conteudo: truncarParaModelo(payload) } });
        passos.push({ skill: skill.nome, args: chamada.args, ok: false, ms: 0, resumo: 'chamada repetida (usou o resultado anterior)', erro: 'duplicada' });
        continue;
      }
      const usosDaSkill = chamadasPorSkill.get(skill.nome) || 0;
      if (chamadasTotais >= MAX_CHAMADAS_TOTAL || usosDaSkill >= MAX_POR_SKILL) {
        const payload = {
          erro:
            chamadasTotais >= MAX_CHAMADAS_TOTAL
              ? `limite de ${MAX_CHAMADAS_TOTAL} chamadas de ferramenta nesta pergunta atingido`
              : `limite de ${MAX_POR_SKILL} chamadas da skill ${skill.nome} atingido`,
          instrucao: 'RESPONDA agora com o que já foi coletado e diga o que não deu para verificar.',
        };
        historico.push({ papel: 'tool', tool: { id: chamada.id, nome: skill.nome, conteudo: truncarParaModelo(payload) } });
        passos.push({ skill: skill.nome, args: chamada.args, ok: false, ms: 0, resumo: 'limite de chamadas atingido', erro: 'limite' });
        continue;
      }

      if (skill.custosa && custosasUsadas >= maxCustosas) {
        const payload = {
          erro: `limite de ${maxCustosas} consultas lentas por pergunta atingido`,
          instrucao: 'Responda com o que já foi coletado e diga ao usuário o que ficou de fora.',
        };
        historico.push({ papel: 'tool', tool: { id: chamada.id, nome: skill.nome, conteudo: truncarParaModelo(payload) } });
        passos.push({ skill: skill.nome, args: chamada.args, ok: false, ms: 0, resumo: 'limite de skills lentas atingido', erro: 'limite' });
        continue;
      }
      if (Date.now() > fim) {
        const payload = {
          erro: 'orçamento de tempo da pergunta esgotado — nenhuma consulta nova nesta rodada',
          instrucao: 'RESPONDA agora com o que já foi coletado e diga o que ficou sem verificar.',
        };
        historico.push({ papel: 'tool', tool: { id: chamada.id, nome: skill.nome, conteudo: truncarParaModelo(payload) } });
        passos.push({ skill: skill.nome, args: chamada.args, ok: false, ms: 0, resumo: 'tempo esgotado', erro: 'deadline' });
        continue;
      }

      // Tetos contados ANTES de executar: uma skill que LANÇA (scraper com timeout,
      // banco fora) não pode sair de graça, senão o modelo repete sem consumir orçamento.
      chamadasTotais++;
      chamadasPorSkill.set(skill.nome, usosDaSkill + 1);
      if (skill.custosa) custosasUsadas++;

      try {
        console.log(`🛠️ [Agente] ${skill.nome} ${JSON.stringify(chamada.args || {}).slice(0, 200)}`);
        const payload = await skill.executar(chamada.args || {}, ctx);
        const ms = Date.now() - inicio;
        const resumo = resumirResultado(skill.nome, payload);
        jaChamado.set(assinatura, resumo);
        historico.push({ papel: 'tool', tool: { id: chamada.id, nome: skill.nome, conteudo: truncarParaModelo(payload) } });
        passos.push({ skill: skill.nome, args: chamada.args, ok: !payload?.erro, ms, resumo });
        if (skill.escrita) acao = { tipo: skill.nome, ...(payload || {}) };
      } catch (err: any) {
        const ms = Date.now() - inicio;
        const msg = `${err?.message || err}`.slice(0, 240);
        historico.push({ papel: 'tool', tool: { id: chamada.id, nome: skill.nome, conteudo: truncarParaModelo({ erro: msg }) } });
        passos.push({ skill: skill.nome, args: chamada.args, ok: false, ms, resumo: `falhou: ${msg.slice(0, 100)}`, erro: msg });
        console.error(`❌ [Agente] ${skill.nome}: ${msg}`);
      }
    }
  }

  // Estourou o teto de rodadas (ou o de tempo): pede um fechamento em texto, sem ferramentas.
  try {
    const fechamento = await motor.completar(
      `${system}\n\nATENÇÃO: o limite de rodadas de ferramenta foi atingido. Responda AGORA, em texto, com o que já foi coletado, e diga explicitamente o que não deu para verificar.`,
      historico,
      []
    );
    return {
      reply: (fechamento.texto || '').trim() || 'Consultei as skills mas não consegui fechar uma resposta. Reformule a pergunta, por favor.',
      provider: motor.nome,
      modelo: motor.modelo,
      passos,
      acao,
      avisos: [...avisos, `fechamento forçado após ${passos.length} chamada(s) de skill`],
    };
  } catch (err: any) {
    console.error(`❌ [Agente] fechamento falhou: ${`${err?.message || err}`.slice(0, 300)}`);
    // Sem LLM para redigir: devolve o que as skills produziram (inclusive uma escrita já
    // efetivada — o banco pode ter sido alterado e o usuário precisa saber).
    const resumoSkills = passos.length
      ? `\n\nO que eu já apurei:\n${passos.map((p) => `• ${p.skill}: ${p.resumo}`).join('\n')}`
      : '';
    const avisoAcao = acao
      ? `\n\n⚠️ IMPORTANTE: a ação "${acao.tipo}" JÁ foi executada — ${acao.resumo_para_o_usuario || 'confira no painel'}.`
      : '';
    return {
      reply: `Consultei ${passos.length} skill(s), mas o provedor de IA caiu antes de redigir a resposta (${resumoErroProvedor(motor.nome, err)}).${avisoAcao}${resumoSkills}`,
      provider: motor.nome,
      modelo: motor.modelo,
      passos,
      acao,
      avisos: [...avisos, resumoErroProvedor(motor.nome, err)],
    };
  }
}
