import OpenAI from 'openai';
import { fetch as undiciFetch } from 'undici';
import { IAProvider, ImagemEntrada } from '../types';
import dotenv from 'dotenv';

dotenv.config();

export class OpenAIProvider implements IAProvider {
  private openai: OpenAI | null = null;
  // Sobrescrevível via env (OPENAI_MODEL) para trocar de modelo sem rebuild.
  private modelName = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.includes('your-openai-api-key')) {
      console.warn('⚠️ OpenAI API key is missing. OpenAI provider will run in mock mode.');
    } else {
      // fetch do undici no lugar do node-fetch embutido do SDK: o node-fetch
      // derruba POSTs grandes (imagem base64) com "Premature close" nesta VPS;
      // com curl e com undici (scrapers) a mesma chamada funciona.
      this.openai = new OpenAI({ apiKey, fetch: undiciFetch as any });
    }
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    if (!this.openai) {
      console.log(`[Mock OpenAI] Prompt: "${prompt}" | System: "${systemInstruction || 'None'}"`);
      return `[Mock OpenAI Response] This is a mock response because OPENAI_API_KEY is not configured. Received prompt: "${prompt}"`;
    }

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      
      if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
      }
      
      messages.push({ role: 'user', content: prompt });

      const response = await this.openai.chat.completions.create({
        model: this.modelName,
        messages: messages,
      });

      return response.choices[0]?.message?.content || '';
    } catch (error) {
      console.error('Error generating text with OpenAI:', error);
      throw error;
    }
  }

  async generateFromImage(prompt: string, imagem: ImagemEntrada, systemInstruction?: string): Promise<string> {
    if (!this.openai) {
      console.log(`[Mock OpenAI] Vision prompt: "${prompt.slice(0, 80)}..." | Imagem: ${imagem.mimeType} (${imagem.dataBase64.length} chars)`);
      return `[Mock OpenAI Response] This is a mock response because OPENAI_API_KEY is not configured. Received vision prompt with image ${imagem.mimeType}`;
    }

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
      }

      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${imagem.mimeType};base64,${imagem.dataBase64}` } },
        ],
      });

      const response = await this.openai.chat.completions.create({
        model: this.modelName,
        messages: messages,
      });

      return response.choices[0]?.message?.content || '';
    } catch (error) {
      console.error('Error generating from image with OpenAI:', error);
      throw error;
    }
  }
}
