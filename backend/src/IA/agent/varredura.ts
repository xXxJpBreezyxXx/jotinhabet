/**
 * VARREDURA SOB DEMANDA — listar jogos e achar surebet SEM o nome do evento.
 *
 * Por que existe: as skills de odds só sabiam buscar POR NOME (`oddsDoEvento`). Quando o
 * usuário pedia "verifica os jogos ao vivo da KTO e da Superbet", o agente não tinha
 * ferramenta para isso e devolvia a pergunta ("qual jogo?") — que é justamente o que não
 * se sabe de antemão. Aqui o feed inteiro da casa (o MESMO que o scanner de 5 min usa) é
 * agrupado por evento e cruzado entre casas.
 *
 * Duas decisões de custo, que na VPS de 1 core mandam:
 *  - AGRUPAMENTO EM DOIS ESTÁGIOS: primeiro por nome normalizado (Map, O(n)), depois
 *    fundindo grupos entre casas com `areEventsSame` (O(E²) só nos NOMES). O caminho
 *    ingênuo — comparar cada odd com cada grupo — faria centenas de milhares de
 *    jaroWinkler por varredura.
 *  - COMPARAÇÃO POR EVENTO: `compararOfertas` é chamado por grupo (um jogo), não com o
 *    feed inteiro de uma vez. Isso mantém os clusters pequenos e evita o O(n²) dentro do
 *    bucket (mercado|linha), que com 2.000 linhas de odds ficava lento.
 */

import { ScrapedOdd } from '../../scraping/scraper_base';
import { areEventsSame, mesmoHorario, parseKickoff } from '../../arbitrage/matcher';
import { compararOfertas, FonteOdds, MercadoComparado } from './comparadorOdds';

/** Recorte pedido pelo usuário. 'todos' = como o feed veio. */
export type Situacao = 'ao_vivo' | 'pre_jogo' | 'todos';

/**
 * Nome do esporte como os SCRAPERS esperam (o mesmo vocabulário do scanner_v2:
 * 'Futebol' | 'Basquete' | 'Tenis' | 'Esports' | 'Volei' | 'TenisDeMesa' | 'Beisebol').
 *
 * Existe porque o modelo escreve o que quiser: numa pergunta real ele mandou
 * `esporte: "futebol"` (minúsculo) e o mapa de paths do Kambi, que é indexado por
 * 'Futebol', devolveu undefined → varredura de 0 odds → o agente respondeu "não há jogo
 * ao vivo na KTO" com 7 jogos rolando. Silenciosamente errado é o pior modo de falha
 * possível aqui.
 *
 * Esporte desconhecido passa direto (não força um default): assim uma casa que conheça um
 * esporte novo continua funcionando, e a skill informa quando o feed vem vazio.
 */
export function normalizarEsporte(v?: string): string {
  const t = (v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!t) return 'Futebol';
  if (/^(futebol|football|soccer|fut)$/.test(t)) return 'Futebol';
  if (/^(basquete|basket|basketball|nba)$/.test(t)) return 'Basquete';
  if (/mesa|tabletennis|pingpong/.test(t)) return 'TenisDeMesa';
  if (/^(tenis|tennis|atp|wta)$/.test(t)) return 'Tenis';
  if (/^(volei|voleibol|volleyball|volley)$/.test(t)) return 'Volei';
  if (/^(beisebol|baseball|mlb)$/.test(t)) return 'Beisebol';
  if (/^(esports?|cs2|csgo|lol|leagueoflegends|dota2?|valorant)$/.test(t)) return 'Esports';
  return (v || '').trim();
}

export interface JogoAgrupado {
  evento: string;
  esporte: string | null;
  /** Início (ISO) — o mais informado entre as casas. */
  inicio: string | null;
  aoVivo: boolean;
  /** Odds por casa, só deste jogo. */
  porCasa: Map<string, ScrapedOdd[]>;
}

/** Normalização barata para o 1º estágio do agrupamento (chave de Map). */
function chaveEvento(evento: string): string {
  return (evento || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(x|vs?|v)\b/g, '|')
    .replace(/[^a-z0-9|]/g, '')
    .trim();
}

/**
 * Normaliza o parâmetro `situacao` que o modelo escreve de várias formas
 * ("ao vivo", "live", "in-play", "pré-jogo", "todos").
 */
export function lerSituacao(v: any): Situacao {
  const t = `${v ?? ''}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  if (/vivo|live|inplay|in-play|andamento|rolando/.test(t)) return 'ao_vivo';
  if (/pre|prematch|pre-match|agendad|futuro|nao.?comec/.test(t)) return 'pre_jogo';
  if (/tod|ambos|all|qualquer/.test(t)) return 'todos';
  return 'todos';
}

/**
 * A partida já começou? Deduzido do horário de início — o `ScrapedOdd` é um tipo
 * compartilhado por 17 scrapers e não tem flag de live; inventar campo aqui obrigaria
 * todos a preencher. Tolerância de 2 min cobre relógio dessincronizado da casa.
 */
export function ehAoVivo(o: { dataHora?: string }, agora = Date.now()): boolean {
  // parseKickoff, NÃO Date.parse: metade dos scrapers emite data SEM fuso
  // ("2026-07-31 14:00:00") e o projeto trata isso como UTC. Date.parse leria como hora
  // LOCAL (−3h em São Paulo) e classificaria jogo em andamento como pré-jogo — foi
  // exatamente o que aconteceu no primeiro probe da Superbet.
  const t = parseKickoff(o?.dataHora);
  if (t === null) return false; // sem horário não dá para afirmar que está rolando
  return t <= agora - 2 * 60_000;
}

export function filtrarSituacao(odds: ScrapedOdd[], situacao: Situacao): ScrapedOdd[] {
  if (situacao === 'todos') return odds;
  const agora = Date.now();
  return odds.filter((o) => (situacao === 'ao_vivo' ? ehAoVivo(o, agora) : !ehAoVivo(o, agora)));
}

/**
 * Agrupa as odds de N casas por JOGO (mesmo evento + horário compatível).
 * Mesmas travas do motor: `areEventsSame` para o nome e `mesmoHorario` para não fundir
 * o jogo de hoje com o homônimo de amanhã (ou o Sub-20).
 */
export function agruparPorJogo(fontes: FonteOdds[]): JogoAgrupado[] {
  // 1º estágio: bucket exato por (esporte, nome normalizado, SLOT de 10 min do kickoff).
  // O tempo entra na chave porque nomes IDÊNTICOS de horários diferentes (o mesmo confronto
  // na semana seguinte, o homônimo do Sub-20, e principalmente o MESMO par jogando duas
  // vezes no mesmo turno — Liga Pro de tênis de mesa) cairiam no mesmo bucket e o
  // `mesmoHorario` do 2º estágio nunca seria consultado. O slot é de 10 min, não de 1 hora:
  // com 1 hora, duas partidas do mesmo par às 15:05 e às 15:50 viravam UM grupo, a lista
  // escondia uma delas e a oportunidade saía com o marcador de ao vivo da outra.
  // Fragmentação não é problema: o 2º estágio reúne slots vizinhos do MESMO jogo via
  // areEventsSame + mesmoHorario (que tolera 10 min).
  const cru = new Map<string, { esporte: string | null; evento: string; itens: Array<{ casa: string; odd: ScrapedOdd }> }>();
  for (const f of fontes) {
    for (const o of f.odds || []) {
      if (!(o.oddA > 1) || !(o.oddB > 1)) continue;
      const ts = parseKickoff(o.dataHora);
      const slot = ts === null ? 'sem-hora' : Math.floor(ts / 600_000);
      const k = `${(o.esporte || '').toLowerCase()}|${chaveEvento(o.evento)}|${slot}`;
      const g = cru.get(k) || { esporte: o.esporte || null, evento: o.evento, itens: [] };
      g.itens.push({ casa: f.nome, odd: o });
      cru.set(k, g);
    }
  }

  // 2º estágio: funde buckets que são o MESMO jogo escrito de formas diferentes
  // ("Flamengo x Palmeiras" × "Flamengo - Palmeiras SP").
  const jogos: JogoAgrupado[] = [];
  for (const g of cru.values()) {
    const inicio = g.itens.map((i) => i.odd.dataHora).find((d) => parseKickoff(d) !== null) || null;
    const alvo = jogos.find(
      (j) =>
        (j.esporte || '').toLowerCase() === (g.esporte || '').toLowerCase() &&
        areEventsSame(j.evento, g.evento) &&
        mesmoHorario(j.inicio || undefined, inicio || undefined)
    );
    const destino =
      alvo ||
      (() => {
        const novo: JogoAgrupado = {
          evento: g.evento,
          esporte: g.esporte,
          inicio,
          aoVivo: false,
          porCasa: new Map(),
        };
        jogos.push(novo);
        return novo;
      })();
    if (!destino.inicio && inicio) destino.inicio = inicio;
    for (const { casa, odd } of g.itens) {
      const lista = destino.porCasa.get(casa) || [];
      lista.push(odd);
      destino.porCasa.set(casa, lista);
    }
  }

  const agora = Date.now();
  for (const j of jogos) j.aoVivo = ehAoVivo({ dataHora: j.inicio || undefined }, agora);
  // Ao vivo primeiro, depois por horário de início.
  return jogos.sort((a, b) => {
    if (a.aoVivo !== b.aoVivo) return a.aoVivo ? -1 : 1;
    return (parseKickoff(a.inicio || undefined) ?? 0) - (parseKickoff(b.inicio || undefined) ?? 0);
  });
}

/** Horário curto (dia/mês hora:min, fuso de SP) ou '?' quando a casa não informou. */
function horaCurta(iso?: string | null): string {
  const ts = parseKickoff(iso || undefined);
  if (ts === null) return '?';
  return new Date(ts).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Odd com 2 casas — o feed devolve dízima ("1.221145514107577") e isso só gasta token. */
const odd2 = (n: number): string => (Number.isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : '?');
/** Nome de evento vindo de feed às vezes traz tabulação/espaço duplo ("Al Fayha FC\t\t"). */
const limparNome = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();

/** Uma linha de texto por jogo — formato enxuto porque o payload da skill tem teto de chars. */
export function resumirJogo(j: JogoAgrupado, comCasas: boolean): string {
  const hora = horaCurta(j.inicio);
  const todas = [...j.porCasa.values()].flat();
  // Mercado principal para dar contexto: o de nome mais "resultado final"/1x2, senão o 1º.
  const principal =
    todas.find((o) => /resultado final|vencedor|1x2|match winner|moneyline/i.test(o.mercado || '')) || todas[0];
  const linhaPrincipal = principal
    ? ` | ${principal.mercado}: ${limparNome(principal.opcaoA)} @${odd2(principal.oddA)} × ${limparNome(principal.opcaoB)} @${odd2(principal.oddB)}`
    : '';
  const casas = comCasas ? ` | casas: ${[...j.porCasa.keys()].join('+')}` : '';
  return `${j.aoVivo ? '🔴 AO VIVO' : '🕒 pré'} ${limparNome(j.evento)} (${hora}) | ${todas.length} mercado(s)${casas}${linhaPrincipal}`;
}

export interface SurebetVarrida {
  evento: string;
  esporte: string | null;
  inicio: string | null;
  aoVivo: boolean;
  mercado: MercadoComparado;
}

/**
 * Cruza os feeds de N casas e devolve os mercados comparados de cada jogo que tem 2+
 * casas — usando o MESMO comparador (e portanto o mesmo pareamento) da skill de
 * comparação de um evento só.
 */
export function cruzarFeeds(
  fontes: FonteOdds[],
  opcoes: { filtroMercado?: string; maxJogos?: number } = {}
): SurebetVarrida[] {
  const jogos = agruparPorJogo(fontes).filter((j) => j.porCasa.size >= 2);
  const teto = Math.max(1, opcoes.maxJogos ?? 80);
  const agora = Date.now();
  const saida: SurebetVarrida[] = [];
  for (const j of jogos.slice(0, teto)) {
    const fontesDoJogo: FonteOdds[] = [...j.porCasa.entries()].map(([casa, odds]) => ({ nome: casa, odds }));
    for (const m of compararOfertas(fontesDoJogo, opcoes.filtroMercado)) {
      if (m.umaCasaSo) continue;
      // Horário do CLUSTER, não do grupo: um grupo pode conter mais de uma partida do mesmo
      // par (slots vizinhos reunidos pela tolerância de 10 min), e herdar o `aoVivo` do
      // grupo marcava linha pré-jogo como AO VIVO — o usuário abriria o jogo errado.
      const inicio = m.dataHora ?? j.inicio;
      saida.push({
        evento: j.evento,
        esporte: j.esporte,
        inicio,
        aoVivo: ehAoVivo({ dataHora: inicio || undefined }, agora),
        mercado: m,
      });
    }
  }
  // Surebet primeiro (maior ROI), depois quem está mais perto de fechar.
  return saida.sort((a, b) => {
    const ra = a.mercado.roiPct;
    const rb = b.mercado.roiPct;
    if (ra !== null && rb !== null) return rb - ra;
    if (ra !== null) return -1;
    if (rb !== null) return 1;
    return (a.mercado.faltaPct ?? 1e9) - (b.mercado.faltaPct ?? 1e9);
  });
}


/** Uma linha por oportunidade (mesmo motivo do resumirJogo: teto de chars do payload). */
export function resumirSurebet(s: SurebetVarrida): string {
  const m = s.mercado;
  const cabeca =
    m.roiPct !== null ? `ROI ${m.roiPct}%` : m.faltaPct !== null ? `falta ${m.faltaPct}%` : 'sem base';
  const linha = m.linha !== null ? ` ${m.linha}` : '';
  const bloqueio = m.bloqueio ? ` | ⛔ ${m.bloqueio}` : '';
  // O HORÁRIO é obrigatório na linha: o mesmo par pode ter duas partidas no dia (Liga Pro
  // de tênis de mesa joga o mesmo confronto de novo em minutos) e sem ele as duas
  // oportunidades ficam textualmente idênticas.
  return (
    `${cabeca} | ${s.aoVivo ? '🔴' : '🕒'} ${limparNome(s.evento)} (${horaCurta(s.inicio)}) | ${m.mercado}${linha} | ` +
    `${limparNome(m.opcaoA)} ${m.melhorA.casa} @${odd2(m.melhorA.odd)} × ${limparNome(m.opcaoB)} ${m.melhorB.casa} @${odd2(m.melhorB.odd)}${bloqueio}`
  );
}
