import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { withTransaction } from '../db/pool.ts';
import { isObject, isRevision } from '../http.ts';
import { requireOnboardedPerson, signedInPerson, type AuthenticatePerson } from '../people-auth.ts';
import { problemsWith, readDictionary, saveDictionary, type DictionaryView } from '../settings/dictionary.ts';
import { bumpSettingsVersion, lockSettings } from '../settings/store.ts';

/** The bundled dictionary is a few KB, so this is room to grow, not a working limit. */
const PAYLOAD_MAX_BYTES = 256 * 1024;
// Bounds what is parsed; the payload cap above is measured as stored, so it is checked
// in the handler too. Either way the answer is 413 too_large (the server's error handler).
const BODY_LIMIT_BYTES = 300 * 1024;

/** What an audit row records of a dictionary: never its words. */
const audited = (d: DictionaryView) => ({ state: d.state, revision: d.revision, version: d.version });

/**
 * The corrections dictionary. Any signed-in person may read and save it: it is shared
 * working material, not an admin setting. A save is conditional on the revision read.
 */
export function correctionsRoutes(
  app: FastifyInstance,
  { pool, authenticatePerson }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson },
): void {
  app.register(async (panel) => {
    panel.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    panel.get('/console/corrections', async () => ({ dictionary: await readDictionary(pool) }));

    panel.put('/console/corrections', { bodyLimit: BODY_LIMIT_BYTES }, async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      const { expectedRevision, payload } = body;
      if (!isRevision(expectedRevision)) return reply.code(400).send({ error: 'invalid_revision' });
      // Measured as stored: the serialised JSON, in bytes.
      if (Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8') > PAYLOAD_MAX_BYTES) return reply.code(413).send({ error: 'too_large' });
      if (payload !== null) {
        const problems = problemsWith(payload);
        if (problems.length > 0) return reply.code(400).send({ error: 'invalid_dictionary', problems });
      }

      const person = signedInPerson(req);
      const result = await withTransaction(pool, async (client) => {
        // The dictionary is part of what /bot/settings serves under settingsVersion, so a
        // save bumps it, under the same lock as every other change the bots pick up.
        await lockSettings(client);
        const saved = await saveDictionary(client, person.id, expectedRevision, payload as Record<string, unknown> | null, new Date());
        if ('saved' in saved) {
          await bumpSettingsVersion(client);
          await audit(client, { actor: person.id, action: 'dictionary.updated', target: 'dictionary', before: saved.before.revision === null ? null : audited(saved.before), after: audited(saved.saved) });
        }
        return saved;
      });
      if ('stale' in result) return reply.code(409).send({ error: 'stale', currentRevision: result.currentRevision });
      req.log.info({ event: 'dictionary.saved', revision: result.saved.revision, state: result.saved.state }, 'dictionary saved');
      return { dictionary: result.saved };
    });
  });
}
