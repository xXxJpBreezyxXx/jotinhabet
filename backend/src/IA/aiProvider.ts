import { GeminiProvider } from './Provedores/Gemini';
import { OpenAIProvider } from './Provedores/OpenAI';

/**
 * Camada única de acesso à IA para o pipeline.
 *
 * Estratégia (decisão do plano): Gemini (gemini-2.5-flash) como provedor
 * principal, com fallback automático para OpenAI (gpt-4o-mini) em caso de
 * erro/rate-limit. Ambos os provedores já implementam `IAProvider` e possuem
 * mock-mode quando a chave não está configurada (nesse caso NÃO lançam erro,
 * retornam uma string de mock — o chamador deve tratar o parsing).
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

/**
 * Gera texto usando Gemini e, em caso de falha, cai para OpenAI.
 * Lança erro somente se AMBOS os provedores falharem.
 */
export async function generateWithFallback(
  prompt: string,
  systemInstruction?: string
): Promise<AIResult> {
  try {
    const text = await getGemini().generateText(prompt, systemInstruction);
    return { text, provider: 'gemini' };
  } catch (errGemini: any) {
    console.warn(`⚠️ [AI] Gemini falhou (${errGemini?.message || errGemini}). Tentando OpenAI...`);
    try {
      const text = await getOpenAI().generateText(prompt, systemInstruction);
      return { text, provider: 'openai' };
    } catch (errOpenAI: any) {
      console.error(`❌ [AI] Ambos os provedores falharam. OpenAI: ${errOpenAI?.message || errOpenAI}`);
      throw errOpenAI;
    }
  }
}
