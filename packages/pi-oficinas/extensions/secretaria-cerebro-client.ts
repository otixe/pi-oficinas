// Cliente fetch único para hablar con el Cerebro desde la Secretaría (tarea
// c4f438d6, mitigación cliente de c5aa6829). Antes de esto cada error de red
// se logueaba sin decir QUÉ ruta cortó ni cuánto tardó ("barrido F4 fallido"
// sin más detalle); con 18 TimeoutError seguidos eso hacía imposible
// diagnosticar sin instrumentar a mano. Ahora todo error de fetch dice
// "<Nombre> <método> <ruta> <ms> ms", sin secretos y sin la key.
//
// `timedFetch` SOLO mide y re-lanza errores de RED/abort (nunca inspecciona
// el status): lo usa la sonda de clase (secretaria.ts `probe`), que necesita
// el status real de 403/404 para clasificar y no debe tratarlos como error.
// `fetchCerebro` se construye sobre `timedFetch` y ADEMÁS lanza en !ok, con
// el mismo formato; es lo que usan get()/post() y el worker del dispatcher
// — un único helper, nunca dos implementaciones del mismo mensaje.
export interface TimedFetchResult { response: Response; elapsedMs: number }

export async function timedFetch(base: string, path: string, init: RequestInit, timeoutMs: number): Promise<TimedFetchResult> {
  const start = Date.now();
  const method = typeof init?.method === 'string' ? init.method : 'GET';
  try {
    const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { response, elapsedMs: Date.now() - start };
  } catch (e: any) {
    const elapsedMs = Date.now() - start;
    const kind = typeof e?.name === 'string' && e.name ? e.name : 'FetchError';
    throw new Error(`${kind} ${method} ${path} ${elapsedMs} ms`);
  }
}

export async function fetchCerebro(base: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const { response, elapsedMs } = await timedFetch(base, path, init, timeoutMs);
  if (!response.ok) {
    const method = typeof init?.method === 'string' ? init.method : 'GET';
    throw new Error(`Cerebro HTTP ${response.status} ${method} ${path} ${elapsedMs} ms`);
  }
  return response;
}
