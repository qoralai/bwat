import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { isObject, isRevision } from '../http.ts';
import { asAdminWrite, isAdmin, memberById } from '../members.ts';
import { requireAdmin, requireOnboardedPerson, signedInPerson, type AuthenticatePerson } from '../people-auth.ts';
import { pluginSettings, type BwatPlugin } from '../plugins/plugin.ts';
import { switchKey, type PluginSwitches } from '../plugins/switches.ts';
import { storedSettings, writeChanges, writeSetting, type SettingChanges } from '../settings/store.ts';

/**
 * Which plugins run, and the panel's switches for them. `plugins` is every plugin bwat ships;
 * `env` is the operator's, read for what a plugin `needs`.
 */
export function pluginRoutes(
  app: FastifyInstance,
  { pool, authenticatePerson, plugins, switches, env }: {
    pool: pg.Pool;
    authenticatePerson: AuthenticatePerson;
    plugins: readonly BwatPlugin[];
    switches: PluginSwitches;
    env: NodeJS.ProcessEnv;
  },
): void {
  /** What a plugin still needs from the operator, or null when it has it. */
  const missing = ({ needs }: BwatPlugin) => (needs && !env[needs.env]?.trim() ? needs : null);

  // QOR-4806: which plugins are on, for the pairing page's wording and the web server's
  // /embed (no sign-in: names only).
  app.get('/plugins', async () => {
    const on = await switches.on();
    return {
      plugins: plugins.filter((p) => on.has(p.name)).map(({ name, displayName, embeds }) => ({ name, display_name: displayName, embeds: embeds === true })),
    };
  });

  const view = async (canManage: boolean) => {
    const on = await switches.on();
    return {
      canManage,
      plugins: plugins.map((p) => ({ name: p.name, display_name: p.displayName, description: p.description, on: on.has(p.name), needs: missing(p) })),
    };
  };
  const named = (req: { params: unknown }) => plugins.find((p) => p.name === (req.params as { name: string }).name);

  app.register(async (panel) => {
    panel.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    // Every shipped plugin, on or off; any signed-in person may read, only an admin may switch.
    panel.get('/console/plugins', async (req) => {
      const [member, read] = await Promise.all([memberById(pool, signedInPerson(req).id), view(false)]);
      return { ...read, canManage: member !== null && isAdmin(member) };
    });

    // What a plugin holds, asked only as an admin turns it off: {holds: "3 lists ..." | null}.
    panel.get('/console/plugins/:name/holds', async (req, reply) => {
      if (!(await requireAdmin(pool, req, reply))) return reply;
      const plugin = named(req);
      if (!plugin) return reply.code(404).send({ error: 'unknown_plugin' });
      return { holds: plugin.holds ? await plugin.holds(pool) : null };
    });

    // QOR-4978: a plugin's own settings, as its setup card reads them: {canManage, settings: {key: {value, revision}}}.
    const settingsView = async (db: pg.Pool | pg.ClientBase, plugin: BwatPlugin, canManage: boolean) => {
      const defs = pluginSettings(plugin);
      const stored = await storedSettings(db, defs.map((d) => d.key));
      const view = ({ key }: { key: string }) => [key, { value: stored.get(key)?.value ?? null, revision: stored.get(key)?.revision ?? null }];
      return { canManage, settings: Object.fromEntries(defs.map(view)) };
    };
    panel.get('/console/plugins/:name/settings', async (req, reply) => {
      const plugin = named(req);
      if (!plugin) return reply.code(404).send({ error: 'unknown_plugin' });
      const member = await memberById(pool, signedInPerson(req).id);
      return settingsView(pool, plugin, member !== null && isAdmin(member));
    });

    // PUT /console/plugins/:name/settings {changes: {key: {value, expectedRevision}}}: all of it or
    // none, as a core settings save: every key's revision is checked first, under the settings
    // lock (a key with no row has nothing else to lock). No settings version bump: no bot is served them.
    panel.put('/console/plugins/:name/settings', async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      const plugin = named(req);
      if (!plugin) return reply.code(404).send({ error: 'unknown_plugin' });
      const defs = new Map(pluginSettings(plugin).map((d) => [d.key, d]));
      const body = isObject(req.body) ? req.body.changes : undefined;
      if (!isObject(body) || Object.keys(body).length === 0) return reply.code(400).send({ error: 'invalid_settings', problems: ['Nothing to save.'] });
      const problems: string[] = [];
      const changes: SettingChanges = new Map();
      for (const [key, entry] of Object.entries(body)) {
        const def = defs.get(key);
        if (!def) problems.push(`"${key}" is not a setting of ${plugin.displayName}.`);
        else if (!isObject(entry) || !('value' in entry) || !isRevision(entry.expectedRevision)) problems.push(`"${key}" needs a value and the revision it was read at.`);
        else {
          const problem = entry.value === null ? null : def.check(entry.value);
          if (problem) problems.push(problem);
          else changes.set(key, { value: entry.value === null || !def.normalise ? entry.value : def.normalise(entry.value), expectedRevision: entry.expectedRevision });
        }
      }
      if (problems.length > 0) return reply.code(400).send({ error: 'invalid_settings', problems });
      const audited = (key: string, value: unknown) => (value === null || defs.get(key)!.auditValue ? value : 'set');
      const result = await asAdminWrite(pool, admin.id, async (client) => {
        const saved = await writeChanges(client, admin.id, changes);
        if ('stale' in saved) return saved;
        if (saved.written.size > 0) {
          const side = (which: 'before' | 'after') =>
            Object.fromEntries([...saved.written].map(([key, w]) => [key, { value: audited(key, w[which].value), revision: w[which].revision }]));
          await audit(client, { actor: admin.id, action: 'settings.updated', target: `settings:${plugin.name}`, before: side('before'), after: side('after') });
        }
        req.log.info({ event: 'plugin.settings_saved', plugin: plugin.name, changed: saved.written.size }, 'plugin settings saved');
        return { saved: await settingsView(client, plugin, true) };
      });
      if (result === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      if ('stale' in result) return reply.code(409).send({ error: 'stale', currentRevisions: result.stale });
      return result.saved;
    });

    // PUT /console/plugins/:name {on}: takes effect at once in this process, within seconds in another.
    panel.put('/console/plugins/:name', async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      const plugin = named(req);
      if (!plugin) return reply.code(404).send({ error: 'unknown_plugin' });
      const on = isObject(req.body) ? req.body.on : undefined;
      if (typeof on !== 'boolean') return reply.code(400).send({ error: 'bad_request' });
      if (on && missing(plugin)) return reply.code(409).send({ error: 'needs_setup' });
      const done = await asAdminWrite(pool, admin.id, async (client) => {
        // No lockSettings or settings version bump: no bot or card service is served a plugin switch.
        await writeSetting(client, admin.id, switchKey(plugin.name), on);
        await audit(client, { actor: admin.id, action: on ? 'plugin.switched_on' : 'plugin.switched_off', target: `plugin:${plugin.name}` });
      });
      if (done === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      switches.invalidate();
      req.log.info({ event: 'plugin.switched', plugin: plugin.name, on }, 'plugin switched');
      return view(true);
    });
  });
}
