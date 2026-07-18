/** Imagem para chamadas de visão: base64 SEM prefixo data-URI. */
export interface ImagemEntrada {
  mimeType: string;
  dataBase64: string;
}

export interface IAProvider {
  generateText(prompt: string, systemInstruction?: string): Promise<string>;
  generateFromImage(prompt: string, imagem: ImagemEntrada, systemInstruction?: string): Promise<string>;
}
