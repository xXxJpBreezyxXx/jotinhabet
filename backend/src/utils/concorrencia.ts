/**
 * Executa `fn` sobre `itens` com no máximo `limite` tarefas em paralelo, PRESERVANDO a
 * ordem dos resultados (resultados[i] corresponde a itens[i], independentemente da ordem
 * de conclusão) e ISOLANDO falhas — uma rejeição vira um PromiseRejectedResult sem
 * derrubar as demais. Mesmo contrato de um laço try/catch sequencial, mas com concorrência
 * limitada; usado para coletar scrapers de API/WS (I/O-bound) sem serializar o snapshot.
 */
export async function comLimite<T, R>(
  itens: T[],
  limite: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const resultados: PromiseSettledResult<R>[] = new Array(itens.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      try {
        resultados[i] = { status: 'fulfilled', value: await fn(itens[i], i) };
      } catch (reason) {
        resultados[i] = { status: 'rejected', reason } as PromiseRejectedResult;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limite, itens.length)) }, trabalhador));
  return resultados;
}
