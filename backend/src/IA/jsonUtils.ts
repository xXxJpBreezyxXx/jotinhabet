/**
 * Extrai o primeiro objeto JSON de uma resposta (possivelmente "suja") de LLM:
 * remove cercas de markdown (```json ... ```) e isola do primeiro '{' ao último
 * '}'. Retorna null se não houver JSON parseável. A validação/coerção dos
 * campos é responsabilidade de cada chamador (ex.: parseVerdict, validarSinal).
 */
export function extrairJsonDeLLM(raw: string): any | null {
  if (!raw) return null;
  const semFence = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const inicio = semFence.indexOf('{');
  const fim = semFence.lastIndexOf('}');
  if (inicio === -1 || fim === -1 || fim <= inicio) return null;

  try {
    return JSON.parse(semFence.slice(inicio, fim + 1));
  } catch {
    return null;
  }
}
