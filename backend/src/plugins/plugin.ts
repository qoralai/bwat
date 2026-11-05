import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { CardsClient } from '../cards-client.ts';
import type { GetSecret } from '../config.ts';
import type { AuthenticatePerson } from '../people-auth.ts';
import { isTier2Name } from '../secret-names.ts';
import { settingDef } from '../settings/catalogue.ts';
import { switchKey } from './switches.ts';

/**
 * A plugin (QOR-4806): an integration bwat ships but runs only where an install switches it
 * on. Its code lives in src/plugins/<name>/ and core never imports it; the one place that
 * does is the registry, src/plugins/index.ts. Its migrations live in
 * migrations/plugins/<name>/ and are applied whether or not it is on (migrate.ts). An owner
 * or admin switches it on the panel's Plugins page (switches.ts); every shipped plugin is
 * registered at start, and while it is off its bearer signs in nobody and its routes are 404.
 */
export interface BwatPlugin {
  /** Lowercase; its routes are /v1/plugins/<name>/*. */
  name: string;
  /** The product's own name, as the pairing page says it ("Type this code into <displayName>"). */
  displayName: string;
  /** One line on what it adds, as the panel's Plugins page shows it. */
  description: string;
  /**
   * Operator config it cannot run without: the panel shows "Needs setup" and refuses to switch
   * it on until the env var is set. `to` finishes "Your server's operator needs to ...".
   */
  needs?: { env: string; to: string };
  /**
   * What it holds, as one line that finishes "Its ... disappear from the board" (say, "3
   * lists and the tags on 21 cards"), or null when it holds nothing. Turning it off then
   * asks first. Without it, a plugin turns off at once.
   */
  holds?: (pool: pg.Pool) => Promise<string | null>;
  /**
   * The board opens inside its product: its routes answer POST /embed/redeem {ticket} with a
   * board token, which the web server's /embed calls for the ticket the product framed it with.
   */
  embeds?: true;
  /**
   * Its own bearer, if it signs people in: wraps the person-auth chain, answering for its
   * own token shape and passing everything else to `inner`. Once a bearer has its shape, it
   * asks `isOn` and, while the plugin is off, passes that one to `inner` too, as if it were
   * not there: so a request with any other bearer never waits on the switch.
   */
  authenticate?: (pool: pg.Pool, isOn: () => Promise<boolean>) => (inner: AuthenticatePerson) => AuthenticatePerson;
  /**
   * The tier-2 secrets its routes read (deps.getSecret), each named `<name>.<what>`: a name
   * outside its own is never read. An owner or admin sets them with the panel's others
   * (GET, PUT, DELETE /console/secrets).
   */
  secrets?: readonly string[];
  /**
   * Secrets it once kept and now only moves away at `start` (a value seeded since included),
   * named as `secrets` are: the store and `npm run seed-secrets` keep them, the panel never
   * shows them and its routes never read them.
   */
  retiredSecrets?: readonly string[];
  /**
   * Its settings, each a row in bwat.settings under `<name>_<what>`: a key outside its own is
   * none of its settings, and a hyphenated plugin name has none (bwat.settings keys take no
   * `-`). Any signed-in person reads them and an owner or admin saves them
   * (/console/plugins/<name>/settings), on or off; its routes read them from the store.
   */
  settings?: readonly PluginSetting[];
  /**
   * Its routes, registered under /v1/plugins/<name>. A route that needs a signed-in person
   * says so (deps.authenticatePerson); one that doesn't (a pairing code is its own proof)
   * must check what it trusts itself.
   */
  routes?: (api: FastifyInstance, deps: PluginDeps) => void;
  /**
   * Once at each server start, on or off (as its migrations are), after the migrations: a step
   * that moves what an older version left (a retired secret into a setting, say). It is
   * awaited; it logs its own failure and must not throw, or the start fails.
   */
  start?: (deps: PluginStartDeps) => Promise<void>;
}

/** What core hands a plugin's start step. */
export interface PluginStartDeps {
  pool: pg.Pool;
  /**
   * The secret store, which keeps the plugin's own and retired names: what a start step uses of
   * it (secrets/store.ts SecretStore, not imported here: npm run migrate loads this file, and
   * the store loads the AWS SDK).
   */
  secrets: { get(name: string): Promise<string | null>; delete(name: string): Promise<boolean> };
  log: FastifyBaseLogger;
}

/** One of a plugin's settings. Unset (null) until saved; a save of null resets it. */
export interface PluginSetting {
  key: string;
  /** The plain label. */
  label: string;
  /** The problem with a value other than null, as a sentence naming it; null when it is fine. */
  check: (value: unknown) => string | null;
  /** The value as stored, once it passes: trimmed, say. Default: as sent. */
  normalise?: (value: unknown) => unknown;
  /**
   * Its value is shown in the audit row. Without it, a row says only `set` (or null): an email,
   * a name or free text never reaches the audit table (audit.ts), so showing one is a choice.
   */
  auditValue?: true;
}

/** What core hands a plugin's routes. */
export interface PluginDeps {
  pool: pg.Pool;
  /** The whole person-auth chain, every switched-on plugin's bearer included. */
  authenticatePerson: AuthenticatePerson;
  now: () => number;
  /** The card service's backend-only calls (cards-client.ts), or none while the install has no card service. */
  cards?: CardsClient | undefined;
  /** Reads one of its own `secrets`; null for any other name, and while it is not set. */
  getSecret: GetSecret;
  /** The fetch its calls out of bwat go through (the global fetch; a stub in tests). */
  fetch: typeof fetch;
}

/**
 * The secrets these plugins keep: each one's own `secrets` under its `<name>.` prefix, never
 * one of core's (a plugin named `provider` does not get `provider.openrouter`).
 */
export const pluginSecretNames = (plugins: readonly BwatPlugin[], { retired = false } = {}): string[] =>
  plugins.flatMap((p) =>
    [...(p.secrets ?? []), ...(retired ? (p.retiredSecrets ?? []) : [])].filter((name) => name.startsWith(`${p.name}.`) && !isTier2Name(name)),
  );

/** A key bwat.settings takes (migration 0007's check). */
const SETTING_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A plugin's settings: those it declares under its own `<name>_` prefix that bwat.settings can
 * hold, never one of core's catalogue (a plugin named `jev` does not get `jev_enabled`) nor a
 * plugin's switch (`plugin_<name>`, switches.ts). A hyphenated plugin name has no such keys.
 */
export const pluginSettings = (plugin: BwatPlugin): readonly PluginSetting[] =>
  (plugin.settings ?? []).filter(
    (s) => s.key.startsWith(`${plugin.name}_`) && SETTING_KEY.test(s.key) && !settingDef(s.key) && !s.key.startsWith(switchKey('')),
  );

/** A plugin's name: its route prefix, its migrations folder and its switch's key. */
export const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
