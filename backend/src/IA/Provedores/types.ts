export interface IAProvider {
  generateText(prompt: string, systemInstruction?: string): Promise<string>;
}
