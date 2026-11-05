import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { AutoJoinReadiness } from '../auto-join-readiness.ts';
import { AUTO_JOIN_KEY, AUTO_JOIN_REQUIRE_HOST_KEY, switchIsOn, type AutoJoinSwitch } from '../auto-join-switch.ts';
import { audit } from '../audit.ts';
import { isObject, isRevision } from '../http.ts';
import { asAdminWrite, isAdmin, memberById, type Member } from '../members.ts';
import { requireAdmin, requireOnboardedPerson, signedInPerson, type AuthenticatePerson } from '../people-auth.ts';
import { normalised, SECTIONS, settingDef, validateSection, type SettingsSection } from '../settings/catalogue.ts';
import { bumpSettingsVersion, readSettings, readSettingsVersion, writeChanges, type SettingChanges } from '../settings/store.ts';

/**
 * The body's changes, or the problems with it: unknown keys, keys of another section, bad values, bad shapes.
 * With no section, each key is checked against its own (an unknown key against any, which names it as unknown).
 */
function parseChanges(section: SettingsSection | null, body: unknown): { changes: SettingChanges } | { problems: string[] } {
  const changes = isObject(body) ? body.changes : undefined;
  if (!isObject(changes) || Object.keys(changes).length === 0) return { problems: ['Nothing to save.'] };
  const shapeProblems: string[] = [];
  const values: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(changes)) {
    if (isObject(entry) && 'value' in entry && isRevision(entry.expectedRevision)) values[key] = entry.value;
    else shapeProblems.push(`"${key}" needs a value and the revision it was read at.`);
  }
  const problems = [
    ...(section
      ? validateSection(section, values)
      : Object.entries(values).flatMap(([key, value]) => validateSection(settingDef(key)?.section ?? SECTIONS[0], { [key]: value }))),
    ...shapeProblems,
  ];
  if (problems.length > 0) return { problems };
  return {
    changes: new Map(
      Object.entries(changes as Record<string, { value: unknown; expectedRevision: number | null }>).map(([key, entry]) => [
        key,
        { value: normalised(key, entry.value), expectedRevision: entry.expectedRevision },
      ]),
    ),
  };
}

/** The company's settings for the panel. Any signed-in person may read; only an admin may save. */
export function settingsRoutes(
  app: FastifyInstance,
  { pool, authenticatePerson, autoJoinSwitch, autoJoinReadiness }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson; autoJoinSwitch: AutoJoinSwitch; autoJoinReadiness: AutoJoinReadiness },
): void {
  const view = async (db: pg.Pool | pg.ClientBase, member: Member | null) => ({
    settingsVersion: await readSettingsVersion(db),
    canManage: member !== null && isAdmin(member),
    settings: await readSettings(db),
  });
  const status = async (storedValue: unknown) => {
    const [{ ready, problems, lastEventAt }, notices] = await Promise.all([autoJoinReadiness.check(), autoJoinReadiness.notices()]);
    const requested = switchIsOn(storedValue);
    return { ready, problems, notices, lastEventAt, requested, effective: requested && ready };
  };

  app.register(async (panel) => {
    panel.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    panel.get('/console/settings', async (req) => {
      const read = await view(pool, await memberById(pool, signedInPerson(req).id));
      return read.canManage ? { ...read, autoJoin: await status(read.settings[AUTO_JOIN_KEY]?.value) } : read;
    });

    // Saves one or more sections in one transaction. Every key's expectedRevision is checked
    // before anything is written; any mismatch refuses the whole save with the revisions now stored.
    const saveChanges = async (req: FastifyRequest, reply: FastifyReply, section: string | null) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      if (section !== null && !(SECTIONS as readonly string[]).includes(section)) return reply.code(404).send({ error: 'unknown_section' });
      const parsed = parseChanges(section as SettingsSection | null, req.body);
      if ('problems' in parsed) return reply.code(400).send({ error: 'invalid_settings', problems: parsed.problems });
      const { changes } = parsed;
      const keys = [...changes.keys()];

      // Network validation must not hold the settings transaction open. Off always saves.
      if (changes.has(AUTO_JOIN_KEY) && changes.get(AUTO_JOIN_KEY)!.value !== false) {
        const checked = await autoJoinReadiness.check();
        if (!checked.ready) return reply.code(400).send({ error: 'auto_join_not_ready', problems: checked.problems });
      }

      // The authority: the role read in the write, after any role change in flight has committed.
      const result = await asAdminWrite(pool, admin.id, async (client) => {
        const saved = await writeChanges(client, admin.id, changes);
        if ('stale' in saved) return saved;
        // An unchanged value was not written: no audit, no bump.
        const changed = [...saved.written.keys()];
        if (changed.length > 0) {
          // One audit row per section, as a save of that section alone writes.
          for (const target of SECTIONS.filter((s) => changed.some((key) => settingDef(key)!.section === s))) {
            const inSection = changed.filter((k) => settingDef(k)!.section === target);
            const side = (which: 'before' | 'after') =>
              Object.fromEntries(inSection.map((key) => {
                const w = saved.written.get(key)![which];
                return [key, { value: w.value, revision: w.revision }];
              }));
            await audit(client, { actor: admin.id, action: 'settings.updated', target: `settings:${target}`, before: side('before'), after: side('after') });
          }
          await bumpSettingsVersion(client);
        }
        req.log.info({ event: 'settings.saved', section: section ?? 'all', changed: changed.length }, 'settings saved');
        return { saved: await view(client, admin), changed };
      });
      if (result === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      if ('stale' in result) return reply.code(409).send({ error: 'stale', currentRevisions: result.stale });
      // Committed: auto-join sees a change to its switch at once, not when its cache runs out.
      if (result.changed.some((key) => key === AUTO_JOIN_KEY || key === AUTO_JOIN_REQUIRE_HOST_KEY)) autoJoinSwitch.invalidate();
      if (!keys.some((key) => settingDef(key)!.section === 'joining')) return result.saved;
      // A readiness refresh cannot turn a committed save into a reported failure.
      const autoJoin = await status(result.saved.settings[AUTO_JOIN_KEY]?.value).catch(() => ({
        requested: switchIsOn(result.saved.settings[AUTO_JOIN_KEY]?.value), ready: false, effective: false,
        problems: ['Settings saved, but setup could not be checked. Try Recheck setup shortly.'], lastEventAt: null,
      }));
      return { ...result.saved, autoJoin };
    };

    // Saves every changed key the body names, whatever its section: all of it or none.
    panel.put('/console/settings', (req, reply) => saveChanges(req, reply, null));

    panel.put('/console/settings/:section', (req, reply) => saveChanges(req, reply, (req.params as { section: string }).section));
  });
}
