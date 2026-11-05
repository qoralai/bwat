import type pg from 'pg';

/**
 * One audit row in bwat.audit (identity's append-only table, migration 0004): who changed
 * what, written in the same transaction as the change. A member or a meeting is named by
 * target_type (`member`, `meeting`) and target_id. A settings, dictionary or model-key
 * target is not a row with an id, so it is named in target_type alone
 * (`settings:<section>`, `dictionary`, `model_key:<provider>`, `secrets`) and target_id
 * is null. By ids, roles and which fields changed only: never a name, an email, a title,
 * transcript text, a secret value or a dictionary's words.
 */
interface AuditEntry {
  /** The signed-in member's id, or null for an operator script or a first sign-in. */
  actor: string | null;
  action: string;
  target: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}

export async function audit(client: pg.ClientBase, entry: AuditEntry): Promise<void> {
  // JSON text cast to jsonb: pg would send a JS null as SQL NULL and an array as a Postgres array.
  const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
  await client.query(
    `INSERT INTO audit (actor_id, action, target_type, target_id, before, after) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [entry.actor, entry.action, entry.target, entry.targetId ?? null, json(entry.before), json(entry.after)],
  );
}
