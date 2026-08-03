import { GeminiProvider } from './Provedores/Gemini';
import { OpenAIProvider } from './Provedores/OpenAI';
import { GroqProvider } from './Provedores/Groq';
import { OpenRouterProvider } from './Provedores/OpenRouter';
import { IAProvider, ImagemEntrada } from './Provedores/types';

export { ImagemEntrada };

/**
 * Camada única de acesso à IA para o pipeline.
 *
 * Cadeia de provedores (30/07/2026): OpenAI → Gemini → **Groq**, configurável por
 * env `AI_PROVIDER_CHAIN` (ex.: "groq,openai,gemini") sem rebuild. Todos
 * implementam `IAProvider` e têm mock-mode quando a chave não está configurada.
 *
 * Três decisões que valem a leitura:
 *
 * 1) CIRCUIT BREAKER de cota. Crédito esgotado (429 "credits are depleted" /
 *    "insufficient_quota") não volta em segundos: o provedor entra em cooldown
 *    (AI_QUOTA_COOLDOWN_MIN, default 30min) e é PULADO na próxima chamada. Sem
 *    isso, toda chamada pagava o timeout dos provedores mortos antes de chegar no
 *    que funciona — era o que travava o Copiloto e a visão do Telegram em 29/07.
 *
 * 2) MOCK NÃO É RESPOSTA. Provedor sem chave devolve "[Mock ...]" em vez de
 *    lançar erro. Antes, com OPENAI_API_KEY ausente, o chat respondia o texto de
 *    mock e nunca tentava os outros. Agora mock conta como falha e a cadeia
 *    continua; só devolve mock se TODOS estiverem sem chave.
 *
 * 3) VISÃO tem cadeia própria (`AI_PROVIDER_CHAIN_VISION`): a Groq não expõe
 *    modelo multimodal na conta atual e OpenAI/Gemini estavam com crédito zerado
 *    em 31/07 — por isso a **OpenRouter** (free tier multimodal) entrou como 1ª da
 *    cadeia de visão. Ver Provedores/OpenRouter.
 */

export type ProviderName = 'gemini' | 'openai' | 'groq' | 'openrouter';

export interface AIResult {
  text: string;
  provider: ProviderName;
}

const NOMES_VALIDOS: ProviderName[] = ['openai', 'gemini', 'groq', 'openrouter'];
const CADEIA_TEXTO_DEFAULT: ProviderName[] = ['openai', 'gemini', 'groq'];
// Visão: OpenRouter primeiro (é a única com crédito hoje — ver nota 3 acima).
const CADEIA_VISAO_DEFAULT: ProviderName[] = ['openrouter', 'openai', 'gemini', 'groq'];

// Instâncias preguiçosas (lazy) para não construir clientes na importação.
const instancias: Partial<Record<ProviderName, IAProvider>> = {};

function getProvider(nome: ProviderName): IAProvider {
  if (!instancias[nome]) {
    instancias[nome] =
      nome === 'openai'
        ? new OpenAIProvider()
        : nome === 'gemini'
        ? new GeminiProvider()
        : nome === 'openrouter'
        ? new OpenRouterProvider()
        : new GroqProvider();
  }
  return instancias[nome]!;
}

/** Lê e valida uma cadeia de provedores do env, caindo no default se vazia/inválida. */
function lerCadeia(envVar: string, padrao: ProviderName[]): ProviderName[] {
  const bruto = (process.env[envVar] || '').trim();
  if (!bruto) return padrao;
  const lista = bruto
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderName => (NOMES_VALIDOS as string[]).includes(s));
  const unicos = Array.from(new Set(lista));
  if (!unicos.length) {
    console.warn(`⚠️ [AI] ${envVar}="${bruto}" não tem provedor válido — usando ${padrao.join(',')}.`);
    return padrao;
  }
  return unicos;
}

export function cadeiaTexto(): ProviderName[] {
  return lerCadeia('AI_PROVIDER_CHAIN', CADEIA_TEXTO_DEFAULT);
}
export function cadeiaVisao(): ProviderName[] {
  // Não herda AI_PROVIDER_CHAIN: a cadeia de TEXTO é outra (a Groq é excelente em texto e
  // não tem visão; a OpenRouter free é o contrário — multimodal, mas lenta para texto).
  return lerCadeia('AI_PROVIDER_CHAIN_VISION', CADEIA_VISAO_DEFAULT);
}

// ───────────────────────── circuit breaker de cota ─────────────────────────

const cooldownAte: Partial<Record<ProviderName, number>> = {};

function cooldownMs(): number {
  const min = Number(process.env.AI_QUOTA_COOLDOWN_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
}

function ehCotaEsgotada(err: any): boolean {
  const msg = `${err?.message || err}`;
  return /credits are depleted|prepayment|insufficient_quota|exceeded your current quota|billing hard limit|quota exceeded|RESOURCE_EXHAUSTED/i.test(
    msg
  );
}

function marcarCotaEsgotada(nome: ProviderName, err: any): void {
  cooldownAte[nome] = Date.now() + cooldownMs();
  console.error(
    `💳 [AI] ${nome}: cota/créditos ESGOTADOS (${`${err?.message || err}`.slice(0, 140)}) — ` +
      `pulando por ${Math.round(cooldownMs() / 60000)}min. Recarregue o crédito ou reordene AI_PROVIDER_CHAIN.`
  );
}

function emCooldown(nome: ProviderName): boolean {
  const ate = cooldownAte[nome];
  if (!ate) return false;
  if (Date.now() >= ate) {
    delete cooldownAte[nome];
    return false;
  }
  return true;
}

/** Estado da cadeia para o /api/health e para o painel (nunca expõe chaves). */
export function statusProvedores(): Array<{
  provider: ProviderName;
  configurado: boolean;
  em_cooldown: boolean;
  cooldown_ate: string | null;
  modelo: string | null;
}> {
  const chaves: Record<ProviderName, string | undefined> = {
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    groq: process.env.GROQ_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };
  const modelos: Record<ProviderName, string | undefined> = {
    openai: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
    gemini: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    groq: process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b',
    openrouter: process.env.OPENROUTER_MODEL_VISION?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'google/gemma-4-26b-a4b-it:free',
  };
  return NOMES_VALIDOS.map((p) => ({
    provider: p,
    configurado: !!chaves[p] && !chaves[p]!.includes('your-'),
    em_cooldown: emCooldown(p),
    cooldown_ate: cooldownAte[p] ? new Date(cooldownAte[p]!).toISOString() : null,
    modelo: modelos[p] || null,
  }));
}

/** Zera o cooldown (usado por testes e por um "tentar de novo" manual). */
export function limparCooldowns(): void {
  for (const p of NOMES_VALIDOS) delete cooldownAte[p];
}

// ───────────────────────── retry de rate-limit ─────────────────────────

/** Espera sugerida (ms) quando o erro é rate-limit momentâneo (RPM), null caso contrário.
 *  Honra o retryDelay que a API devolve ("Please retry in 9.7s" / "retryDelay":"9s"). */
function delayDe429(err: any): number | null {
  const msg = `${err?.message || err}`;
  if (!/429|rate limit|rate_limit/i.test(msg)) return null;
  // Cota/créditos esgotados não voltam em segundos — quem trata é o circuit breaker.
  if (ehCotaEsgotada(err)) return null;
  const m = msg.match(/retry in (\d+(?:\.\d+)?)s/i) || msg.match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
  const s = m ? parseFloat(m[1]) : 15;
  return Math.min(60, Math.ceil(s) + 1) * 1000;
}

/** Re-tenta SÓ rate-limit momentâneo, esperando o retryDelay da API entre tentativas. */
async function comRetry429<T>(rotulo: string, fn: () => Promise<T>, tentativas = 2): Promise<T> {
  let ultimoErro: any;
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (err: any) {
      ultimoErro = err;
      const espera = delayDe429(err);
      if (espera === null || i === tentativas) throw err;
      console.warn(`⏳ [AI] ${rotulo}: rate-limit (tentativa ${i}/${tentativas}) — aguardando ${Math.round(espera / 1000)}s.`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimoErro;
}

const ehMock = (texto: string): boolean => /^\s*\[Mock (OpenAI|Gemini|Groq)/i.test(texto || '');

/** Executa `chamar` seguindo a cadeia, com cooldown de cota e mock-como-falha. */
async function comCadeia(
  rotulo: string,
  cadeia: ProviderName[],
  chamar: (p: IAProvider) => Promise<string>
): Promise<AIResult> {
  const ativos = cadeia.filter((p) => !emCooldown(p));
  // Todos em cooldown: tenta a cadeia inteira mesmo assim (melhor que falhar seco).
  const ordem = ativos.length ? ativos : cadeia;
  if (!ativos.length) console.warn(`⚠️ [AI] ${rotulo}: todos os provedores em cooldown de cota — tentando de novo.`);

  let ultimoErro: any = new Error('nenhum provedor de IA disponível');
  let mock: AIResult | null = null;

  for (const nome of ordem) {
    try {
      const text = await comRetry429(`${nome} (${rotulo})`, () => chamar(getProvider(nome)));
      if (ehMock(text)) {
        // Sem chave configurada: guarda como último recurso e tenta o próximo.
        mock = mock || { text, provider: nome };
        console.warn(`⚠️ [AI] ${nome}: sem chave (mock-mode) — tentando o próximo da cadeia.`);
        continue;
      }
      return { text, provider: nome };
    } catch (err: any) {
      ultimoErro = err;
      if (ehCotaEsgotada(err)) marcarCotaEsgotada(nome, err);
      else console.warn(`⚠️ [AI] ${nome} (${rotulo}) falhou: ${`${err?.message || err}`.slice(0, 160)}`);
    }
  }

  if (mock) return mock; // nenhum provedor tem chave — devolve o mock (dev)
  console.error(`❌ [AI] ${rotulo}: toda a cadeia (${ordem.join(' → ')}) falhou.`);
  throw ultimoErro;
}

/** Gera texto seguindo a cadeia de provedores. Lança só se TODOS falharem. */
export async function generateWithFallback(prompt: string, systemInstruction?: string): Promise<AIResult> {
  return comCadeia('texto', cadeiaTexto(), (p) => p.generateText(prompt, systemInstruction));
}

/** Gera texto a partir de uma IMAGEM (visão) seguindo a cadeia de visão. */
export async function generateFromImageWithFallback(
  prompt: string,
  imagem: ImagemEntrada,
  systemInstruction?: string
): Promise<AIResult> {
  return comCadeia('visão', cadeiaVisao(), (p) => p.generateFromImage(prompt, imagem, systemInstruction));
}
