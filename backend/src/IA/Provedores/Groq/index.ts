import OpenAI from 'openai';
import { fetch as undiciFetch } from 'undici';
import { IAProvider, ImagemEntrada } from '../types';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Groq — 3º provedor da cadeia de IA (30/07/2026).
 *
 * Motivo: OpenAI e Gemini vinham esgotando crédito/cota (429) e derrubavam TUDO
 * que depende de IA (Copiloto, extração de visão do Telegram, análise de risco).
 * A Groq tem free tier generoso, latência muito baixa (LPU) e API 100%
 * compatível com a da OpenAI — por isso reusa o mesmo SDK, só trocando baseURL.
 *
 * Modelos (GET https://api.groq.com/openai/v1/models):
 *  - openai/gpt-oss-120b      → default aqui; 131k de contexto e TOOL CALLING nativo
 *                                (é o motor do Agente, ver IA/agent/agentLoop.ts)
 *  - llama-3.3-70b-versatile  → alternativa sólida
 *  - qwen/qwen3.6-27b         → mais barato/rápido
 *
 * VISÃO: a conta não expõe modelo multimodal (não há llama-4-scout/maverick na
 * lista). generateFromImage() lança erro explícito em vez de devolver texto
 * inventado — assim o generateFromImageWithFallback tenta o próximo provedor e o
 * log diz o porquê. Se a Groq liberar visão, basta setar GROQ_MODEL_VISION.
 */
export class GroqProvider implements IAProvider {
  private client: OpenAI | null = null;
  private modelName = process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b';
  /** Só habilita visão se o modelo multimodal for explicitamente configurado. */
  private visionModelName = process.env.GROQ_MODEL_VISION?.trim() || '';

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey || apiKey.includes('your-groq-api-key')) {
      console.warn('⚠️ Groq API key is missing. Groq provider will run in mock mode.');
    } else {
      // fetch do undici (mesma razão do OpenAIProvider: o fetch embutido do SDK
      // derruba POSTs grandes com "Premature close" nesta VPS).
      this.client = new OpenAI({
        apiKey,
        baseURL: process.env.GROQ_BASE_URL?.trim() || 'https://api.groq.com/openai/v1',
        fetch: undiciFetch as any,
      });
    }
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    if (!this.client) {
      console.log(`[Mock Groq] Prompt: "${prompt.slice(0, 80)}..." | System: "${systemInstruction ? 'sim' : 'None'}"`);
      return `[Mock Groq Response] This is a mock response because GROQ_API_KEY is not configured. Received prompt: "${prompt}"`;
    }

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
      messages.push({ role: 'user', content: prompt });

      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages,
        temperature: 0.3,
      });
      return response.choices[0]?.message?.content || '';
    } catch (error) {
      console.error('Error generating text with Groq:', error);
      throw error;
    }
  }

  async generateFromImage(prompt: string, imagem: ImagemEntrada, systemInstruction?: string): Promise<string> {
    if (!this.client) {
      console.log(`[Mock Groq] Vision prompt: "${prompt.slice(0, 80)}..." | Imagem: ${imagem.mimeType}`);
      return `[Mock Groq Response] This is a mock response because GROQ_API_KEY is not configured. Received vision prompt with image ${imagem.mimeType}`;
    }
    if (!this.visionModelName) {
      throw new Error(
        'Groq sem modelo de visão configurado (defina GROQ_MODEL_VISION com um modelo multimodal disponível na conta).'
      );
    }

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${imagem.mimeType};base64,${imagem.dataBase64}` } },
        ],
      });

      const response = await this.client.chat.completions.create({
        model: this.visionModelName,
        messages,
        temperature: 0.1,
      });
      return response.choices[0]?.message?.content || '';
    } catch (error) {
      console.error('Error generating from image with Groq:', error);
      throw error;
    }
  }
}
