import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { ALLOWED_DOMAINS_KEY, domainsInForce, savedDomains, type AllowedDomains } from '../google-signin.ts';
import { isObject, isRevision } from '../http.ts';
import { asAdminWrite, inAllowedDomain, ownersLockedOut } from '../members.ts';
import { requireAdmin, requireOnboardedPerson, type AuthenticatePerson } from '../people-auth.ts';
import { statusOf } from '../secrets/store.ts';
import { storedSettings, writeChanges } from '../settings/store.ts';
import type { DesktopClient } from './desktop-client.ts';

const MAX_DOMAINS = 50;
// A host name with at least one dot, lower case: what a Google account's hd looks like.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The list sent, trimmed, lower-cased and without repeats; null when it is not a list of domains. */
function domainsFrom(sent: unknown): string[] | null {
  if (!Array.isArray(sent) || sent.length === 0 || sent.length > MAX_DOMAINS) return null;
  if (!sent.every((d) => typeof d === 'string')) return null;
  const domains = [...new Set((sent as string[]).map((d) => d.trim().toLowerCase()))];
  return domains.every((d) => DOMAIN.test(d)) ? domains : null;
}

/**
 * GET /console/google-signin and PUT /console/google-signin/domains (QOR-5070): how people sign
 * in, owner or admin only, reading included. The client ids are shown; the plugin client's secret
 * only as set and its last 4 (the web client's is the sign-in server's, never the backend's).
 * An install may save its allowed email domains over BWAT_ALLOWED_DOMAINS; a local one (code sign-in,
 * no Google) may not.
 */
export function googleSignInRoutes(
  app: FastifyInstance,
  {
    pool,
    authenticatePerson,
    domains,
    googleClientIds,
    desktopClient,
    codeSignIn,
  }: {
    pool: pg.Pool;
    authenticatePerson: AuthenticatePerson;
    domains: AllowedDomains;
    googleClientIds: readonly string[];
    desktopClient: DesktopClient | undefined;
    codeSignIn: boolean;
  },
): void {
  // The secrets page's rule: set, and the last 4 of a long enough value.
  const { set, last4 } = statusOf(desktopClient?.secret ?? null, 'env');
  const view = async (db: pg.Pool | pg.ClientBase) => {
    const stored = (await storedSettings(db, [ALLOWED_DOMAINS_KEY])).get(ALLOWED_DOMAINS_KEY);
    const effective = domainsInForce(stored?.value, domains.env);
    return {
      signIn: codeSignIn ? 'code' : 'google',
      configured: !codeSignIn && googleClientIds.length > 0 && effective.length > 0,
      webClientIds: googleClientIds.filter((id) => id !== desktopClient?.id),
      pluginClient: { id: desktopClient?.id ?? null, secret: { set, last4 } },
      domains: {
        effective,
        env: domains.env,
        saved: savedDomains(stored?.value),
        revision: stored?.revision ?? null,
        updatedAt: stored?.updatedAt.toISOString() ?? null,
      },
    };
  };

  app.register(async (panel) => {
    panel.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    panel.get('/console/google-signin', async (req, reply) => {
      if (!(await requireAdmin(pool, req, reply))) return reply;
      return view(pool);
    });

    panel.put('/console/google-signin/domains', async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      if (codeSignIn) {
        return reply.code(409).send({ error: 'code_signin', message: 'This install signs in with its code, not Google. Nothing was saved.' });
      }
      const body = isObject(req.body) ? req.body : {};
      const expected = body.expectedRevision;
      const list = body.domains === null ? null : domainsFrom(body.domains);
      if ((body.domains !== null && list === null) || !isRevision(expected)) {
        return reply.code(400).send({
          error: 'invalid_domains',
          message: `List 1 to ${MAX_DOMAINS} email domains, such as example.com. Nothing was saved.`,
        });
      }

      const result = await asAdminWrite(pool, admin.id, async (client, actor) => {
        // The saving admin's own domain, read in the write: without it they could not sign in again.
        // Going back to the install's list must not lock them out either.
        if (!inAllowedDomain(actor.email, list ?? domains.env)) return { own: actor.email.slice(actor.email.lastIndexOf('@') + 1) };
        // Nor every owner: the install would have no one left who can manage it.
        const owners = await ownersLockedOut(client, list ?? domains.env);
        if (owners.length > 0) return { owners };
        // Under the settings lock and checked against the revision read, as every settings save.
        const saved = await writeChanges(client, actor.id, new Map([[ALLOWED_DOMAINS_KEY, { value: list, expectedRevision: expected }]]));
        if ('stale' in saved) return { stale: saved.stale[ALLOWED_DOMAINS_KEY] ?? null };
        const written = saved.written.get(ALLOWED_DOMAINS_KEY);
        if (written) {
          await audit(client, {
            actor: actor.id, action: 'google_signin.domains_updated', target: 'google_signin',
            before: { domains: savedDomains(written.before.value) }, after: { domains: list },
          });
        }
        return { saved: await view(client) };
      });
      if (result === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      if ('own' in result) {
        return reply.code(400).send({
          error: 'own_domain_missing',
          message: `Keep ${result.own} in the list: it is your own email's domain, and without it you could not sign in again. Nothing was saved.`,
        });
      }
      if ('owners' in result) {
        return reply.code(400).send({
          error: 'owner_locked_out',
          message: `Keep an owner’s email domain in the list, such as ${result.owners[0]}: without one, no owner could sign in. Nothing was saved.`,
        });
      }
      if ('stale' in result) return reply.code(409).send({ error: 'stale', currentRevision: result.stale });
      // Committed: sign-in here uses the new list at once; another process when its cache runs out.
      domains.invalidate();
      req.log.info({ event: 'google_signin.domains_saved', saved: result.saved.domains.saved !== null }, 'allowed email domains saved');
      return result.saved;
    });
  });
}
