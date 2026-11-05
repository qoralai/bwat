import type { FastifyRequest } from 'fastify';
import { VIEW_TOKENS, type WebPlugin } from './plugin.ts';

/**
 * Which sign-in a request asks for, chosen before any credential is read (never by which
 * cookies happen to ride along). A page navigation says it in its URL (`?surface=`), a request
 * the page makes in a header (X-Bwat-Surface), since a navigation carries no header.
 *
 * - none: no plugin's sign-in was asked for; the ordinary sign-in (Google, Zoom) answers.
 * - requested: a plugin's token was asked for; that plugin's sign-in answers, or the request is
 *   refused (the plugin off: 404; the backend's list unreadable: 503). Never the ordinary sign-in.
 * - ambiguous (a page with more than one `surface`) and malformed (a header that is not exactly
 *   one plugin's token): refused (400) before anything else.
 * - unknown (a page whose `surface` is neither a board view nor any plugin's token, e.g. a plugin
 *   whose web code is not here): refused as unavailable (404), never the ordinary sign-in.
 */
export type Selection =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'malformed' }
  | { kind: 'unknown' }
  | { kind: 'requested'; plugin: WebPlugin };

/** What the board page marks every request it makes for a plugin's sign-in with (pages/board/bwat-api.js). */
const SURFACE_HEADER = 'x-bwat-surface';

/** Every `surface` in a URL's query. */
const surfacesOf = (url: string): string[] => {
  const at = url.indexOf('?');
  if (at < 0) return [];
  const hash = url.indexOf('#', at);
  return new URLSearchParams(url.slice(at + 1, hash < 0 ? undefined : hash)).getAll('surface');
};

const claiming = (token: string | undefined, registry: readonly WebPlugin[]) =>
  token === undefined ? undefined : registry.find((p) => p.token !== undefined && p.token === token);

/**
 * A page URL: more than one `surface` is ambiguous; none, or one of the board's own views (zoom,
 * web), is none; one that is a plugin's token (whether that plugin is on or not) requests it; any
 * other value, empty included, is unknown.
 */
export function pageSelection(url: string, registry: readonly WebPlugin[]): Selection {
  const all = surfacesOf(url);
  if (all.length > 1) return { kind: 'ambiguous' };
  if (all.length === 0 || VIEW_TOKENS.has(all[0]!)) return { kind: 'none' };
  const plugin = claiming(all[0], registry);
  return plugin ? { kind: 'requested', plugin } : { kind: 'unknown' };
}

/**
 * A request's X-Bwat-Surface, strictly: absent is none; exactly one plugin's token requests
 * it; anything else (an unknown value, a view name, two headers, which Node joins with ", ")
 * is malformed. Only the board page sets it.
 */
export function requestSelection(req: FastifyRequest, registry: readonly WebPlugin[]): Selection {
  const value = req.headers[SURFACE_HEADER];
  if (value === undefined) return { kind: 'none' };
  const plugin = typeof value === 'string' ? claiming(value, registry) : undefined;
  return plugin ? { kind: 'requested', plugin } : { kind: 'malformed' };
}

/** The path with every `surface` dropped, the rest of the query and any fragment kept. */
export function withoutSurface(path: string): string {
  const hash = path.indexOf('#');
  const fragment = hash < 0 ? '' : path.slice(hash);
  const rest = hash < 0 ? path : path.slice(0, hash);
  const at = rest.indexOf('?');
  if (at < 0) return path;
  const query = new URLSearchParams(rest.slice(at + 1));
  query.delete('surface');
  const qs = query.toString();
  return rest.slice(0, at) + (qs ? `?${qs}` : '') + fragment;
}
