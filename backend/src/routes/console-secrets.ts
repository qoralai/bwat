import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isObject } from '../http.ts';
import { requireAdmin, requireOnboardedPerson, type AuthenticatePerson } from '../people-auth.ts';
import { TIER2_NAMES, type SecretStore } from '../secrets/store.ts';
import { changeSecret } from './secret-change.ts';

/**
 * The tier-2 secrets the panel sets here (D142, D173): Zoom's, and the plugins' own
 * (QOR-4978). Model keys have their own routes.
 */
const CORE_PANEL_SECRETS: readonly string[] = TIER2_NAMES.filter((name) => name.startsWith('zoom.'));

const BODY_LIMIT_BYTES = 4 * 1024;
// 1-512 printable ASCII, no whitespace: a pasted line break or stray space is caught here.
const VALUE = /^[\x21-\x7E]{1,512}$/;

/**
 * GET /console/secrets, PUT and DELETE /console/secrets/{name} (QOR-4668): the Zoom and
 * plugins' secrets, owner or admin only, reading included. Status only (set, source, last 4);
 * no answer and no log line carries a value. A change is audited in the transaction that
 * writes it; the store is written last, as for the model keys.
 */
export function consoleSecretRoutes(
  app: FastifyInstance,
  {
    pool,
    authenticatePerson,
    secrets,
    pluginSecrets = [],
  }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson; secrets: SecretStore; pluginSecrets?: readonly string[] },
): void {
  const PANEL_SECRETS = [...CORE_PANEL_SECRETS, ...pluginSecrets];
  const entry = async (name: string) => ({ name, ...(await secrets.status(name)) });

  app.register(async (panel) => {
    panel.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    panel.get('/console/secrets', async (req, reply) => {
      if (!(await requireAdmin(pool, req, reply))) return reply;
      return { secrets: await Promise.all(PANEL_SECRETS.map(entry)) };
    });

    const write = (method: 'put' | 'delete') =>
      panel[method]<{ Params: { name: string } }>('/console/secrets/:name', { bodyLimit: BODY_LIMIT_BYTES }, async (req, reply) => {
        const admin = await requireAdmin(pool, req, reply);
        if (!admin) return reply;
        const { name } = req.params;
        if (!PANEL_SECRETS.includes(name)) return reply.code(404).send({ error: 'unknown_secret' });
        let value: string | null = null;
        if (method === 'put') {
          const sent = isObject(req.body) ? req.body.value : undefined;
          if (typeof sent !== 'string' || !VALUE.test(sent)) return reply.code(400).send({ error: 'invalid_value' });
          value = sent;
        }
        const changed = await changeSecret(reply, { pool, secrets }, { actor: admin.id, name, value, kind: 'secret', target: `secret:${name}` });
        if (changed === null) return reply;
        req.log.info({ event: value === null ? 'secret.removed' : 'secret.set', name }, 'panel secret changed');
        return entry(name);
      });
    write('put');
    write('delete');
  });
}
