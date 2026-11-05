export const BACKEND_TIMEOUT_MS = 10_000;

/** A request to the backend (BWAT_BACKEND_URL + path), given up after 10 s unless the caller gives its own signal. */
export type Backend = (path: string, init: RequestInit) => Promise<Response>;

export const backendAt = (backendUrl: string): Backend => (path, init) =>
  fetch(`${backendUrl}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(BACKEND_TIMEOUT_MS) });

/** A JSON POST to the backend, as `bearer` when one is given: the answer, and its body ({} when it has none). */
export async function postJson(backend: Backend, path: string, body: unknown, bearer?: string) {
  const res = await backend(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
