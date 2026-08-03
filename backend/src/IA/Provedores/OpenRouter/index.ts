import OpenAI from 'openai';
import { fetch as undiciFetch } from 'undici';
import { IAProvider, ImagemEntrada } from '../types';
import dotenv from 'dotenv';

dotenv.config();

/**
 * OpenRouter — provedor de VISÃO do app (31/07/2026).
 *
 * Motivo de existir: a leitura de imagem (print de sinal do Telegram, print de
 * promoção mandado no WhatsApp) estava PARADA — OpenAI respondia "no credits
 * remaining", Gemini "prepayment credits are depleted" e a conta da Groq não tem
 * nenhum modelo multimodal (15 modelos, todos texto/áudio). A OpenRouter roteia
 * modelos de vários provedores, tem free tier multimodal e API 100% compatível
 * com a da OpenAI — reusa o mesmo SDK, só trocando baseURL.
 *
 * ESCADA DE MODELOS (`OPENROUTER_MODEL_FALLBACKS`): no free tier o 429 não é da
 * OpenRouter, é do provedor UPSTREAM ("google/gemma-4-31b-it:free is temporarily
 * rate-limited upstream") — medido no primeiro teste. Como cada modelo free tem
 * upstream próprio, descer a escada resolve o 429 na hora, mesmo padrão da escada
 * da Groq (ver Provedores/Groq).
 *
 * Modelos free multimodais medidos em 31/07/2026 com um print REAL de sinal
 * (todos leram odds/casas/mercado corretamente):
 *  - google/gemma-4-26b-a4b-it:free      21s — melhor aderência ao schema pedido,
 *                                        e o único que suporta response_format/
 *                                        structured_outputs (por isso é o default)
 *  - nvidia/nemotron-nano-12b-v2-vl:free 4,7s — o mais rápido; feito para
 *                                        "document intelligence"
 *  - google/gemma-4-31b-it:free          429 no teste (upstream congestionado)
 *  - nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free  6,4s
 */
export class OpenRouterProvider implements IAProvider {
  private client: OpenAI | null = null;
  private modelName = process.env.OPENROUTER_MODEL?.trim() || 'google/gemma-4-26b-a4b-it:free';
  private visionModelName =
    process.env.OPENROUTER_MODEL_VISION?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'google/gemma-4-26b-a4b-it:free';

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey.includes('your-openrouter')) {
      console.warn('⚠️ OpenRouter API key is missing. OpenRouter provider will run in mock mode.');
    } else {
      this.client = new OpenAI({
        apiKey,
        baseURL: process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
        // fetch do undici pelo mesmo motivo do OpenAIProvider/GroqProvider: o fetch
        // embutido do SDK derruba POST grande com "Premature close" nesta VPS — e o
        // POST de visão leva a imagem inteira em base64.
        fetch: undiciFetch as any,
        defaultHeaders: {
          // Recomendado pela OpenRouter para atribuição de uso (e ajuda no suporte).
          'HTTP-Referer': 'https://jotinhabet.eurekmind.com',
          'X-Title': 'JotinhaBet',
        },
      });
    }
  }

  /** Escada de modelos para o 429 do provedor upstream (o 1º é o configurado). */
  private escada(modeloBase: string): string[] {
    const extras = (process.env.OPENROUTER_MODEL_FALLBACKS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const padrao = [
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    ];
    return Array.from(new Set([modeloBase, ...(extras.length ? extras : padrao)]));
  }

  /**
   * Vale tentar o PRÓXIMO modelo da escada?
   *
   * Critério invertido de propósito: no free tier a falha é a regra, e ela chega de todas as
   * formas — 429 (fila do upstream), 504 ("Upstream idle timeout"), 502, e **500 "Internal
   * Server Error"** (medido em 31/07 num print real: a OpenRouter roteou o modelo para um
   * provedor que engasgou, enquanto o MESMO modelo respondia texto em 0,8s). Listar os
   * códigos que valem retry deixava de fora justamente o 500 e a escada nunca era usada.
   *
   * Só NÃO vale insistir no que é erro nosso: credencial (401/403), pedido inválido (400 —
   * ex.: modelo sem suporte a imagem) e modelo inexistente (404).
   */
  private valeProximoModelo(err: any): boolean {
    const status = Number(err?.status ?? err?.statusCode);
    return ![400, 401, 403, 404].includes(status);
  }

  private async completar(
    modeloBase: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    contexto: string
  ): Promise<string> {
    let ultimoErro: any = null;
    for (const model of this.escada(modeloBase)) {
      try {
        const r: any = await this.client!.chat.completions.create({
          model,
          messages,
          max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS) > 0 ? Number(process.env.OPENROUTER_MAX_TOKENS) : 1500,
        });
        // A OpenRouter responde **HTTP 200 com corpo {error:{code,message}}** quando o
        // provedor lá atrás falha (visto em produção: "Upstream idle timeout exceeded",
        // code 504). Sem este tratamento, `r.choices[0]` estourava
        // "Cannot read properties of undefined (reading '0')" — erro que não parece limite
        // de upstream, então a escada de modelos era PULADA e a cadeia de visão inteira
        // caía para OpenAI/Gemini (sem crédito). Foi o que derrubou a leitura de um print
        // real em 31/07 às 18:38.
        if (r?.error) {
          const e: any = new Error(`${r.error.message || 'erro do provedor upstream'}`);
          e.status = Number(r.error.code) || 502;
          throw e;
        }
        const texto = r?.choices?.[0]?.message?.content?.trim() || '';
        if (!texto) {
          const e: any = new Error(`resposta sem conteúdo (${JSON.stringify(r).slice(0, 160)})`);
          // Resposta vazia do free tier é congestionamento: vale tentar o próximo modelo.
          e.status = 502;
          throw e;
        }
        if (model !== modeloBase) console.warn(`⚠️ [OpenRouter] ${contexto}: caiu para ${model}.`);
        return texto;
      } catch (err: any) {
        ultimoErro = err;
        if (!this.valeProximoModelo(err)) {
          console.error(`❌ [OpenRouter] ${model}: ${`${err?.message || err}`.slice(0, 140)} (não vale insistir).`);
          break;
        }
        console.warn(
          `⚠️ [OpenRouter] ${model} falhou (${err?.status || '?'}: ${`${err?.message || err}`.slice(0, 90)}) — próximo modelo.`
        );
      }
    }
    throw ultimoErro || new Error('OpenRouter: nenhum modelo respondeu');
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    if (!this.client) {
      console.log(`[Mock OpenRouter] Prompt: "${prompt.slice(0, 80)}..."`);
      return `[Mock OpenRouter Response] OPENROUTER_API_KEY não configurada. Prompt: "${prompt}"`;
    }
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: prompt });
    return this.completar(this.modelName, messages, 'texto');
  }

  async generateFromImage(prompt: string, imagem: ImagemEntrada, systemInstruction?: string): Promise<string> {
    if (!this.client) {
      console.log(`[Mock OpenRouter] Visão: ${imagem.mimeType} (${imagem.dataBase64.length} chars)`);
      return `[Mock OpenRouter Response] OPENROUTER_API_KEY não configurada (visão).`;
    }
    // O tamanho entra no log porque é o suspeito nº 1 de 500 no free tier (print de celular
    // passa fácil de 2 MB) — sem isso não há como distinguir "imagem grande" de
    // "provedor engasgado" depois do fato.
    const kb = Math.round((imagem.dataBase64.length * 3) / 4 / 1024);
    console.log(`👁️ [OpenRouter] visão: ${imagem.mimeType}, ~${kb} KB`);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${imagem.mimeType};base64,${imagem.dataBase64}` } },
      ],
    });
    return this.completar(this.visionModelName, messages, 'visão');
  }
}
