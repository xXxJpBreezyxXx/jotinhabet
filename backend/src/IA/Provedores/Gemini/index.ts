import { GoogleGenAI } from '@google/genai';
import { IAProvider } from '../types';
import dotenv from 'dotenv';

dotenv.config();

export class GeminiProvider implements IAProvider {
  private ai: GoogleGenAI | null = null;
  private modelName = 'gemini-2.5-flash';

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.includes('your-gemini-api-key')) {
      console.warn('⚠️ Gemini API key is missing. Gemini provider will run in mock mode.');
    } else {
      // Correct initialization using the modern @google/genai SDK
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    if (!this.ai) {
      console.log(`[Mock Gemini] Prompt: "${prompt}" | System: "${systemInstruction || 'None'}"`);
      return `[Mock Gemini Response] This is a mock response because GEMINI_API_KEY is not configured. Received prompt: "${prompt}"`;
    }

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: prompt,
        config: systemInstruction ? { systemInstruction } : undefined,
      });

      return response.text || '';
    } catch (error) {
      console.error('Error generating text with Gemini:', error);
      throw error;
    }
  }
}
