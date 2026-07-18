import { GoogleGenAI } from '@google/genai';
import { IAProvider, ImagemEntrada } from '../types';
import dotenv from 'dotenv';

dotenv.config();

export class GeminiProvider implements IAProvider {
  private ai: GoogleGenAI | null = null;
  // Sobrescrevível via env (GEMINI_MODEL) para trocar de modelo sem rebuild.
  private modelName = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';

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

  async generateFromImage(prompt: string, imagem: ImagemEntrada, systemInstruction?: string): Promise<string> {
    if (!this.ai) {
      console.log(`[Mock Gemini] Vision prompt: "${prompt.slice(0, 80)}..." | Imagem: ${imagem.mimeType} (${imagem.dataBase64.length} chars)`);
      return `[Mock Gemini Response] This is a mock response because GEMINI_API_KEY is not configured. Received vision prompt with image ${imagem.mimeType}`;
    }

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: [
          { text: prompt },
          { inlineData: { mimeType: imagem.mimeType, data: imagem.dataBase64 } },
        ],
        config: systemInstruction ? { systemInstruction } : undefined,
      });

      return response.text || '';
    } catch (error) {
      console.error('Error generating from image with Gemini:', error);
      throw error;
    }
  }
}
