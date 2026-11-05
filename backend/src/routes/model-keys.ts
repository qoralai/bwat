import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { isProvider, modelKeyEntry, PROVIDERS, secretName, type KeyChecker, type Provider } from '../model-keys.ts';
import { isObject } from '../http.ts';
import { asAdminWrite } from '../members.ts';
import { requireAdmin, requireOnboardedPerson, type AuthenticatePerson } from '../people-auth.ts';
import type { SecretStore } from '../secrets/store.ts';
import { answeredStoreError, changeSecret } from './secret-change.ts';

// A key is at most 512 characters: 4 KiB is room for it and its JSON, nothing more.
const BODY_LIMIT_BYTES = 4 * 1024;
// 8-512 printable ASCII, no whitespace: a pasted line break or stray space is caught here.
const KEY = /^[\x21-\x7E]{8,512}$/;

/** The route's provider, or null after answering 404. */
async function providerOf(req: FastifyRequest, reply: FastifyReply): Promise<Provider | null> {
  const { provider } = req.params as { provider: string };
  if (isProvider(provider)) return provider;
  await reply.code(404).send({ error: 'unknown_provider' });
  return null;
}

/**
 * The model keys (admin only, reading included). Write-only: a key goes in once and
 * comes back out only to the bots, on GET /bot/settings. These routes return status
 * only, and nothing they log or answer carries a key. A set or a removal is a change the
 * bots must pick up, so it bumps the settings version.
 */
export function modelKeyRoutes(
  app: FastifyInstance,
  { pool, authenticatePerson, secrets, checkKey }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson; secrets: SecretStore; checkKey: KeyChecker },
): void {
  /** One change to a key (`key` null removes it), under the settings lock with a version bump: see changeSecret. */
  const change = (reply: FastifyReply, actor: string, provider: Provider, key: string | null) =>
    changeSecret(reply, { pool, secrets }, { actor, name: secretName(provider), value: key, kind: 'model_key', target: `model_key:${provider}` });

  app.register(async (panel) => {
    panel.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    panel.get('/console/model-keys', async (req, reply) => {
      if (!(await requireAdmin(pool, req, reply))) return reply;
      return { keys: await Promise.all(PROVIDERS.map((p) => modelKeyEntry(secrets, p))) };
    });

    panel.put('/console/model-keys/:provider', { bodyLimit: BODY_LIMIT_BYTES }, async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      const provider = await providerOf(req, reply);
      if (!provider) return reply;
      const key = isObject(req.body) ? req.body.key : undefined;
      if (typeof key !== 'string' || !KEY.test(key)) return reply.code(400).send({ error: 'invalid_key' });

      if ((await change(reply, admin.id, provider, key)) === null) return reply;
      req.log.info({ event: 'model_key.set', provider }, 'model key set');
      return modelKeyEntry(secrets, provider);
    });

    panel.delete('/console/model-keys/:provider', { bodyLimit: BODY_LIMIT_BYTES }, async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      const provider = await providerOf(req, reply);
      if (!provider) return reply;
      const removed = await change(reply, admin.id, provider, null);
      if (removed === null) return reply;
      if (removed) {
        req.log.info({ event: 'model_key.removed', provider }, 'model key removed');
      }
      return modelKeyEntry(secrets, provider);
    });

    // Checks the key in use (stored, or the env fallback) with one read-only call to the
    // provider. The answer and the audit say only valid, invalid or unreachable.
    panel.post('/console/model-keys/:provider/validate', { bodyLimit: BODY_LIMIT_BYTES }, async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      const provider = await providerOf(req, reply);
      if (!provider) return reply;
      let key: string | null;
      try {
        key = await secrets.get(secretName(provider));
      } catch (err) {
        if (await answeredStoreError(reply, err)) return reply;
        throw err;
      }
      if (key === null) return reply.code(409).send({ error: 'not_set' });
      const result = await checkKey(provider, key);
      // The answer is given only to an actor still an admin once the audit is written.
      const audited = await asAdminWrite(pool, admin.id, (client) =>
        audit(client, { actor: admin.id, action: 'model_key.validated', target: `model_key:${provider}`, before: null, after: { result } }));
      if (audited === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      req.log.info({ event: 'model_key.validated', provider, result }, 'model key validated');
      return { result };
    });
  });
}
