import OpenAI from 'openai';
import { IAProvider } from '../types';
import dotenv from 'dotenv';

dotenv.config();

export class OpenAIProvider implements IAProvider {
  private openai: OpenAI | null = null;
  private modelName = 'gpt-4o-mini';

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.includes('your-openai-api-key')) {
      console.warn('⚠️ OpenAI API key is missing. OpenAI provider will run in mock mode.');
    } else {
      this.openai = new OpenAI({ apiKey });
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
}
