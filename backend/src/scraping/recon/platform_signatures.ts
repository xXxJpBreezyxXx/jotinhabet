import { Plataforma, BotProtection } from './tipos';

/**
 * Registry de assinaturas para classificação. VERSIONAR: hosts mudam com o tempo.
 * Reverter UMA plataforma B2B libera várias casas (ex.: a Blaze já prova Altenar).
 */

interface AssinaturaPlataforma {
  plataforma: Plataforma;
  /** Substrings de host/URL que denunciam a plataforma. */
  hosts: string[];
  /** Substrings de path que reforçam a detecção (opcional). */
  paths?: string[];
  /** Confiança base quando bate só por host. */
  confianca: number;
}

export const ASSINATURAS_PLATAFORMA: AssinaturaPlataforma[] = [
  { plataforma: 'Altenar', hosts: ['sptpub.com', 'altenar'], paths: ['/prematch/', '/live/'], confianca: 0.95 },
  { plataforma: 'Kambi', hosts: ['kambi.com', 'kambicdn'], paths: ['/offering/', 'listview', 'betoffer'], confianca: 0.9 },
  { plataforma: 'Digitain', hosts: ['digitain.com', 'dsplatform', 'sportsbook'], confianca: 0.8 },
  { plataforma: 'BetConstruct', hosts: ['betconstruct.com', 'springbme', 'swarm'], confianca: 0.85 },
  { plataforma: 'GR8', hosts: ['gr8.tech', 'gr8tech'], confianca: 0.85 },
  { plataforma: 'Entain', hosts: ['cds-api', 'entain', 'bwin'], confianca: 0.8 },
  { plataforma: 'Superbet', hosts: ['superbet', 'freetls.fastly.net'], confianca: 0.6 },
  { plataforma: 'Stake', hosts: ['stake'], paths: ['/_api/graphql', 'graphql'], confianca: 0.7 },
  { plataforma: 'Bet365', hosts: ['bet365'], confianca: 0.6 },
];

interface AssinaturaBot {
  tipo: BotProtection;
  /** Nomes de cookie reveladores. */
  cookies?: string[];
  /** Nomes de header (lowercase) reveladores. */
  headers?: string[];
  /** Substrings de src de <script> reveladoras. */
  scripts?: string[];
}

export const ASSINATURAS_BOT: AssinaturaBot[] = [
  {
    tipo: 'cloudflare',
    cookies: ['__cf_bm', 'cf_clearance'],
    headers: ['cf-ray'],
    scripts: ['challenges.cloudflare.com', 'cdn-cgi/challenge-platform'],
  },
  { tipo: 'datadome', cookies: ['datadome'], headers: ['x-datadome'], scripts: ['js.datadome.co'] },
  { tipo: 'akamai', cookies: ['_abck', 'bm_sz'], headers: ['x-akamai-transformed'] },
  { tipo: 'incapsula', cookies: ['visid_incap_', 'incap_ses_'], headers: ['x-iinfo', 'x-cdn'] },
  { tipo: 'perimeterx', cookies: ['_px', '_pxhd', '_pxvid'], scripts: ['px-cdn', 'captcha.px-cloud', 'perimeterx'] },
];

/** Chaves de JSON que denunciam um feed de odds (para a heurística de densidade). */
export const CHAVES_DE_ODDS = [
  'events',
  'markets',
  'outcomes',
  'odds',
  'selections',
  'betoffers',
  'betoffer',
  'competitors',
  'eventinfo',
  'price',
  'coefficient',
];

/**
 * Classifica a plataforma a partir de uma lista de URLs observadas (hosts dos feeds).
 * Retorna a melhor correspondência e a confiança.
 */
export function classificarPlataforma(urls: string[]): { plataforma: Plataforma; confianca: number } {
  let melhor: { plataforma: Plataforma; confianca: number } = { plataforma: 'desconhecida', confianca: 0 };
  for (const assinatura of ASSINATURAS_PLATAFORMA) {
    for (const url of urls) {
      const u = url.toLowerCase();
      const hostBate = assinatura.hosts.some((h) => u.includes(h));
      if (!hostBate) continue;
      const pathBate = assinatura.paths ? assinatura.paths.some((p) => u.includes(p.toLowerCase())) : false;
      const conf = assinatura.confianca + (pathBate ? 0.04 : 0);
      if (conf > melhor.confianca) {
        melhor = { plataforma: assinatura.plataforma, confianca: Math.min(1, conf) };
      }
    }
  }
  return melhor;
}

/** Detecta proteções anti-bot a partir de cookies, headers e scripts observados. */
export function detectarBotProtection(
  cookies: string[],
  headers: string[],
  scripts: string[]
): BotProtection[] {
  const cookiesL = cookies.map((c) => c.toLowerCase());
  const headersL = headers.map((h) => h.toLowerCase());
  const scriptsL = scripts.map((s) => s.toLowerCase());
  const achadas: BotProtection[] = [];

  for (const sig of ASSINATURAS_BOT) {
    const bateCookie = (sig.cookies || []).some((c) => cookiesL.some((ck) => ck.includes(c.toLowerCase())));
    const bateHeader = (sig.headers || []).some((h) => headersL.some((hd) => hd.includes(h.toLowerCase())));
    const bateScript = (sig.scripts || []).some((s) => scriptsL.some((sc) => sc.includes(s.toLowerCase())));
    if (bateCookie || bateHeader || bateScript) achadas.push(sig.tipo);
  }

  return achadas.length > 0 ? achadas : ['nenhum'];
}

/** Quantas casas do universo compartilham cada plataforma — bônus de ranking (parser reaproveitável). */
export function bonusPlataformaCompartilhada(plataforma: Plataforma, contagem: Record<string, number>): number {
  const n = contagem[plataforma] || 0;
  return n > 1 ? n : 0;
}
