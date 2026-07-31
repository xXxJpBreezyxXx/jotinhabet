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

/** Casas cujo transporte exige browser (custo alto por consulta). */
const ehBrowser = (c: CasaCatalogada): boolean => c.transporte === 'browser' || c.transporte === 'browser-headed';

const LIMITE_PARALELO = 4;
const MAX_LINHAS_ODDS = 60;

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
      casa: { type: 'string', description: 'Nome ou chave da casa (ex.: "Superbet", "kto", "betboom").' },
      evento: { type: 'string', description: 'Nome do jogo como aparece na casa (ex.: "Flamengo x Palmeiras").' },
      esporte: { type: 'string', description: 'Futebol | Basquete | Tênis | E-sports (ajuda a filtrar o feed).' },
      mercado: { type: 'string', description: 'Filtro opcional de mercado (ex.: "Total de Gols", "Empate Anula").' },
    },
    required: ['casa', 'evento'],
    additionalProperties: false,
  },
  async executar(args: any, ctx: ContextoSkills) {
    const casa = acharCasa(args?.casa);
    if (!casa) {
      return {
        erro: `Casa "${args?.casa}" não está integrada (sem busca de odds por evento).`,
        dica: 'Chame listar_casas para ver as casas disponíveis e as chaves aceitas.',
      };
    }
    const evento = (args?.evento || '').toString().trim();
    if (!evento) return { erro: 'informe o nome do evento' };

    const odds = await ctx.revalidation.oddsDaCasa(casa.nome, evento, args?.esporte);
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
      esporte: { type: 'string', description: 'Futebol | Basquete | Tênis | E-sports.' },
      mercado: { type: 'string', description: 'Filtro de mercado (ex.: "Empate Anula", "Total de Gols", "Handicap").' },
      casas: {
        type: 'array',
        items: { type: 'string' },
        description: 'Casas específicas (chaves/nomes). Vazio = todas as casas de API/WS integradas.',
      },
      incluir_browser: {
        type: 'boolean',
        description: 'true inclui casas que exigem Chromium (Betano, Blaze, 1xBet, Stake, Rivalo, Betnacional). Lento — só se o usuário pedir aquela casa.',
      },
      max_casas: { type: 'number', description: 'Teto de casas consultadas (default 10).' },
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

    const resultados = await comLimite(alvo, LIMITE_PARALELO, async (casa) => ({
      nome: casa.nome,
      odds: await ctx.revalidation.oddsDaCasa(casa.nome, evento, args?.esporte),
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
        falhas,
        dica: 'Confira a grafia do nome do jogo (use o nome como aparece na casa) e o esporte.',
      };
    }

    const comparados = compararOfertas(fontes, args?.mercado);
    const surebets = comparados.filter((m) => m.roiPct !== null && !m.bloqueio);
    return {
      evento,
      esporte: args?.esporte || comparados[0]?.esporte || null,
      casas_com_o_evento: fontes.map((f) => f.nome),
      casas_sem_o_evento: semEvento,
      casas_nao_consultadas_por_limite: cortadas.length ? cortadas : undefined,
      // Casas que o usuário citou mas o app não integra (não têm consulta por evento).
      casas_nao_integradas: naoReconhecidas.length ? naoReconhecidas : undefined,
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

export const SKILLS_ODDS: Skill[] = [skillListarCasas, skillConsultarOddsCasa, skillCompararOddsCasas];
