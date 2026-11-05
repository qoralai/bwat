import { beforeAll } from 'vitest';
import type { AuthenticatePerson } from '../src/people-auth.ts';
import { PERSON, useApp, type TestApp } from './app.ts';

/**
 * An owner, an admin and a member, told apart by the bearer they present. Each is a
 * member row (identity, QOR-4575), so its role is read from bwat.members like anyone's.
 */
export const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
export const ADMIN_ID = '00000000-0000-4000-8000-0000000000a2';
export const MEMBER_ID = '00000000-0000-4000-8000-0000000000a3';
export const OWNER = { authorization: 'Bearer test-owner' };
export const ADMIN = { authorization: 'Bearer test-admin' };
export const MEMBER = { authorization: 'Bearer test-member' };

const PERSONAS = [
  { id: OWNER_ID, role: 'owner', headers: OWNER },
  { id: ADMIN_ID, role: 'admin', headers: ADMIN },
  { id: MEMBER_ID, role: 'member', headers: MEMBER },
];

export const withRoles: AuthenticatePerson = async (req) => {
  const persona = PERSONAS.find((p) => p.headers.authorization === req.headers.authorization);
  return persona ? { id: persona.id } : null;
};

/** Lifecycle tests using PERSON exercise administrative recall with a real member. */
export function useAdminApp(options: Omit<NonNullable<Parameters<typeof useApp>[0]>, 'authenticatePerson'> = {}): TestApp {
  const t = useApp({ ...options, authenticatePerson: async req =>
    req.headers.authorization === PERSON.authorization ? { id: ADMIN_ID } : null });
  beforeAll(async () => {
    await t.pool.query(`INSERT INTO members (id, email, role, activated_at) VALUES ($1, 'admin@test.invalid', 'admin', now())`, [ADMIN_ID]);
  });
  return t;
}

/** useApp signed in through withRoles, with the three personas stored as activated members. */
export function useRoles(options: Omit<NonNullable<Parameters<typeof useApp>[0]>, 'authenticatePerson'> = {}): TestApp {
  const t = useApp({ authenticatePerson: withRoles, ...options });
  beforeAll(async () => {
    for (const { id, role } of PERSONAS) {
      await t.pool.query(`INSERT INTO members (id, email, role, activated_at) VALUES ($1, $2, $3, now())`, [
        id,
        `test-${role}@test.invalid`,
        role,
      ]);
    }
  });
  return t;
}
