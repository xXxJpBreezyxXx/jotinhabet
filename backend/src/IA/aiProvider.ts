import { GeminiProvider } from './Provedores/Gemini';
import { OpenAIProvider } from './Provedores/OpenAI';
import { ImagemEntrada } from './Provedores/types';

export { ImagemEntrada };

/**
 * Camada única de acesso à IA para o pipeline.
 *
 * Estratégia (18/07/2026): OpenAI (gpt-4o-mini) como provedor PRINCIPAL, com
 * fallback automático para Gemini (gemini-2.5-flash) em caso de erro/rate-limit.
 * (Invertido em 18/07: o Gemini free-tier vinha esgotando crédito/cota e derrubando
 * a extração de visão dos sinais do Telegram — OpenAI é mais estável como primário.)
 * Ambos implementam `IAProvider` e têm mock-mode quando a chave não está configurada
 * (nesse caso NÃO lançam erro, retornam uma string de mock — o chamador trata o parsing).
 */

export type ProviderName = 'gemini' | 'openai';

export interface AIResult {
  text: string;
  provider: ProviderName;
}

// Instâncias preguiçosas (lazy) para não construir clientes na importação.
let geminiInstance: GeminiProvider | null = null;
let openaiInstance: OpenAIProvider | null = null;

function getGemini(): GeminiProvider {
  if (!geminiInstance) geminiInstance = new GeminiProvider();
  return geminiInstance;
}

function getOpenAI(): OpenAIProvider {
  if (!openaiInstance) openaiInstance = new OpenAIProvider();
  return openaiInstance;
}

/** Espera sugerida (ms) quando o erro é rate-limit (429/RESOURCE_EXHAUSTED);
 *  null para qualquer outro erro. Honra o retryDelay que a API do Gemini
 *  devolve ("Please retry in 9.7s" / "retryDelay":"9s"), com teto de 60s. */
function delayDe429(err: any): number | null {
  const msg = `${err?.message || err}`;
  if (!/429|RESOURCE_EXHAUSTED|rate limit/i.test(msg)) return null;
  // Cota/créditos esgotados (Gemini OU OpenAI) NÃO voltam em segundos — re-tentar só
  // atrasa o fallback. Vai direto pro outro provedor (e o log avisa pra recarregar).
  if (/credits are depleted|prepayment|insufficient_quota|exceeded your current quota|billing hard limit/i.test(msg)) {
    console.error('💳 [AI] Cota/créditos ESGOTADOS no provedor primário — usando fallback sem re-tentativa. Recarregue o crédito.');
    return null;
  }
  const m = msg.match(/retry in (\d+(?:\.\d+)?)s/i) || msg.match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
  const s = m ? parseFloat(m[1]) : 15;
  return Math.min(60, Math.ceil(s) + 1) * 1000;
}

/**
 * Executa a chamada com até `tentativas` re-tentativas SÓ para rate-limit,
 * esperando o retryDelay da API entre elas. A fila do Telegram é serializada,
 * então segurar ~10s aqui não gera concorrência — só atrasa a rajada, que é
 * exatamente o que a cota (15 RPM no free tier) pede.
 */
async function comRetry429<T>(rotulo: string, fn: () => Promise<T>, tentativas = 3): Promise<T> {
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

/**
 * Gera texto usando OpenAI (primário) e, em caso de falha, cai para Gemini.
 * Lança erro somente se AMBOS os provedores falharem.
 */
export async function generateWithFallback(
  prompt: string,
  systemInstruction?: string
): Promise<AIResult> {
  try {
    const text = await comRetry429('OpenAI', () => getOpenAI().generateText(prompt, systemInstruction));
    return { text, provider: 'openai' };
  } catch (errOpenAI: any) {
    console.warn(`⚠️ [AI] OpenAI falhou (${errOpenAI?.message || errOpenAI}). Tentando Gemini...`);
    try {
      const text = await getGemini().generateText(prompt, systemInstruction);
      return { text, provider: 'gemini' };
    } catch (errGemini: any) {
      console.error(`❌ [AI] Ambos os provedores falharam. Gemini: ${errGemini?.message || errGemini}`);
      throw errGemini;
    }
  }
}

/**
 * Gera texto a partir de uma IMAGEM (visão) usando OpenAI (primário) e, em caso de
 * falha, cai para Gemini. Lança erro somente se AMBOS os provedores falharem.
 * Em mock-mode (chaves ausentes) retorna string '[Mock ...' sem lançar.
 */
export async function generateFromImageWithFallback(
  prompt: string,
  imagem: ImagemEntrada,
  systemInstruction?: string
): Promise<AIResult> {
  try {
    const text = await comRetry429('OpenAI (visão)', () => getOpenAI().generateFromImage(prompt, imagem, systemInstruction));
    return { text, provider: 'openai' };
  } catch (errOpenAI: any) {
    console.warn(`⚠️ [AI] OpenAI (visão) falhou (${errOpenAI?.message || errOpenAI}). Tentando Gemini...`);
    try {
      const text = await getGemini().generateFromImage(prompt, imagem, systemInstruction);
      return { text, provider: 'gemini' };
    } catch (errGemini: any) {
      console.error(`❌ [AI] Ambos os provedores (visão) falharam. Gemini: ${errGemini?.message || errGemini}`);
      throw errGemini;
    }
  }
}
