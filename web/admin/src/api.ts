import { useEffect } from 'react';
import { MutationCache, QueryCache, QueryClient, useQueryClient } from '@tanstack/react-query';

// Calls to the bwat backend, same origin, under /v1 (the edge routes them). The bearer is
// the person's Google id_token from the sign-in server's /whoami (D180); nothing else of
// theirs reaches the page.

// A non-2xx answer, with the backend's {error, message?} body when there is one. `body`
// keeps the whole parsed body, for refusals that carry more (`problems`, `currentRevisions`).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly serverMessage: string | undefined,
    readonly body: Record<string, unknown> = {},
  ) {
    super(`answered ${status}${code ? ` ${code}` : ''}`);
  }
}

export async function apiError(res: Response): Promise<ApiError> {
  const parsed: unknown = await res.json().catch(() => ({}));
  const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  return new ApiError(
    res.status,
    typeof body.error === 'string' ? body.error : undefined,
    typeof body.message === 'string' ? body.message : undefined,
    body,
  );
}

/** The signed-in member, as the backend's GET /v1/me answers it. */
export type Member = { id: string; email: string; display_name: string | null; role: 'owner' | 'admin' | 'member' };

export const isAdmin = (m: Member) => m.role === 'owner' || m.role === 'admin';

/** A member's name, or their email until they have one. */
export const nameOf = (m: { display_name: string | null; email: string }) => m.display_name || m.email;

/** Names as a sentence lists them: "A", "A and B", "A, B and C". */
export const andList = (names: readonly string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(''));

export type Whoami = { member: Member; id_token: string };

/** /whoami: 401 signed out, 503 sign-in not configured; otherwise the member and the bearer. */
export async function fetchWhoami(): Promise<Response> {
  return fetch('/whoami', { credentials: 'same-origin', cache: 'no-store' });
}

let bearer: string | null = null;
let shown: string | null = null;

/** The shell's own /whoami read sets the bearer too, so the person shown is the person sending. */
export function rememberBearer(me: Whoami) {
  bearer = me.id_token;
  shown = me.member.id;
}

async function token(again = false): Promise<string> {
  if (bearer && !again) return bearer;
  const res = await fetchWhoami();
  if (!res.ok) throw await apiError(res);
  const me = (await res.json()) as Whoami;
  // Another account signed in on this browser meanwhile: never act as it from a page that
  // shows someone else. Signed out here, so the shell reads /whoami and shows the new person.
  if (shown !== null && me.member.id !== shown) {
    bearer = null;
    throw new ApiError(401, 'signed_out', undefined);
  }
  bearer = me.id_token;
  return bearer;
}

/**
 * One /v1 call with the bearer; a 401 reads /whoami again once (an id_token that lapsed) and
 * retries. A Blob body (a picture) is sent as it is, with its own type; anything else as JSON.
 */
export async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const raw = body instanceof Blob;
  const send = async (again: boolean) =>
    fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        authorization: `Bearer ${await token(again)}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': raw ? body.type : 'application/json' }),
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  if (!res.ok) throw await apiError(res);
  return res;
}

export async function getJson<T>(path: string): Promise<T> {
  return (await (await api('GET', path)).json()) as T;
}

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function sendJson(method: Method, path: string, body?: unknown): Promise<void> {
  await api(method, path, body);
}

// For a change whose answer the page needs (a save that the server stamps).
export async function sendJsonForBody(method: Method, path: string, body?: unknown): Promise<unknown> {
  const res = await api(method, path, body);
  return res.status === 204 ? null : res.json();
}

/** A failed change in words: the page's copy for the server's code, else the generic line. */
export function messageFor(error: Error, copy: Readonly<Record<string, string>>): string {
  return (error instanceof ApiError && error.code && copy[error.code]) || 'Something went wrong and nothing changed. Try again.';
}

// The session ended: /whoami decides what to show (sign-in again).
export function sessionGone(error: Error): boolean {
  return error instanceof ApiError && error.status === 401;
}

// An HTTP answer is final; only a network failure is worth retrying.
export function retryNetworkOnly(failures: number, error: Error): boolean {
  return !(error instanceof ApiError) && failures < 3;
}

// Read once per visit, as the settings are: a refetch would move the revision under an edit.
// Neither a return to the tab nor a regained connection reads again.
export const ONCE = { retry: retryNetworkOnly, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

/** What a change refused as forbidden (someone made this admin a member) refetches, as its
 * `meta`: the reads that change what its page offers. Nothing when it names none. */
export const refetchOnForbidden = (...keys: string[][]) => ({ meta: { refetchOnForbidden: keys } });

// The admin's one query client. A read is retried on a network failure only. A read or a
// change that finds the session gone refetches /whoami, which decides what to show. A change
// refused as forbidden refetches what it names (refetchOnForbidden); a read refused so never
// refetches anything, or it would refetch itself.
export function makeQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: retryNetworkOnly } },
    queryCache: new QueryCache({
      onError: (error) => {
        if (sessionGone(error)) void client.invalidateQueries({ queryKey: ['me'] });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (sessionGone(error)) void client.invalidateQueries({ queryKey: ['me'] });
        else if (error instanceof ApiError && error.code === 'forbidden') {
          for (const queryKey of (mutation.meta?.refetchOnForbidden as string[][] | undefined) ?? []) {
            void client.invalidateQueries({ queryKey });
          }
        }
      },
    }),
  });
  return client;
}

// For a plugin's admin card, which may render under its own client: when its read or change
// finds the session gone, /whoami decides what to show. Keyed on the error object: once per
// failure, never once per render.
export function useRefetchMeWhenSessionGone(error: Error | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (error && sessionGone(error)) void queryClient.invalidateQueries({ queryKey: ['me'] });
  }, [error, queryClient]);
}
