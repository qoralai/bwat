import { z } from 'zod';
import { CardsUnavailable } from '../../cards-client.ts';
import { CardIdsQuery } from '../../http.ts';
import { memberById } from '../../members.ts';
import { requireAdmin, requireOnboardedPerson, signedInPerson } from '../../people-auth.ts';
import type { BwatPlugin } from '../plugin.ts';
import { API_TOKEN, checkJira, createJiraIssue, jiraConfig, JiraFailed, moveJiraEmailToSetting, normalizeSiteUrl, OLD_EMAIL } from './jira.ts';

const CardId = z.string().uuid();
const label = { site: 'Jira site address', project: 'Jira project key', email: 'Jira account email' };

/** An issue a card was sent to, as its table keeps it. */
interface Issue {
  card_id: string;
  key: string;
  url: string;
  /** Who pressed; null for an issue from before the plugin. */
  sent_by: string | null;
}

/**
 * Jira (QOR-4976): Route to Jira as a plugin. A member files a to-do or a risk as a Jira Cloud
 * Task with one press, once per card; the card then links its issue. Its data is the jira schema
 * (migrations/plugins/jira): jira.card_issues, one issue per card. README.md has its routes.
 */
export const jira: BwatPlugin = {
  name: 'jira',
  displayName: 'Jira',
  description: 'File a to-do or a risk in Jira Cloud with one press.',
  secrets: [API_TOKEN],
  retiredSecrets: [OLD_EMAIL],
  settings: [
    {
      key: 'jira_site_url',
      label: label.site,
      check: (v) => (normalizeSiteUrl(v) ? null : `${label.site} must be your Jira site's address, like https://yourcompany.atlassian.net.`),
      normalise: (v) => normalizeSiteUrl(v),
      auditValue: true,
    },
    {
      key: 'jira_project_key',
      label: label.project,
      check: (v) => (typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v) ? null : `${label.project} must be a Jira project key, like ABC.`),
      auditValue: true,
    },
    {
      key: 'jira_account_email',
      label: label.email,
      check: (v) => (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : `${label.email} must be an email address, like ops@yourcompany.com.`),
      normalise: (v) => String(v).trim(),
    },
  ],
  holds: async (pool) => {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jira.card_issues`);
    const n = rows[0]!.n;
    return n === 0 ? null : `links to ${n} Jira issue${n === 1 ? '' : 's'}`;
  },
  // Never a value in the log: only the error's name. Tried again at the next start.
  start: ({ pool, secrets, log }) =>
    moveJiraEmailToSetting(pool, secrets).catch((err: { name?: string }) =>
      log.warn({ event: 'jira.email_not_moved', code: err.name }, 'the stored Jira email could not be moved to its setting'),
    ),
  routes: (api, { pool, authenticatePerson, cards, getSecret, fetch }) => {
    api.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    // Whether Jira is set up: never any part of how.
    api.get('/status', async (req) => ({ enabled: (await jiraConfig(pool, getSecret, req.log)) !== null }));

    // The plugin's setup card: whether the stored account reaches the project. Answers only
    // the outcome; logs it with Jira's status.
    api.post('/check', async (req, reply) => {
      if (!(await requireAdmin(pool, req, reply))) return reply;
      const config = await jiraConfig(pool, getSecret, req.log);
      if (!config) return reply.code(409).send({ error: 'jira_not_configured' });
      const { result, status } = await checkJira(config, fetch);
      req.log.info({ event: 'jira.checked', result, status }, 'Jira connection checked');
      return { result };
    });

    // The issue each of these cards was sent to, or a card merged into it was (cards sent to none
    // are left out), for the board: only cards the card service has.
    api.get('/issues', async (req, reply) => {
      const query = CardIdsQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
      if (!cards) return reply.code(502).send({ error: 'cards_unavailable' });
      try {
        const issueOf = await issuesOf(query.data, signedInPerson(req).id);
        return { issues: query.data.flatMap((id) => (issueOf.has(id) ? [{ card_id: id, ...issueOf.get(id)! }] : [])) };
      } catch (err) {
        if (!(err instanceof CardsUnavailable)) throw err;
        return reply.code(502).send({ error: 'cards_unavailable' });
      }
    });

    /**
     * Each card's issue, by card id: its own, else that of the first card merged into it which
     * has one (the card service merges cards; the issue stays on the card it was filed for). A
     * card that, with those merged into it, was sent to more than one issue shows one: the others
     * keep their rows and show again if a person undoes the merge (such merges are accepted).
     */
    async function issuesOf(ids: string[], memberId: string): Promise<Map<string, { key: string; url: string }>> {
      const facts = await cards!.facts({ card_ids: ids }, memberId);
      const named = [...new Set(facts.flatMap((f) => [f.id, ...f.merged_from]))];
      const { rows } = await pool.query<Omit<Issue, 'sent_by'>>(`SELECT card_id, key, url FROM jira.card_issues WHERE card_id = ANY($1::uuid[])`, [named]);
      const own = new Map(rows.map((r) => [r.card_id, { key: r.key, url: r.url }]));
      const issueOf = new Map<string, { key: string; url: string }>();
      for (const f of facts) {
        const issue = [f.id, ...f.merged_from].map((c) => own.get(c)).find(Boolean);
        if (issue) issueOf.set(f.id, issue);
      }
      return issueOf;
    }

    // Files the card once and answers its issue; a card already sent answers that one.
    api.post<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
      const config = await jiraConfig(pool, getSecret, req.log);
      if (!config) return reply.code(409).send({ error: 'jira_not_configured' });
      const id = CardId.safeParse(req.params.id);
      if (!id.success) return reply.code(404).send({ error: 'not_found' });
      if (!cards) return reply.code(502).send({ error: 'cards_unavailable' });
      const person = signedInPerson(req);
      const sent = async () =>
        (await pool.query<Issue>(`SELECT card_id, key, url, sent_by FROM jira.card_issues WHERE card_id = $1`, [id.data])).rows[0];
      // The card's "Sent to Jira" line, once: the press that claims noted_at writes it, and one
      // that could not gives the claim back, so the next press on the card writes it.
      const noted = async (issue: Issue) => {
        const claimed = await pool.query(`UPDATE jira.card_issues SET noted_at = now() WHERE card_id = $1 AND noted_at IS NULL`, [id.data]);
        if (!claimed.rowCount) return {};
        try {
          // As the member who sent it, whoever presses now.
          const by = issue.sent_by ?? person.id;
          return { revision: (await cards.note(id.data, { lead: 'Sent to Jira', text: `as ${issue.key}`, by_member_id: by, request_id: `jira:${issue.key}` })).revision };
        } catch (err) {
          await pool.query(`UPDATE jira.card_issues SET noted_at = NULL WHERE card_id = $1`, [id.data]);
          throw err;
        }
      };
      try {
        const already = await sent();
        if (already) return { key: already.key, url: already.url, ...(await noted(already)) };
        // A card merged into this one was sent: that issue is this card's, and none is filed.
        const merged = (await issuesOf([id.data], person.id)).get(id.data);
        if (merged) return merged;
        const content = await cards.content(id.data, person.id);
        const member = await memberById(pool, person.id);
        const issue = await createJiraIssue(config, content, member?.display_name || member?.email || 'someone', fetch);
        req.log.info({ event: 'jira.created', member_id: person.id, card_id: id.data, jira_key: issue.key }, 'card sent to Jira');
        // One card, one issue: a press that lost a race answers the first issue, and its own
        // stays in Jira unlinked (as before the plugin).
        await pool.query(
          `INSERT INTO jira.card_issues (card_id, key, url, sent_by) VALUES ($1, $2, $3, $4) ON CONFLICT (card_id) DO NOTHING`,
          [id.data, issue.key, issue.url, person.id],
        );
        const kept = (await sent())!;
        return { key: kept.key, url: kept.url, ...(await noted(kept)) };
      } catch (err) {
        if (err instanceof JiraFailed) {
          req.log.warn({ event: 'jira.failed', card_id: id.data, status: err.status }, 'Jira refused the issue');
          return reply.code(502).send({ error: 'jira_failed', status: err.status });
        }
        if (!(err instanceof CardsUnavailable)) throw err;
        req.log.warn({ event: 'cards.unavailable', card_id: id.data }, 'card unavailable for Jira');
        return reply.code(502).send({ error: 'cards_unavailable' });
      }
    });
  },
};
