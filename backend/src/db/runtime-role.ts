import type pg from 'pg';
import { APP_SCHEMA } from './pool.ts';

/** The role the app logs in as (backend/README.md). */
export const RUNTIME_ROLE = 'bwat_runtime';

/**
 * The server runs this against the role it actually logged in as, before it listens:
 * the app connects as the runtime role, never as the owner. Fails if the role is a
 * superuser, can bypass row-level security, owns (directly or through membership)
 * the database or the app schema, or is not RUNTIME_ROLE at all. pg_has_role counts a
 * role as a member of itself.
 */
export async function assertRuntimeRole(db: pg.ClientBase | pg.Pool): Promise<void> {
  const { rows } = await db.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>(
    `SELECT r.rolname AS role, r.rolsuper, r.rolbypassrls,
            pg_has_role(current_user, d.datdba, 'MEMBER')
              OR EXISTS (SELECT 1 FROM pg_namespace n
                          WHERE n.nspname = $1 AND pg_has_role(current_user, n.nspowner, 'MEMBER')) AS owns
       FROM pg_roles r, pg_database d
      WHERE r.rolname = current_user AND d.datname = current_database()`,
    [APP_SCHEMA],
  );
  const r = rows[0]!;
  const problems = [
    r.rolsuper && 'is a superuser',
    r.rolbypassrls && 'has BYPASSRLS',
    r.owns && 'owns the database or the app schema',
    r.role !== RUNTIME_ROLE && `is not ${RUNTIME_ROLE}`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`database role check failed: ${r.role} ${problems.join(', ')}`);
}
