import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Backend } from '../backend.ts';

/**
 * A web plugin: the web side of a backend plugin (backend/src/plugins/<name>/), its code in
 * web/plugins/<name>/. Core never imports it; the registry (./index.ts) is the one place
 * that does. Whether it runs is the backend's to say: it is on only while the backend's
 * GET /v1/plugins lists it (and says what `requires` asks for), never by a list of the web
 * server's own (./activation.ts).
 */
export interface WebPlugin {
  /** Equals the backend plugin's name (GET /v1/plugins); its board scripts are served under /plugins/<name>/. */
  name: string;
  /** What the backend must say about it for this code to fit; otherwise it is unavailable, and an error is logged. */
  requires?: { embeds?: true };
  /**
   * The selector its sign-in answers to: the value of `?surface=` on a board page and of the
   * X-Bwat-Surface header on the page's requests (./selector.ts). Never `zoom` or `web`, the
   * board's own views. Claimed whether or not the plugin is on, so a request for it while it is
   * off is refused, never answered by another sign-in. Given only with `auth`.
   */
  token?: string;
  /**
   * Its sign-in, chosen only by its token, never by which cookies ride along. Without one, its
   * routes are the ordinary signed-in person's: they pass the board's sign-in gate first.
   */
  auth?: (deps: WebPluginDeps) => WebAuthProvider;
  /** The exact paths its routes use (checked at start: undeclared or core paths refuse it). */
  paths?: readonly string[];
  routes?: (app: FastifyInstance, deps: WebPluginDeps) => void;
  /** Board-page scripts, file names in its board/ folder, loaded in order before any identity request. */
  boardScripts?: readonly string[];
  /** Other scripts in its board/ folder, served beside its board scripts but never loaded into the board (a page of its own loads them). */
  assets?: readonly string[];
  /** Links the board draws in its slots (GET /board-links), each to one of its own paths. */
  links?: readonly PluginLink[];
}

/**
 * The board's slots for a plugin's link: `nav` in the app header; `meeting` in one meeting's
 * line, where the board puts the meeting's id in for `{meeting_id}` in the href.
 */
export const LINK_SLOTS = ['meeting', 'nav'] as const;

/** A link a plugin declares for one of the board's slots. */
export interface PluginLink {
  slot: (typeof LINK_SLOTS)[number];
  label: string;
  /** One of the plugin's own paths, with a query if it likes. */
  href: string;
}

/** One board page navigation's admission, as a plugin's sign-in decides it. */
export type PageDecision =
  | { pass: true }
  /** 303 there before any sign-in (core keeps it a local path without the selector). */
  | { redirect: string }
  /** A page with one fixed sentence. */
  | { status: number; text: string };

/** What core's sign-in asks a plugin's, for a request that selected it. */
export interface WebAuthProvider {
  /** A board page carrying ?surface=<token>. Asked only while the plugin is on. */
  admitPage(req: FastifyRequest): PageDecision;
  /** The bearer for a request marked with the token: its own credential only, or null (signed out). */
  bearer(req: FastifyRequest): string | null;
  /** The backend refused that bearer: end this plugin's credential only, never another sign-in's. */
  signOut(reply: FastifyReply): void;
}

/** What core hands a plugin (instance-bound things; it may import core's pure helpers itself). */
export interface WebPluginDeps {
  /** The sealed-cookie key (BWAT_SESSION_SECRET). */
  key: Buffer;
  /** A request to the backend (BWAT_BACKEND_URL + path), with core's timeout. */
  backend: Backend;
  /** Who may frame the board besides Zoom (BWAT_FRAME_ANCESTORS, config.ts frameAncestors), as configured. */
  frameAncestors: readonly string[];
}

/** A plugin's name, as the backend's (backend/src/plugins/plugin.ts PLUGIN_NAME); a selector token has the same shape. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
/** The board's own views (?surface=zoom, ?surface=web): never a plugin's token. */
export const VIEW_TOKENS: ReadonlySet<string> = new Set(['zoom', 'web']);
const SCRIPT = /^[a-z0-9][a-z0-9._-]*\.js$/;
const PATH = /^\/[a-z0-9][a-z0-9/_-]*$/;
/** Core's own paths, and the prefixes under which every path is core's. */
const CORE_PATHS = new Set(['/health', '/version', '/whoami', '/transcript', '/board-plugins', '/board-links', '/admin']);
const CORE_PREFIXES = ['/auth/', '/admin/', '/plugins/', '/v1/'];

/**
 * Refuses the start for a registry no request could be served by safely: a bad or repeated
 * name or token, a token without a sign-in (or the reverse), a path that is not a plain
 * absolute path or that is core's, or a script name that is not a plain .js file name.
 */
export function validateRegistry(registry: readonly WebPlugin[]): void {
  const names = new Set<string>();
  const tokens = new Set<string>();
  const paths = new Set<string>();
  for (const p of registry) {
    if (!PLUGIN_NAME.test(p.name) || names.has(p.name)) throw new Error(`web plugin: bad or repeated name ${JSON.stringify(p.name)}`);
    names.add(p.name);
    if ((p.token === undefined) !== (p.auth === undefined)) throw new Error(`web plugin ${p.name}: a token and a sign-in go together`);
    if (p.token !== undefined) {
      if (!PLUGIN_NAME.test(p.token) || VIEW_TOKENS.has(p.token) || tokens.has(p.token)) {
        throw new Error(`web plugin ${p.name}: bad or repeated token ${JSON.stringify(p.token)}`);
      }
      tokens.add(p.token);
    }
    if ((p.paths?.length ?? 0) > 0 && !p.routes) throw new Error(`web plugin ${p.name}: paths without routes`);
    for (const path of p.paths ?? []) {
      const core = CORE_PATHS.has(path) || CORE_PREFIXES.some((prefix) => path.startsWith(prefix));
      if (!PATH.test(path) || path.includes('//') || core || paths.has(path)) throw new Error(`web plugin ${p.name}: bad, repeated or core path ${JSON.stringify(path)}`);
      paths.add(path);
    }
    for (const link of p.links ?? []) {
      if (!LINK_SLOTS.includes(link.slot) || !link.label || !p.paths?.includes(link.href.split('?')[0]!)) {
        throw new Error(`web plugin ${p.name}: a link must be to one of its own paths, in a board slot: ${JSON.stringify(link)}`);
      }
    }
    for (const script of [...(p.boardScripts ?? []), ...(p.assets ?? [])]) {
      if (!SCRIPT.test(script)) throw new Error(`web plugin ${p.name}: bad board script name ${JSON.stringify(script)}`);
    }
  }
}
