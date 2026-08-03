/**
 * SKILLS DE SCRAPER / CONSULTA DE ODDS — o coração do Agente.
 *
 * Estas skills dão ao modelo o MESMO acesso que a revalidação e o botão "Validar"
 * têm: busca dirigida (oddsDoEvento) em qualquer casa integrada, com o memo de 60s
 * compartilhado do RevalidationService (nada de subir dois Chromium para a mesma
 * pergunta).
 *
 * Regra de custo: casas de BROWSER (Betano, Blaze, 1xBet, Stake, Rivalo, Betnacional)
 * sobem Chromium — ficam FORA da comparação por padrão e só entram com
 * incluir_browser=true. Sem esse corte, uma pergunta inocente ("compara as odds
 * desse jogo") derrubaria a VPS de 1 core.
 */

import { Skill, ContextoSkills } from '../tipos';
import { catalogoCasas, casasSemIntegracao, acharCasa, CasaCatalogada } from '../catalogoCasas';
import { compararOfertas, FonteOdds } from '../comparadorOdds';
import { comLimite } from '../../../utils/concorrencia';
import { ScrapedOdd } from '../../../scraping/scraper_base';
import { areEventsSame } from '../../../arbitrage/matcher';
import { normalizarMercado } from '../../../arbitrage/markets';
import { casaColetaAoVivo, casaFeedLiveExclusivo, casaVarreAoVivo } from '../../../core/revalidationService';
import {
  agruparPorJogo,
  cruzarFeeds,
  filtrarSituacao,
  lerSituacao,
  normalizarEsporte,
  resumirJogo,
  resumirSurebet,
  Situacao,
} from '../varredura';

/** Casas cujo transporte exige browser (custo alto por consulta). */
const ehBrowser = (c: CasaCatalogada): boolean => c.transporte === 'browser' || c.transporte === 'browser-headed';

const LIMITE_PARALELO = 4;
/** Coleta de FEED é bem mais pesada que busca por evento: 2 por vez na VPS de 1 core. */
const LIMITE_PARALELO_FEED = 2;
const MAX_LINHAS_ODDS = 60;
/** Teto de tempo de UMA coleta de feed (o loop do agente tem 110s no total). */
const TIMEOUT_FEED_MS = 45_000;


/** Coleta o feed de UMA casa com teto de tempo (a falha vira mensagem, não exceção solta). */
async function feedComTimeout(
  ctx: ContextoSkills,
  casa: CasaCatalogada,
  esporte: string,
  aoVivo: boolean
): Promise<ScrapedOdd[]> {
  return Promise.race([
    ctx.revalidation.feedDaCasa(casa.nome, esporte, { aoVivo }),
    new Promise<ScrapedOdd[]>((_r, rej) =>
      setTimeout(() => rej(new Error(`tempo esgotado (${TIMEOUT_FEED_MS / 1000}s) na coleta do feed`)), TIMEOUT_FEED_MS)
    ),
  ]);
}

/**
 * Feed da casa no RECORTE pedido, resolvendo a diferença de semântica entre plataformas.
 *
 * Na maioria (Kambi, Pinnacle, Superbet, Swarm, BetBoom, NSoft) `aoVivo: true` SOMA a
 * partida em andamento ao pré-jogo — uma coleta resolve "todos". Nas Altenar a flag TROCA
 * de endpoint e devolve só o in-play, então "todos" exige as DUAS coletas (senão o usuário
 * pede "todos os jogos" e recebe apenas os que estão rolando).
 */
async function feedNaSituacao(
  ctx: ContextoSkills,
  casa: CasaCatalogada,
  esporte: string,
  situacao: Situacao
): Promise<ScrapedOdd[]> {
  const varreAoVivo = casaVarreAoVivo(casa.nome);
  if (situacao === 'pre_jogo' || !varreAoVivo) return feedComTimeout(ctx, casa, esporte, false);
  if (situacao === 'ao_vivo') return feedComTimeout(ctx, casa, esporte, true);
  if (!casaFeedLiveExclusivo(casa.nome)) return feedComTimeout(ctx, casa, esporte, true);

  // Altenar: duas coletas (sequenciais — 1 core), unindo por oferta e mantendo a versão ao
  // vivo quando a mesma linha aparece nos dois feeds.
  const pre = await feedComTimeout(ctx, casa, esporte, false);
  const live = await feedComTimeout(ctx, casa, esporte, true);
  const chave = (o: ScrapedOdd) => `${o.evento}|${o.mercado}|${o.linha ?? ''}|${o.opcaoA}`;
  const mapa = new Map<string, ScrapedOdd>();
  for (const o of pre) mapa.set(chave(o), o);
  for (const o of live) mapa.set(chave(o), o);
  return [...mapa.values()];
}

function resumirOdd(o: ScrapedOdd) {
  return {
    esporte: o.esporte,
    evento: o.evento,
    inicio: o.dataHora || null,
    mercado: o.mercado,
    linha: o.linha ?? null,
    A: `${o.opcaoA} @${o.oddA}`,
    B: `${o.opcaoB} @${o.oddB}`,
  };
}

export const skillListarCasas: Skill = {
  nome: 'listar_casas',
  resumo:
    'Catálogo das casas integradas: chave, plataforma, se é fonte do scanner, se dá odd ao vivo, grupo de W.O. e limitações. Chame antes de consultar odds.',
  grupo: 'odds',
  descricao:
    'Lista TODAS as casas de apostas integradas ao JotinhaBet e o que cada uma sabe fazer ' +
    '(fonte da varredura pré-match, busca de odds por evento, odd ao vivo, plataforma, esportes, ' +
    'grupo de W.O. do tênis, comissão de exchange e limitações). Use SEMPRE antes de consultar odds, ' +
    'para saber a chave correta da casa e se ela é consultável.',
  parametros: { type: 'object', properties: {}, additionalProperties: false },
  async executar() {
    const casas = catalogoCasas();
    // Agregados PRONTOS antes da lista: pedir para o modelo contar flags em 22 objetos dá
    // erro de leitura (num teste em produção ele listou 7 casas com odd ao vivo quando
    // são 3). Com as listas já filtradas, a resposta é determinística.
    return {
      total_integradas: casas.length,
      resumo: {
        casas_com_odd_ao_vivo: casas.filter((c) => c.odd_ao_vivo).map((c) => c.nome),
        casas_que_varrem_jogo_ao_vivo: casas.filter((c) => c.varredura_ao_vivo).map((c) => c.nome),
        casas_fonte_da_varredura: casas.filter((c) => c.fonte_scanner).map((c) => c.nome),
        casas_so_revalidacao: casas.filter((c) => !c.fonte_scanner).map((c) => c.nome),
        casas_que_exigem_browser: casas.filter((c) => ehBrowser(c)).map((c) => c.nome),
        casas_com_tenis_bloqueado: casas.filter((c) => c.grupo_wo_tenis === null).map((c) => c.nome),
        grupo_wo_A: casas.filter((c) => c.grupo_wo_tenis === 'A').map((c) => c.nome),
        grupo_wo_B: casas.filter((c) => c.grupo_wo_tenis === 'B').map((c) => c.nome),
      },
      integradas: casas,
      sem_integracao_de_odds: casasSemIntegracao(),
      nota:
        'casas_que_varrem_jogo_ao_vivo = onde varrer_jogos_casa/varrer_surebets_casas aceitam situacao="ao_vivo"; ' +
        'nas outras, jogo em andamento simplesmente não vem no feed (não é "não tem jogo"). ' +
        'Use as listas de `resumo` para responder contagens — não recontar a lista `integradas`. ' +
        'Casas de browser sobem Chromium (consulta de 10-30s) e em comparar_odds_casas só entram com incluir_browser=true. ' +
        'Tênis só cruza casas do MESMO grupo de W.O.',
    };
  },
};

export const skillConsultarOddsCasa: Skill = {
  nome: 'consultar_odds_casa',
  resumo:
    'Odds AO VIVO de UM evento numa casa (todos os mercados). Use para conferir uma perna, medir drift de odd ou achar a odd de cobertura. LENTA.',
  grupo: 'odds',
  custosa: true,
  descricao:
    'Busca AO VIVO, na casa indicada, todos os mercados de UM evento (nome do jogo). ' +
    'Use quando o usuário pedir "qual a odd da casa X para o jogo Y", para medir drift de odd antes de ' +
    'cobrir uma freebet, ou para conferir uma perna antes de apostar. Retorna mercados, linhas, opções e odds.',
  parametros: {
    type: 'object',
    properties: {
      casa: { type: 'string', description: 'Nome ou chave da casa.' },
      evento: { type: 'string', description: 'Nome do jogo como aparece na casa.' },
      esporte: { type: 'string', description: 'Ajuda a filtrar o feed.' },
      mercado: { type: 'string', description: 'Filtro opcional de mercado.' },
      ao_vivo: { type: 'boolean', description: 'true busca também partida EM ANDAMENTO.' },
    },
    required: ['casa', 'evento'],
    additionalProperties: false,
  },
  async executar(args: any, ctx: ContextoSkills) {
    const casa = acharCasa(args?.casa);
    if (!casa) {
      return {
        erro: `Casa "${args?.casa}" não está integrada (sem busca de odds por evento).`,
        // Caso REAL: o usuário manda print de um sinal cuja casa não é integrada (Novibet,
        // Betfair…). Parar em "não integrada" não responde nada — o que ele quer saber é se
        // a linha existe onde ele PODE apostar.
        dica:
          'NÃO pare aqui: chame comparar_odds_casas com o MESMO evento e mercado para ver essa linha nas casas ' +
          'INTEGRADAS, e diga ao usuário que a casa do print não é lida pelo app. listar_casas mostra as chaves aceitas.',
      };
    }
    const evento = (args?.evento || '').toString().trim();
    if (!evento) return { erro: 'informe o nome do evento' };

    const aoVivo = args?.ao_vivo === true;
    if (aoVivo && !casaColetaAoVivo(casa.nome)) {
      // Dizer a verdade em vez de responder "não achei": a casa existe, o jogo pode estar
      // rolando, o que falta é COLETA ao vivo nessa plataforma.
      return {
        casa: casa.nome,
        evento,
        encontrado: false,
        motivo: `${casa.nome} ainda não coleta partida EM ANDAMENTO — só pré-jogo. Consulte sem ao_vivo, ou use uma casa da lista de coleta ao vivo (listar_casas).`,
      };
    }
    const esporteAlvo = args?.esporte ? normalizarEsporte(args.esporte) : undefined;
    const odds = await ctx.revalidation.oddsDaCasa(casa.nome, evento, esporteAlvo, { aoVivo });
    const filtro = (args?.mercado || '').toString().trim().toLowerCase();
    let lista = odds;
    if (filtro) {
      const canon = normalizarMercado(filtro);
      lista = odds.filter(
        (o) =>
          (o.mercado || '').toLowerCase().includes(filtro) ||
          (canon !== 'DESCONHECIDO' && normalizarMercado(o.mercado) === canon)
      );
    }
    if (!lista.length) {
      return {
        casa: casa.nome,
        evento,
        encontrado: false,
        motivo: odds.length
          ? `A casa tem ${odds.length} mercado(s) para esse evento, mas nenhum casa com o filtro "${args?.mercado}".`
          : 'Evento não encontrado no feed dessa casa agora (nome diferente, jogo fora da janela, ou feed indisponível).',
        mercados_disponiveis: Array.from(new Set(odds.map((o) => o.mercado))).slice(0, 25),
      };
    }
    return {
      casa: casa.nome,
      plataforma: casa.plataforma,
      evento_consultado: evento,
      evento_na_casa: lista[0]?.evento || null,
      inicio: lista[0]?.dataHora || null,
      total_mercados: lista.length,
      truncado: lista.length > MAX_LINHAS_ODDS,
      odds: lista.slice(0, MAX_LINHAS_ODDS).map(resumirOdd),
      limitacoes: casa.limitacoes,
    };
  },
};

export const skillCompararOddsCasas: Skill = {
  nome: 'comparar_odds_casas',
  resumo:
    'Compara o MESMO evento em várias casas: melhor odd de cada lado, soma das probabilidades, ROI se fechar surebet ou quanto falta, e bloqueios. LENTA.',
  grupo: 'odds',
  custosa: true,
  descricao:
    'Consulta o MESMO evento em VÁRIAS casas ao mesmo tempo e devolve a tabela comparada por mercado: ' +
    'melhor odd de cada lado, em que casa, soma das probabilidades, ROI se fechar surebet ou quanto falta ' +
    'para fechar, e bloqueios das Diretrizes. Use para "onde está a melhor odd", "dá surebet nesse jogo?", ' +
    'ou para achar a melhor cobertura de uma freebet/qualificativa.',
  parametros: {
    type: 'object',
    properties: {
      evento: { type: 'string', description: 'Nome do jogo (ex.: "Grêmio x Bolívar").' },
      esporte: { type: 'string', description: 'Default: procura em todos.' },
      mercado: { type: 'string', description: 'Filtro de mercado.' },
      casas: { type: 'array', items: { type: 'string' }, description: 'Vazio = casas de API/WS.' },
      incluir_browser: { type: 'boolean', description: 'true inclui casas de Chromium (lento).' },
      max_casas: { type: 'number', description: 'Teto de casas (default 10).' },
      ao_vivo: { type: 'boolean', description: 'true inclui partida EM ANDAMENTO.' },
    },
    required: ['evento'],
    additionalProperties: false,
  },
  async executar(args: any, ctx: ContextoSkills) {
    const evento = (args?.evento || '').toString().trim();
    if (!evento) return { erro: 'informe o nome do evento' };

    const todas = catalogoCasas();
    let alvo: CasaCatalogada[];
    // `casas` pode vir como array OU como string ("kto, superbet" / "[\"kto\"]") —
    // provedores de function calling produzem os dois formatos com frequência, e antes
    // a string era silenciosamente ignorada (varria TODAS as casas de API).
    const pedidas: string[] = Array.isArray(args?.casas)
      ? args.casas.filter((c: any) => typeof c === 'string' && c.trim()).map((c: string) => c.trim())
      : typeof args?.casas === 'string' && args.casas.trim()
      ? args.casas
          .replace(/^\s*\[|\]\s*$/g, '')
          .split(',')
          .map((c: string) => c.replace(/["']/g, '').trim())
          .filter(Boolean)
      : [];
    const naoReconhecidas = pedidas.filter((n) => !acharCasa(n));
    if (pedidas.length) {
      // Casas explicitamente pedidas entram MESMO sendo de browser (o usuário pediu).
      alvo = pedidas.map((n) => acharCasa(n)).filter((c): c is CasaCatalogada => !!c);
      if (!alvo.length) {
        return {
          erro: `nenhuma das casas pedidas tem consulta de odds por evento: ${naoReconhecidas.join(', ')}`,
          dica: 'chame listar_casas para ver as casas integradas e as chaves aceitas',
        };
      }
    } else {
      // Sem lista explícita: API/WS por padrão; incluir_browser=true repõe as de browser.
      alvo = args?.incluir_browser === true ? todas : todas.filter((c) => !ehBrowser(c));
    }

    // ORDEM DE PRIORIDADE antes do corte. O catálogo vem em ordem alfabética e um
    // slice cru cortava justamente as casas que mais entregam (num teste real a KTO
    // ficou de fora por causa do "K"). Fonte do scanner e casas com odd ao vivo têm
    // catálogo mais completo, então entram primeiro.
    if (!pedidas.length) {
      alvo = [...alvo].sort((a, b) => {
        const peso = (c: CasaCatalogada) => (c.fonte_scanner ? 2 : 0) + (c.odd_ao_vivo ? 1 : 0);
        return peso(b) - peso(a) || a.nome.localeCompare(b.nome, 'pt-BR');
      });
    }
    const teto = Math.max(2, Math.min(16, Number(args?.max_casas) || 12));
    const cortadas = alvo.slice(teto).map((c) => c.nome);
    alvo = alvo.slice(0, teto);

    const aoVivo = args?.ao_vivo === true;
    const esporteAlvo = args?.esporte ? normalizarEsporte(args.esporte) : undefined;
    // Ao vivo: casa que não coleta partida em andamento sai da consulta e é REPORTADA —
    // deixá-la entrar devolvia lista vazia e o modelo concluía "não tem esse jogo".
    const semColetaAoVivo = aoVivo ? alvo.filter((c) => !casaColetaAoVivo(c.nome)).map((c) => c.nome) : [];
    if (aoVivo) alvo = alvo.filter((c) => casaColetaAoVivo(c.nome));
    if (!alvo.length) {
      return {
        evento,
        encontrado: false,
        motivo: 'nenhuma das casas pedidas coleta partida EM ANDAMENTO',
        casas_sem_coleta_ao_vivo: semColetaAoVivo,
        dica: 'chame listar_casas e use uma casa com coleta ao vivo, ou consulte sem ao_vivo (pré-jogo)',
      };
    }
    const resultados = await comLimite(alvo, LIMITE_PARALELO, async (casa) => ({
      nome: casa.nome,
      odds: await ctx.revalidation.oddsDaCasa(casa.nome, evento, esporteAlvo, { aoVivo }),
    }));

    const fontes: FonteOdds[] = [];
    const falhas: Array<{ casa: string; erro: string }> = [];
    const semEvento: string[] = [];
    resultados.forEach((r, i) => {
      const nome = alvo[i].nome;
      if (r.status === 'rejected') {
        falhas.push({ casa: nome, erro: `${(r as PromiseRejectedResult).reason?.message || 'falha na coleta'}`.slice(0, 120) });
        return;
      }
      const odds = r.value.odds || [];
      // Só aceita odds cujo evento realmente casa com o pedido (o feed pode devolver vizinhos).
      const doEvento = odds.filter((o) => areEventsSame(o.evento, evento) || (o.evento || '').toLowerCase().includes(evento.toLowerCase()));
      if (!doEvento.length) {
        semEvento.push(nome);
        return;
      }
      fontes.push({ nome, odds: doEvento });
    });

    if (!fontes.length) {
      return {
        evento,
        casas_consultadas: alvo.map((c) => c.nome),
        encontrado: false,
        motivo: 'Nenhuma casa consultada tem esse evento no feed agora.',
        sem_evento: semEvento,
        casas_nao_integradas: naoReconhecidas.length ? naoReconhecidas : undefined,
        casas_sem_coleta_ao_vivo: semColetaAoVivo.length ? semColetaAoVivo : undefined,
        falhas,
        dica: 'Confira a grafia do nome do jogo (use o nome como aparece na casa) e o esporte.',
      };
    }

    const comparados = compararOfertas(fontes, args?.mercado);
    const surebets = comparados.filter((m) => m.roiPct !== null && !m.bloqueio);
    return {
      evento,
      esporte: esporteAlvo || comparados[0]?.esporte || null,
      casas_com_o_evento: fontes.map((f) => f.nome),
      casas_sem_o_evento: semEvento,
      casas_nao_consultadas_por_limite: cortadas.length ? cortadas : undefined,
      // Casas que o usuário citou mas o app não integra (não têm consulta por evento).
      casas_nao_integradas: naoReconhecidas.length ? naoReconhecidas : undefined,
      casas_sem_coleta_ao_vivo: semColetaAoVivo.length ? semColetaAoVivo : undefined,
      falhas,
      total_mercados_comparados: comparados.length,
      surebets_encontradas: surebets.length,
      mercados: comparados.slice(0, 12),
      truncado: comparados.length > 12,
      nota:
        (fontes.length < 2
          ? 'ATENÇÃO: só UMA casa tem esse evento — não há comparação entre casas possível (as odds abaixo são todas da mesma casa, logo NÃO existe surebet aqui). '
          : '') +
        'somaProb < 1 = surebet (roiPct é o lucro garantido; em linha quarter já vem o PISO). ' +
        'faltaPct = quanto a soma está acima de 1. bloqueio = Diretrizes/W.O. impedem a operação. ' +
        'A execução é manual: revalide antes de apostar.',
    };
  },
};

/**
 * VARREDURA DE JOGOS DE UMA CASA — a skill que faltava.
 *
 * `consultar_odds_casa` exige o NOME do jogo; quando o usuário pede "vê os jogos ao vivo
 * da KTO", esse nome é exatamente o que ele não tem. Aqui o feed do esporte inteiro é
 * coletado (o mesmo caminho da varredura de 5 min) e devolvido como lista de jogos.
 */
export const skillVarrerJogosCasa: Skill = {
  nome: 'varrer_jogos_casa',
  resumo:
    'LISTA os jogos de um esporte numa casa (ao vivo, pré-jogo ou todos) SEM precisar do nome do jogo. Use quando o usuário pedir "quais jogos tem na casa X". LENTA.',
  grupo: 'odds',
  custosa: true,
  descricao:
    'Varre o FEED de uma casa para um esporte e lista os jogos disponíveis — ao vivo (em andamento), ' +
    'pré-jogo ou os dois — com horário, quantidade de mercados e a odd do mercado principal. ' +
    'É a skill para "quais jogos de futebol ao vivo tem na KTO agora?" ou "o que a Superbet tem de tênis hoje?", ' +
    'quando o nome do evento é desconhecido. Para comparar odds entre casas, use varrer_surebets_casas.',
  parametros: {
    type: 'object',
    properties: {
      casa: { type: 'string', description: 'Nome ou chave da casa.' },
      esporte: { type: 'string', description: 'Default Futebol.' },
      situacao: { type: 'string', description: 'ao_vivo | pre_jogo | todos (default todos).' },
      limite: { type: 'number', description: 'Quantos jogos listar (default 8, teto 25).' },
    },
    required: ['casa'],
    additionalProperties: false,
  },
  async executar(args: any, ctx: ContextoSkills) {
    const casa = acharCasa(args?.casa);
    if (!casa) {
      return {
        erro: `Casa "${args?.casa}" não está integrada.`,
        dica: 'Chame listar_casas para ver as casas disponíveis e as chaves aceitas.',
      };
    }
    // normalizarEsporte: o modelo manda "futebol"/"tênis"/"e-sports" e os mapas dos
    // scrapers são indexados por 'Futebol'/'Tenis'/'Esports' — sem isto a varredura
    // voltava VAZIA e o agente concluía "não tem jogo".
    const esporte = normalizarEsporte(args?.esporte);
    const situacao = lerSituacao(args?.situacao);
    const limite = Math.max(1, Math.min(25, Number(args?.limite) || 8));
    const coletaAoVivo = casaVarreAoVivo(casa.nome);

    if (situacao === 'ao_vivo' && !coletaAoVivo) {
      return {
        casa: casa.nome,
        esporte,
        situacao,
        coleta_ao_vivo: false,
        jogos: [],
        motivo: `${casa.nome} ainda não coleta partida EM ANDAMENTO (só pré-jogo). Isso NÃO significa que não há jogo ao vivo na casa.`,
        dica: 'Use situacao="pre_jogo" nesta casa, ou varra uma casa com coleta ao vivo (listar_casas mostra quais).',
      };
    }

    let odds: ScrapedOdd[];
    try {
      odds = await feedNaSituacao(ctx, casa, esporte, situacao);
    } catch (err: any) {
      return {
        casa: casa.nome,
        esporte,
        situacao,
        erro: `falha na coleta do feed: ${`${err?.message || err}`.slice(0, 140)}`,
        dica: casa.transporte.startsWith('browser')
          ? 'esta casa exige Chromium: a varredura é lenta e pode estourar o tempo — tente uma casa de API'
          : 'tente de novo em alguns segundos ou troque o esporte',
      };
    }

    const noRecorte = filtrarSituacao(odds, situacao);
    const jogos = agruparPorJogo([{ nome: casa.nome, odds: noRecorte }]);
    // Orçamento de caracteres: o payload da skill é cortado em AGENT_MAX_CHARS_SKILL
    // (2600 por padrão) e um corte cego mutila o JSON no meio de um jogo. Melhor entregar
    // menos jogos e DIZER que cortou — cada linha custa ~300 caracteres.
    const linhas: string[] = [];
    let orcamento = 2000;
    for (const j of jogos.slice(0, limite)) {
      const linha = resumirJogo(j, false);
      if (orcamento - linha.length < 0) break;
      orcamento -= linha.length;
      linhas.push(linha);
    }
    return {
      casa: casa.nome,
      esporte,
      situacao,
      coleta_ao_vivo: coletaAoVivo,
      total_linhas_de_odd: odds.length,
      total_jogos: jogos.length,
      mostrando: linhas.length,
      jogos: linhas,
      cortado_por_tamanho: linhas.length < Math.min(limite, jogos.length) ? true : undefined,
      limitacoes: casa.limitacoes,
      nota:
        (situacao !== 'pre_jogo' && !coletaAoVivo
          ? `ATENÇÃO: ${casa.nome} não coleta partida em andamento — a lista acima é só pré-jogo. `
          : '') +
        'Para as odds detalhadas de um desses jogos, chame consultar_odds_casa com o nome exato que aparece aqui.',
    };
  },
};

/**
 * VARREDURA CRUZADA — acha surebet ao vivo/pré sem o usuário dizer o jogo.
 *
 * Faz sob demanda o que a varredura de 5 min faz para o radar, mas restrito às casas e ao
 * esporte pedidos (e podendo incluir partida EM ANDAMENTO, que o pipeline pré-match
 * descarta por definição).
 */
export const skillVarrerSurebetsCasas: Skill = {
  nome: 'varrer_surebets_casas',
  resumo:
    'VARRE os feeds de 2-4 casas num esporte (ao vivo ou pré) e devolve as melhores oportunidades entre elas, sem precisar do nome do jogo. MUITO LENTA.',
  grupo: 'odds',
  custosa: true,
  descricao:
    'Coleta o feed inteiro de 2 a 4 casas para um esporte e cruza TODOS os jogos em comum, ' +
    'devolvendo onde há surebet (ROI garantido) e onde falta pouco. É a varredura do radar, ' +
    'sob demanda e podendo incluir jogos AO VIVO — que a varredura pré-match de 5 minutos ' +
    'descarta. Use para "tem surebet ao vivo entre KTO e Superbet no basquete?".',
  parametros: {
    type: 'object',
    properties: {
      casas: { type: 'array', items: { type: 'string' }, description: 'Casas a cruzar (2 a 4). Vazio = melhores fontes de API.' },
      esporte: { type: 'string', description: 'Default Futebol.' },
      situacao: { type: 'string', description: 'ao_vivo | pre_jogo | todos (default todos).' },
      mercado: { type: 'string', description: 'Filtro de mercado.' },
      roi_minimo: { type: 'number', description: 'ROI mínimo em % (default 0.5).' },
      limite: { type: 'number', description: 'Quantas listar (default 8, teto 15).' },
    },
    additionalProperties: false,
  },
  async executar(args: any, ctx: ContextoSkills) {
    const esporte = normalizarEsporte(args?.esporte);
    const situacao = lerSituacao(args?.situacao);
    const roiMin = Number.isFinite(Number(args?.roi_minimo)) ? Number(args.roi_minimo) : 0.5;
    const limite = Math.max(1, Math.min(15, Number(args?.limite) || 8));

    const todas = catalogoCasas();
    const pedidas: string[] = Array.isArray(args?.casas)
      ? args.casas.filter((c: any) => typeof c === 'string' && c.trim()).map((c: string) => c.trim())
      : typeof args?.casas === 'string' && args.casas.trim()
      ? args.casas
          .replace(/^\s*\[|\]\s*$/g, '')
          .split(',')
          .map((c: string) => c.replace(/["']/g, '').trim())
          .filter(Boolean)
      : [];
    const naoReconhecidas = pedidas.filter((n) => !acharCasa(n));
    let alvo: CasaCatalogada[] = pedidas.length
      ? pedidas.map((n) => acharCasa(n)).filter((c): c is CasaCatalogada => !!c)
      : // Sem lista: casas de API que são fonte da varredura (catálogo mais completo) e,
        // no recorte ao vivo, que sabem coletar partida em andamento.
        todas
          .filter((c) => !ehBrowser(c) && c.fonte_scanner)
          .sort((a, b) => Number(casaVarreAoVivo(b.nome)) - Number(casaVarreAoVivo(a.nome)) || a.nome.localeCompare(b.nome, 'pt-BR'));

    const semColetaAoVivo = situacao === 'ao_vivo' ? alvo.filter((c) => !casaVarreAoVivo(c.nome)).map((c) => c.nome) : [];
    if (situacao === 'ao_vivo') alvo = alvo.filter((c) => casaVarreAoVivo(c.nome));
    // Teto de 4: cada casa é um feed inteiro. Com 1 core, 5+ feeds estouram o orçamento
    // de tempo da pergunta e derrubam a resposta inteira.
    const cortadas = alvo.slice(4).map((c) => c.nome);
    alvo = alvo.slice(0, 4);
    if (alvo.length < 2) {
      return {
        erro: 'preciso de 2 casas comparáveis para cruzar',
        casas_pedidas: pedidas,
        casas_nao_integradas: naoReconhecidas.length ? naoReconhecidas : undefined,
        casas_sem_coleta_ao_vivo: semColetaAoVivo.length ? semColetaAoVivo : undefined,
        dica: 'chame listar_casas e escolha 2 a 4 casas (de preferência com coleta ao vivo, se o pedido for ao vivo)',
      };
    }

    const resultados = await comLimite(alvo, LIMITE_PARALELO_FEED, async (casa) => ({
      nome: casa.nome,
      odds: filtrarSituacao(await feedNaSituacao(ctx, casa, esporte, situacao), situacao),
    }));

    const fontes: FonteOdds[] = [];
    const falhas: Array<{ casa: string; erro: string }> = [];
    const vazias: string[] = [];
    resultados.forEach((r, i) => {
      const nome = alvo[i].nome;
      if (r.status === 'rejected') {
        falhas.push({ casa: nome, erro: `${(r as PromiseRejectedResult).reason?.message || 'falha na coleta'}`.slice(0, 110) });
        return;
      }
      if (!r.value.odds.length) {
        vazias.push(nome);
        return;
      }
      fontes.push(r.value);
    });

    if (fontes.length < 2) {
      return {
        esporte,
        situacao,
        encontrado: false,
        motivo: 'menos de 2 casas devolveram jogos nesse recorte — sem duas fontes não existe comparação',
        casas_consultadas: alvo.map((c) => c.nome),
        casas_sem_jogos_no_recorte: vazias,
        casas_sem_coleta_ao_vivo: semColetaAoVivo.length ? semColetaAoVivo : undefined,
        falhas,
      };
    }

    const cruzadas = cruzarFeeds(fontes, { filtroMercado: args?.mercado });
    const surebets = cruzadas.filter((c) => c.mercado.roiPct !== null && c.mercado.roiPct >= roiMin && !c.mercado.bloqueio);
    const quase = cruzadas.filter((c) => c.mercado.roiPct === null && c.mercado.faltaPct !== null);
    const jogosCruzados = new Set(cruzadas.map((c) => c.evento)).size;

    return {
      esporte,
      situacao,
      casas_consultadas: fontes.map((f) => f.nome),
      casas_sem_jogos_no_recorte: vazias.length ? vazias : undefined,
      casas_sem_coleta_ao_vivo: semColetaAoVivo.length ? semColetaAoVivo : undefined,
      casas_nao_integradas: naoReconhecidas.length ? naoReconhecidas : undefined,
      casas_nao_consultadas_por_limite: cortadas.length ? cortadas : undefined,
      falhas,
      jogos_em_2_ou_mais_casas: jogosCruzados,
      mercados_comparados: cruzadas.length,
      surebets_encontradas: surebets.length,
      surebets: surebets.slice(0, limite).map(resumirSurebet),
      mais_perto_de_fechar: surebets.length ? undefined : quase.slice(0, 3).map(resumirSurebet),
      bloqueadas_pelas_diretrizes: cruzadas
        .filter((c) => c.mercado.roiPct !== null && c.mercado.bloqueio)
        .slice(0, 3)
        .map(resumirSurebet),
      nota:
        'ROI na base do motor (piso em linha quarter). Odd ao vivo muda em segundos: ' +
        'REVALIDE na casa antes de apostar. A execução é sempre manual.',
    };
  },
};

export const SKILLS_ODDS: Skill[] = [
  skillListarCasas,
  skillConsultarOddsCasa,
  skillCompararOddsCasas,
  skillVarrerJogosCasa,
  skillVarrerSurebetsCasas,
];
