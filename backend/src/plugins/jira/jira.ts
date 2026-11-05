import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { audit } from '../../audit.ts';
import type { CardContent } from '../../cards-client.ts';
import type { GetSecret } from '../../config.ts';
import { withTransaction } from '../../db/pool.ts';
import type { PluginStartDeps } from '../plugin.ts';
import { lockSettings, readStoredSetting, storedSettings, writeSetting } from '../../settings/store.ts';

/**
 * Route to Jira (QOR-4722, a plugin since QOR-4976): bwat files a card in Jira Cloud itself,
 * as one Jira account. The account's API token is the plugin's secret (jira.api_token); the
 * site, the project key and the account's email are its settings. The token never leaves the
 * backend and is never logged.
 */
export const API_TOKEN = 'jira.api_token';
/** The account email's old secret, moved to the jira_account_email setting at start. */
export const OLD_EMAIL = 'jira.email';

export interface JiraConfig {
  site: string;
  email: string;
  token: string;
  project: string;
}

/** A Jira site address as stored, `https://<name>.atlassian.net` with no path or trailing slash, or null when it is not one. */
export function normalizeSiteUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // The token is sent here: an Atlassian Cloud site over https only, no port or credentials, and the site itself, nothing after it.
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') return null;
  if (!/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(url.hostname)) return null;
  return url.origin;
}

// Hosts already named in the log: the board reads Jira's setup on every load.
const refusedHosts = new Set<string | null>();

/** The install's Jira, or null until all four values are set. */
export async function jiraConfig(pool: pg.Pool, getSecret: GetSecret, log: FastifyBaseLogger): Promise<JiraConfig | null> {
  const [site, email, token, project] = await Promise.all([
    readStoredSetting(pool, 'jira_site_url'),
    readStoredSetting(pool, 'jira_account_email'),
    getSecret(API_TOKEN),
    readStoredSetting(pool, 'jira_project_key'),
  ]);
  if (typeof site !== 'string' || !site || typeof email !== 'string' || !email || !token || typeof project !== 'string' || !project) return null;
  // Stored as https://<name>.atlassian.net, with no trailing slash (the site setting's check). A value
  // stored before that rule is not one to send the token to: said in the log by its host alone.
  if (normalizeSiteUrl(site) !== site) {
    const host = URL.canParse(site) ? new URL(site).host : null;
    if (!refusedHosts.has(host)) {
      refusedHosts.add(host);
      log.warn({ event: 'jira.site_refused', host }, 'stored Jira site is not an Atlassian Cloud site: Jira is off');
    }
    return null;
  }
  return { site, email, token, project };
}

/**
 * At startup: the account email, once a secret (jira.email), moves to the jira_account_email
 * setting, and the secret is deleted. A value seeded as jira.email since (npm run
 * seed-secrets) moves the same way at the next start, while the setting was never saved. The
 * write commits before the delete: the aws store cannot join the transaction, and a delete
 * that fails is retried next start. A setting already saved (by an earlier move, or in the
 * panel since, a reset included) is never overwritten: the retry only deletes the secret.
 */
export async function moveJiraEmailToSetting(pool: pg.Pool, store: PluginStartDeps['secrets']): Promise<void> {
  const email = await store.get(OLD_EMAIL);
  if (email === null) return;
  await withTransaction(pool, async (client) => {
    await lockSettings(client);
    if ((await storedSettings(client, ['jira_account_email'])).size > 0) return;
    const revision = await writeSetting(client, null, 'jira_account_email', email.trim());
    // By no one, and without the address: audit rows never carry an email (audit.ts).
    await audit(client, { actor: null, action: 'settings.updated', target: 'settings:jira', after: { jira_account_email: { value: 'set', revision } } });
  });
  await store.delete(OLD_EMAIL);
}

/** Jira answered with something other than a created issue; `status` is Jira's. */
export class JiraFailed extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`jira answered ${status}`);
    this.status = status;
  }
}

const TIMEOUT_MS = 15_000;
const basic = (config: JiraConfig) => `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`;
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/**
 * Creates the card's Task (POST /rest/api/3/issue): the card's title as its summary; its
 * note, each quote with its speaker, and who sent it as the description, in Atlassian
 * Document Format. Answers the issue's key and its browse address.
 */
export async function createJiraIssue(config: JiraConfig, card: CardContent, sentBy: string, fetchFn: typeof fetch): Promise<{ key: string; url: string }> {
  // A text node may not be empty: only the parts the card has.
  const lines = [card.note, ...card.quotes.map((q) => `${q.speaker}: "${q.quote}"`), `Sent from bwat by ${sentBy}`].filter((l) => l.trim());
  const res = await fetchFn(`${config.site}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      authorization: basic(config),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: { key: config.project },
        issuetype: { name: 'Task' },
        summary: jiraSummary(card.title),
        description: { type: 'doc', version: 1, content: lines.map(paragraph) },
      },
    }),
    // A redirect would carry the credential somewhere else: refused.
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    throw new JiraFailed(0);
  });
  const created = (await res.json().catch(() => null)) as { key?: unknown } | null;
  if (!res.ok || typeof created?.key !== 'string' || !ISSUE_KEY.test(created.key)) throw new JiraFailed(res.status);
  return { key: created.key, url: `${config.site}/browse/${created.key}` };
}

/** What the admin panel's Connect learns: whether Jira takes the account's token, and has the project. */
export type JiraCheck = 'connected' | 'refused' | 'no_project' | 'unreachable';

/** Asks Jira for the project as the account (GET /rest/api/3/project/{key}). Answers Jira's status too, 0 when unreached. */
export async function checkJira(config: JiraConfig, fetchFn: typeof fetch): Promise<{ result: JiraCheck; status: number }> {
  const res = await fetchFn(`${config.site}/rest/api/3/project/${encodeURIComponent(config.project)}`, {
    headers: { authorization: basic(config), accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res) return { result: 'unreachable', status: 0 };
  const result: JiraCheck = res.ok ? 'connected' : res.status === 401 || res.status === 403 ? 'refused' : res.status === 404 ? 'no_project' : 'unreachable';
  return { result, status: res.status };
}

/** A Jira issue key, as its table's check takes it. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

/** Jira refuses a summary over 255 characters or with a line break; a card title may be 300. */
export const jiraSummary = (title: string): string => title.replace(/\s+/g, ' ').trim().slice(0, 255);
