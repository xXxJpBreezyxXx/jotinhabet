/**
 * Utilitário de HTTP compartilhado (recon + scrapers de produção).
 *
 * `fetchTextoComRetry` foi extraído de casa_sureradar.ts para ser reutilizado pelo
 * probe de reconhecimento (teste de autenticação/proteção dos feeds das casas).
 */

export interface RespostaTexto {
  status: number;
  contentType: string;
  urlFinal: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * fetch com retry/backoff cobrindo TAMBÉM a leitura do corpo (o AbortController
 * interrompe o stream — sem isso um corpo travado penduraria ~300s no bodyTimeout
 * do undici, fora do retry). Status 5xx é transitório e também entra no retry.
 *
 * @param label prefixo de log (ex.: "SureRadar/API", "recon:betano")
 * @param timeoutMs janela do AbortController por tentativa (default 20s)
 */
export async function fetchTextoComRetry(
  url: string,
  init: RequestInit = {},
  tentativas = 3,
  label = 'HTTP',
  timeoutMs = 20000
): Promise<RespostaTexto> {
  let ultimoErro: any;
  for (let i = 1; i <= tentativas; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      const body = await resp.text(); // ainda dentro da janela do timeout
      if (resp.status >= 500) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return {
        status: resp.status,
        contentType: resp.headers.get('content-type') || '',
        urlFinal: resp.url || url,
        body,
        headers,
      };
    } catch (err: any) {
      ultimoErro = err;
      console.warn(`⚠️ [${label}] Tentativa ${i}/${tentativas} falhou: ${err.message}`);
      if (i < tentativas) await new Promise((r) => setTimeout(r, 2000 * i));
    } finally {
      clearTimeout(timer);
    }
  }
  throw ultimoErro;
}
