/**
 * Tipos do harness de reconhecimento (recon) de feeds de odds.
 * Objetivo: mapear cada casa .bet.br e classificar por "facilidade de scraping".
 */

/** Nível de autenticação necessário para ler o feed de odds. */
export type NivelAuth = 'publico' | 'precisa_cookie' | 'precisa_token' | 'so_browser' | 'desconhecido';

/** Transporte do feed principal. */
export type Transporte = 'xhr' | 'ws' | 'desconhecido';

/** Plataforma B2B provável (ou própria). */
export type Plataforma =
  | 'Altenar'
  | 'Kambi'
  | 'Digitain'
  | 'BetConstruct'
  | 'GR8'
  | 'Entain'
  | 'Superbet'
  | 'Stake'
  | 'Bet365'
  | 'proprietaria'
  | 'desconhecida';

export type BotProtection =
  | 'cloudflare'
  | 'datadome'
  | 'akamai'
  | 'incapsula'
  | 'perimeterx'
  | 'nenhum';

/** Uma casa a ser sondada. */
export interface CasaAlvo {
  nome: string;
  dominio: string; // ex: "https://blaze.bet.br"
  /** Caminhos de esportes ao vivo (in-play) a visitar. */
  pathsAoVivo: string[];
  /** Caminhos de esportes pré-jogo a visitar. */
  pathsPrematch: string[];
  /** Peso de cobertura/liquidez (casas grandes valem mais no cruzamento). Default 1. */
  pesoCobertura?: number;
}

/** Uma requisição candidata a ser o feed de odds. */
export interface FeedCandidate {
  host: string;
  path: string;
  url: string;
  transporte: Transporte;
  status?: number;
  contentType?: string;
  method?: string;
  temAuthHeader: boolean;
  temCookieHeader: boolean;
  tamanho: number; // bytes do corpo (aprox)
  ocorrencias: number; // quantas vezes esse host+path apareceu (recorrência = polling)
  densidade: number; // nº de chaves "de odds" achadas no JSON
  score: number; // tamanho × recorrência × densidade
}

/** Relatório final por casa. */
export interface ReconReport {
  casa: string;
  dominio: string;
  timestamp: string;
  ok: boolean; // false se o probe falhou (timeout, bloqueio total)
  erro?: string;
  feedPrincipal: {
    host: string;
    pathExemplo: string;
    transporte: Transporte;
    tamanho: number;
  } | null;
  auth: NivelAuth;
  botProtection: BotProtection[];
  plataformaProvavel: Plataforma;
  confianca: number; // 0..1
  facilidadeScore: number;
  pesoCobertura: number;
  scoreFinal: number; // facilidadeScore × pesoCobertura
  websockets: string[]; // URLs wss:// observadas
  candidatos: FeedCandidate[]; // top-N candidatos (para inspeção)
  amostraJson: unknown; // top-level keys + 1 evento, para desenhar o parser depois
}
