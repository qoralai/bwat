import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { asAdminWrite } from '../members.ts';
import { knownStatus, SecretStoreNotConfigured, SecretUnavailable, SecretUnreadable, type SecretStore } from '../secrets/store.ts';
import { bumpSettingsVersion, lockSettings } from '../settings/store.ts';

/** Thrown inside a change's transaction to roll it back when nothing was removed. */
class NothingRemoved extends Error {}

/** Answers 503 for a store that has no key to write with, cannot be reached, or cannot read what it holds; false for any other error. */
export async function answeredStoreError(reply: FastifyReply, err: unknown): Promise<boolean> {
  if (!(err instanceof SecretStoreNotConfigured || err instanceof SecretUnavailable || err instanceof SecretUnreadable)) return false;
  await reply.code(503).send({ error: err.code });
  return true;
}

/**
 * One change to a stored secret (`value` null removes it), in one transaction: the actor's
 * role first (asAdminWrite: 403 and nothing written when they are no longer an admin), then
 * the audit and the store write last. A set reads whether a value was stored (the audit's
 * `before`); a removal does not read first: it is audited, and when the delete finds nothing
 * stored, the audit (and any bump) rolls back.
 * A model key is a change the bots must pick up: it runs under the settings lock and bumps
 * the settings version before the audit.
 *
 * The local store writes in the transaction, so all of it commits or rolls back together.
 * The aws store cannot roll back, so it is written last: a failed bump or audit leaves
 * Secrets Manager untouched, and a failed write rolls the bump and the audit back. The
 * window left is a COMMIT that fails after the aws write: the value changed, with no audit
 * and no bump. The bump commits only after the new value is readable, so a bot never sees
 * the new version with the old value.
 *
 * True when changed; false when there was nothing to remove (no bump, no audit); null after
 * answering 403, or 503 when the store has no key to write with or cannot be reached.
 */
export async function changeSecret(
  reply: FastifyReply,
  { pool, secrets }: { pool: pg.Pool; secrets: SecretStore },
  { actor, name, value, kind, target }: { actor: string; name: string; value: string | null; kind: 'model_key' | 'secret'; target: string },
): Promise<boolean | null> {
  const bump = kind === 'model_key';
  try {
    const changed = await asAdminWrite(pool, actor, async (client) => {
      if (bump) await lockSettings(client);
      const wasSet = value === null || (await knownStatus(secrets, name, client)).source === 'store';
      if (bump) await bumpSettingsVersion(client);
      const action = value === null ? `${kind}.removed` : `${kind}.set`;
      await audit(client, { actor, action, target, before: { set: wasSet }, after: { set: value !== null } });
      if (value !== null) await secrets.put(name, value, client);
      // Nothing was stored: roll the bump and the audit back.
      else if (!(await secrets.delete(name, client))) throw new NothingRemoved();
      return true;
    });
    if (changed === 'forbidden') return (await reply.code(403).send({ error: 'forbidden' }), null);
    return changed;
  } catch (err) {
    if (err instanceof NothingRemoved) return false;
    if (await answeredStoreError(reply, err)) return null;
    throw err;
  }
}
