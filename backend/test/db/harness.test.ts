import { describe, expect, it } from 'vitest';
import { testDbUrl } from './harness.ts';

describe('test database setting (QOR-4568)', () => {
  it('skips (undefined) on a machine without BWAT_TEST_DB_URL', () => {
    expect(testDbUrl({})).toBeUndefined();
    expect(testDbUrl({ BWAT_TEST_DB_URL: '' })).toBeUndefined();
    expect(testDbUrl({ CI: 'false' })).toBeUndefined();
  });

  it('refuses to skip in CI: a missing URL there is an error', () => {
    expect(() => testDbUrl({ CI: 'true' })).toThrow('BWAT_TEST_DB_URL must be set in CI');
    expect(() => testDbUrl({ CI: 'true', BWAT_TEST_DB_URL: '' })).toThrow('BWAT_TEST_DB_URL must be set in CI');
  });

  it('uses the URL when it is set', () => {
    const url = 'postgres://u:p@127.0.0.1:5432/postgres';
    expect(testDbUrl({ BWAT_TEST_DB_URL: url })).toBe(url);
    expect(testDbUrl({ CI: 'true', BWAT_TEST_DB_URL: url })).toBe(url);
  });
});
