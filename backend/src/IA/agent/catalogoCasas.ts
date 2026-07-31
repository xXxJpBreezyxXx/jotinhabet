/**
 * CATÁLOGO DE CASAS — o que o Agente sabe sobre cada casa integrada.
 *
 * Filosofia: as CAPACIDADES vêm do código (fonte única de verdade), os METADADOS
 * (plataforma, esportes, limitações) vêm da tabela curada abaixo:
 *
 *  - revalidação/busca dirigida  → casasComScraper()  (core/revalidationService.ts)
 *  - fonte da varredura pré-match → ArbitrageScannerV2.fontesDaVarredura()
 *  - odd AO VIVO (Radar Cashout) → casasComFonteLive() (cashout/cashoutSources.ts)
 *  - grupo de W.O. do tênis      → grupoTenis()        (arbitrage/regras.ts)
 *  - comissão de exchange        → comissaoDaCasa()    (arbitrage/comissao.ts)
 *
 * Assim, quando uma casa nova entra no SCRAPER_FACTORY, ela aparece automaticamente
 * no catálogo do Agente (com metadados "não catalogado" se ninguém preencheu aqui) —
 * em vez de sumir por esquecimento, que é o modo de falha caro.
 */

import { casasComScraper } from '../../core/revalidationService';
import { ArbitrageScannerV2 } from '../../core/scanner_v2';
import { casasComFonteLive } from '../../cashout/cashoutSources';
import { grupoTenis } from '../../arbitrage/regras';
import { comissaoDaCasa } from '../../arbitrage/comissao';
import { canonizarCasa } from '../../signals/casasAliases';
import { normalizarCasa } from '../riskAnalyzer';

export interface MetaCasa {
  /** Nome canônico de exibição (compatível com canonizarCasa). */
  nome: string;
  plataforma: string;
  /** Como as odds são obtidas: 'api' | 'browser' | 'browser-headed' | 'ws'. */
  transporte: 'api' | 'browser' | 'browser-headed' | 'ws';
  esportes: string[];
  mercados: string;
  limitacoes?: string;
  url?: string;
}

/** Metadados curados por CHAVE do SCRAPER_FACTORY (lowercase, sem pontuação). */
const META: Record<string, MetaCasa> = {
  kto: {
    nome: 'KTO', plataforma: 'Kambi', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis', 'Tênis de Mesa'],
    mercados: 'catálogo completo (DNB, handicap asiático, totais, BTTS) + AO VIVO',
    limitacoes: 'BLOQUEADA em Handicap e Totais de tênis (KTO.md §3). Grupo B de W.O.',
    url: 'https://www.kto.bet.br',
  },
  betwarrior: {
    nome: 'BetWarrior', plataforma: 'Kambi', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis', 'E-sports'],
    mercados: 'catálogo completo + AO VIVO; e-sports por Kambi esports/<jogo>',
    url: 'https://apostas.betwarrior.bet.br',
  },
  superbet: {
    nome: 'Superbet', plataforma: 'própria (API)', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis', 'E-sports'],
    mercados: 'catálogo amplo; handicap de MAPAS de e-sports desabilitado (pendência de pareamento)',
    url: 'https://superbet.bet.br',
  },
  pinnacle: {
    nome: 'Pinnacle', plataforma: 'própria (API)', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis', 'E-sports (sportId 12)'],
    mercados: 'linha AFIADA — é a bússola de odd justa (devig) do Radar Cashout e das value bets',
    limitacoes: 'bloqueio de ASN: sai por túnel Tailscale (PINNACLE_PROXY). Se o exit node cair, a fonte para.',
    url: 'https://www.pinnacle.com',
  },
  aposta1: {
    nome: 'Aposta1', plataforma: 'Altenar', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo Altenar completo',
    url: 'https://www.aposta1.bet.br',
  },
  estrelabet: {
    nome: 'EstrelaBet', plataforma: 'Altenar', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo Altenar completo',
    url: 'https://www.estrelabet.bet.br',
  },
  '4play': {
    nome: '4Play', plataforma: 'Altenar', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo Altenar completo',
    url: 'https://4play.bet.br',
  },
  luvabet: {
    nome: 'Luvabet', plataforma: 'Altenar', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo Altenar completo',
    limitacoes: 'grupo de W.O. do tênis NÃO classificado → tênis bloqueado (fail-safe)',
    url: 'https://luva.bet.br',
  },
  betpix365: {
    nome: 'BetPix365', plataforma: 'Altenar', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo Altenar completo',
    limitacoes: 'só REVALIDAÇÃO — não é fonte da varredura',
    url: 'https://betpix365.bet.br',
  },
  mcgames: {
    nome: 'MC Games', plataforma: 'Altenar ("mcgames2")', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo Altenar completo',
    limitacoes: 'só REVALIDAÇÃO — não é fonte da varredura',
    url: 'https://mcgames.bet.br',
  },
  betboom: {
    nome: 'BetBoom', plataforma: 'própria (API)', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo amplo',
    url: 'https://betboom.bet.br',
  },
  seubet: {
    nome: 'SeuBet', plataforma: 'Swarm (WebSocket)', transporte: 'ws',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo Swarm',
    url: 'https://www.seu.bet.br',
  },
  vbet: {
    nome: 'Vbet', plataforma: 'Swarm (WebSocket)', transporte: 'ws',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo Swarm',
    url: 'https://vbet.bet.br',
  },
  esportesdasorte: {
    nome: 'EsportesDaSorte', plataforma: 'própria (API)', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo amplo',
    url: 'https://esportesdasorte.bet.br',
  },
  betnacional: {
    nome: 'Betnacional', plataforma: 'própria (feed bet6)', transporte: 'browser',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo amplo',
    limitacoes: 'exige browser headless (feed bloqueia por fingerprint TLS); ~20s por varredura',
    url: 'https://betnacional.bet.br',
  },
  rivalo: {
    nome: 'Rivalo', plataforma: 'própria (matchserv / API /api/offer)', transporte: 'browser-headed',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'catálogo da API /api/offer (headers X-Betr-*)',
    limitacoes: 'Cloudflare: só responde com Chromium HEADED sob Xvfb. Tênis bloqueado (W.O. não classificado).',
    url: 'https://www.rivalo.bet.br',
  },
  brazino777: {
    nome: 'Brazino777', plataforma: 'NSoft / 7platform (API pública)', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'offer/cursors (odds x10000, competidores por ordinal)',
    limitacoes: 'tênis BLOQUEADO: a regra de desistência é mais agressiva que o Grupo B (1 ponto jogado valida)',
    url: 'https://brazino777.bet.br',
  },
  apostaganha: {
    nome: 'ApostaGanha', plataforma: 'NSoft / 7platform (API pública)', transporte: 'api',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'mesmo parser da Brazino777',
    limitacoes: 'removida do Grupo A em 29/07 (regra de W.O. inacessível) → tênis bloqueado',
    url: 'https://apostaganha.bet.br',
  },
  betano: {
    nome: 'Betano', plataforma: 'própria (browser)', transporte: 'browser',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'SÓ Resultado Final (browser) + AO VIVO no Radar Cashout',
    limitacoes: 'sobe um Chromium por consulta (memo 60s); mercado principal apenas',
    url: 'https://www.betano.bet.br',
  },
  blaze: {
    nome: 'Blaze', plataforma: 'própria (browser)', transporte: 'browser',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'SÓ Resultado Final (browser)',
    url: 'https://blaze.bet.br',
  },
  '1xbet': {
    nome: '1xbet', plataforma: 'própria (browser)', transporte: 'browser',
    esportes: ['Futebol', 'Basquete', 'Tênis'], mercados: 'SÓ Resultado Final (browser)',
    limitacoes: 'Grupo B de W.O. ("derrota técnica" ao desistente após o 1º set)',
    url: 'https://1xbet.bet.br',
  },
  stake: {
    nome: 'Stake', plataforma: 'própria (browser-intercept)', transporte: 'browser',
    esportes: ['Futebol'], mercados: 'SÓ Futebol 1X2 (API JSON só responde dentro do browser)',
    limitacoes: 'Grupo B de W.O.; retorna 0 odds em headless puro',
    url: 'https://stake.bet.br',
  },
};

/** Casas que aparecem em sinais/alertas mas NÃO têm scraper (alerta sai com ⚠️). */
const SEM_INTEGRACAO: Array<{ nome: string; nota: string }> = [
  { nome: 'Bet365', nota: 'recon reaberto: headed+Xvfb renderiza e o pullpodapi dá odds, mas a cobertura é de ~7 jogos da home' },
  { nome: 'Betfair', nota: 'exchange; usada como 2ª bússola do Radar Cashout (egress por proxy), não como fonte pré-match' },
  { nome: 'Bolsa de Aposta', nota: 'exchange com comissão de 1,5% já descontada via odd efetiva quando aparece em oportunidade' },
  { nome: 'Novibet', nota: 'regra de W.O. inacessível → tênis bloqueado; sem scraper' },
  { nome: 'Sportingbet', nota: 'recon: viável mas pesada (browser)' },
  { nome: 'Betsson', nota: 'Digitain (odds por GraphQL WS) — integração pendente' },
  { nome: 'BetMGM', nota: 'Digitain (odds por GraphQL WS) — integração pendente' },
  { nome: 'Betsul', nota: 'API própria destravada por túnel residencial; corpo do POST /web/v2/eventos a capturar' },
  { nome: 'Pixbet', nota: 'sem scraper' },
  { nome: 'Pitaco', nota: 'sem scraper; Grupo B de W.O.' },
];

export interface CasaCatalogada {
  chave: string;
  nome: string;
  plataforma: string;
  transporte: string;
  /** Entra na varredura pré-match de 5 min (é fonte de odds para o motor). */
  fonte_scanner: boolean;
  /** Sabe re-buscar UM evento (usada por revalidação, "Validar" e pelas skills de odds). */
  busca_dirigida: boolean;
  /** Entrega odd AO VIVO (in-play) para o Radar Cashout. */
  odd_ao_vivo: boolean;
  esportes: string[];
  mercados: string;
  grupo_wo_tenis: 'A' | 'B' | null;
  comissao_exchange_pct: number;
  limitacoes: string | null;
  url: string | null;
}

/** Catálogo completo das casas INTEGRADAS (com busca dirigida e/ou fonte do scanner). */
export function catalogoCasas(): CasaCatalogada[] {
  const chaves = casasComScraper();
  const fontes = ArbitrageScannerV2.fontesDaVarredura();
  const fontesChaves = new Set(fontes.todas.map((n) => normalizarCasa(canonizarCasa(n))));
  const liveChaves = new Set(casasComFonteLive().map((n) => normalizarCasa(canonizarCasa(n))));

  return chaves
    .map((chave) => {
      const meta = META[chave];
      const nome = meta?.nome || chave;
      const grupo = grupoTenis(nome);
      // Tênis com grupo de W.O. desconhecido é BLOQUEADO pelos gates (fail-safe de
      // regras.ts). A limitação é derivada aqui para o catálogo não anunciar "Tênis"
      // numa casa em que nenhuma operação de tênis passa.
      const limitacaoTenis =
        grupo === null && (meta?.esportes || []).some((e) => /t[êe]nis/i.test(e))
          ? 'grupo de W.O. do tênis NÃO classificado → operações de tênis BLOQUEADAS nesta casa (fail-safe)'
          : null;
      const limitacoes = [meta?.limitacoes, limitacaoTenis].filter(Boolean).join(' | ') || null;
      return {
        chave,
        nome,
        plataforma: meta?.plataforma || 'não catalogada',
        transporte: meta?.transporte || 'api',
        fonte_scanner: fontesChaves.has(chave),
        busca_dirigida: true,
        odd_ao_vivo: liveChaves.has(chave),
        esportes: meta?.esportes || [],
        mercados: meta?.mercados || 'não catalogado',
        grupo_wo_tenis: grupo,
        comissao_exchange_pct: Math.round(comissaoDaCasa(nome) * 10000) / 100,
        limitacoes,
        url: meta?.url || null,
      };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

/** Casas conhecidas SEM integração de odds (aparecem em sinais externos). */
export function casasSemIntegracao(): Array<{ nome: string; nota: string; grupo_wo_tenis: 'A' | 'B' | null }> {
  return SEM_INTEGRACAO.map((c) => ({ ...c, grupo_wo_tenis: grupoTenis(c.nome) }));
}

/** Resolve um nome digitado pelo usuário para uma casa catalogada (ou null). */
export function acharCasa(nomeDigitado: string): CasaCatalogada | null {
  const alvo = normalizarCasa(canonizarCasa(nomeDigitado || ''));
  if (!alvo) return null;
  const todas = catalogoCasas();
  return (
    todas.find((c) => c.chave === alvo) ||
    todas.find((c) => normalizarCasa(c.nome) === alvo) ||
    todas.find((c) => c.chave.startsWith(alvo) || alvo.startsWith(c.chave)) ||
    null
  );
}

/**
 * Resumo COMPACTO das casas para o system prompt do Agente.
 *
 * Deliberadamente curto (~250 tokens em vez de ~750): a Groq no free tier tem teto de
 * tokens POR MINUTO (8k–12k dependendo do modelo) e o loop de ferramentas faz várias
 * chamadas — cada token do system prompt é pago de novo em toda rodada. Os detalhes
 * (plataforma, mercados, limitações) ficam na skill listar_casas, que o modelo chama
 * quando precisa.
 *
 * Flags com PREFIXO para não colidirem: "scan" (fonte da varredura), "live" (odd ao
 * vivo), "browser" (lento), "wo:A|B|?" (grupo de W.O. do tênis; ? = tênis bloqueado).
 * Antes eram letras concatenadas ("SVB") e o "B" de browser se confundia com o "B" do
 * grupo de W.O. — ambiguidade num texto que o modelo lê como verdade.
 */
export function resumoCasasParaPrompt(): string {
  const linhas = catalogoCasas().map((c) => {
    const flags = [
      c.fonte_scanner ? 'scan' : '',
      c.odd_ao_vivo ? 'live' : '',
      c.transporte === 'browser' || c.transporte === 'browser-headed' ? 'browser' : '',
      `wo:${c.grupo_wo_tenis || '?'}`,
    ]
      .filter(Boolean)
      .join(' ');
    return `${c.nome}[${c.chave} | ${flags}]`;
  });
  return (
    `CASAS INTEGRADAS (${linhas.length}) — a chave antes do "|" é o que as skills aceitam. ` +
    `Flags: scan=fonte da varredura, live=odd ao vivo, browser=consulta lenta, wo=grupo de W.O. do tênis (? = tênis BLOQUEADO nessa casa):\n` +
    `${linhas.join('; ')}\n` +
    `Detalhes (plataforma, mercados, limitações) na skill listar_casas. Sem integração de odds: ${casasSemIntegracao()
      .map((c) => c.nome)
      .join(', ')}.`
  );
}
