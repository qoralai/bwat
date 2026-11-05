import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate, migrateAll } from '../../src/db/migrate.ts';
import { describeDb, useTestDb } from './harness.ts';

const DROP = '0048';

/** Whether the database still has a projects schema. */
const hasProjects = async (db: pg.ClientBase) =>
  (await db.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'projects'`)).rowCount === 1;

// Migration 0048 meets an install that ran the projects plugin: its schema and data go, with the
// cards' picks, the insights and projects switches and the plugin's ledger rows; the card stays.
describeDb('the projects and insights plugins out (migration 0048)', () => {
  describe('an install that had the projects plugin', () => {
    const db = useTestDb({ migrate: false });
    let owner: pg.Client;
    let earlier: string;
    let card: string;

    beforeAll(async () => {
      owner = await db.connect('owner');
      earlier = mkdtempSync(join(tmpdir(), `bwat-before-${DROP}-`));
      for (const name of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && n < DROP)) {
        copyFileSync(join(MIGRATIONS_DIR, name), join(earlier, name));
      }
      await migrate(owner, earlier);
      // The plugin's own migration, as it stood, recorded where the runner kept it.
      await owner.query(`
        CREATE SCHEMA projects;
        GRANT USAGE ON SCHEMA projects TO bwat_runtime;
        CREATE TABLE projects.projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
          description text NOT NULL DEFAULT '', archived_at timestamptz);
        CREATE TABLE projects.card_picks (card_id uuid PRIMARY KEY REFERENCES cards.cards (id) ON DELETE CASCADE,
          project_id uuid REFERENCES projects.projects (id));
        CREATE TABLE projects.meeting_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_number text NOT NULL,
          project_id uuid NOT NULL REFERENCES projects.projects (id), connected_at timestamptz NOT NULL DEFAULT now(),
          disconnected_at timestamptz);
        CREATE UNIQUE INDEX meeting_links_connected ON projects.meeting_links (meeting_number) WHERE disconnected_at IS NULL;
        INSERT INTO public.schema_migrations (name, checksum) VALUES ('plugins/projects/0001_projects.sql', 'gone');
      `);
      const { rows: meetings } = await owner.query(
        `INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES ('occ-projects-out', '666666666') RETURNING id`,
      );
      card = (
        await owner.query(
          `INSERT INTO cards.cards (meeting_id, kind, display_number, title)
           VALUES ($1, 'todo', nextval('cards.todo_numbers'), 'In a project') RETURNING id`,
          [meetings[0].id],
        )
      ).rows[0].id;
      const { rows: projects } = await owner.query(`INSERT INTO projects.projects (name) VALUES ('Launch') RETURNING id`);
      await owner.query(`INSERT INTO projects.card_picks (card_id, project_id) VALUES ($1, $2)`, [card, projects[0].id]);
      await owner.query(`INSERT INTO projects.meeting_links (meeting_number, project_id) VALUES ('666666666', $1)`, [projects[0].id]);
      await owner.query(
        `INSERT INTO bwat.settings (key, value, revision) VALUES ('plugin_projects', 'true', 1), ('plugin_insights', 'true', 1),
                ('plugin_kept', 'true', 1)`,
      );

      // With the plugin's folder gone, as every install upgrades.
      await migrateAll(owner);
    });

    afterAll(async () => {
      await owner?.end();
      rmSync(earlier, { recursive: true, force: true });
    });

    it('drops the projects schema and its data, and keeps the card', async () => {
      expect(await hasProjects(owner)).toBe(false);
      expect((await owner.query(`SELECT title FROM cards.cards WHERE id = $1`, [card])).rows).toEqual([{ title: 'In a project' }]);
    });

    it("drops the two plugins' switches, and keeps the others", async () => {
      const { rows } = await owner.query(`SELECT key FROM bwat.settings WHERE key LIKE 'plugin\\_%' ORDER BY key`);
      expect(rows).toEqual([{ key: 'plugin_kept' }]);
    });

    it("forgets the plugin's migrations, and keeps the others'", async () => {
      const { rows } = await owner.query(`SELECT name FROM public.schema_migrations WHERE name LIKE 'plugins/%'`);
      expect(rows).not.toEqual([]);
      expect(rows.filter((r) => r.name.startsWith('plugins/projects/'))).toEqual([]);
    });
  });

  describe('an install that never had it', () => {
    const db = useTestDb();
    let owner: pg.Client;

    beforeAll(async () => {
      owner = await db.connect('owner');
    });

    afterAll(async () => {
      await owner?.end();
    });

    it('applies with nothing to drop, and a second run has nothing pending', async () => {
      const { rows } = await owner.query(`SELECT name FROM public.schema_migrations WHERE name LIKE $1`, [`${DROP}\\_%`]);
      expect(rows).toHaveLength(1);
      expect(await hasProjects(owner)).toBe(false);
      expect(await migrateAll(owner)).toEqual([]);
    });
  });
});
