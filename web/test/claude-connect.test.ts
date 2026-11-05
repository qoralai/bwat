import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The admin panel and setup each name the marketplace that lists the bwat plugin, and
// the docs give the same commands. Each part holds its own copy (the web image builds
// from web/ alone, setup is bash); this keeps them equal, so renaming it is one search.
const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const one = (text: string, pattern: RegExp) => {
  const found = text.match(pattern);
  expect(found, String(pattern)).not.toBeNull();
  return found![1];
};

const panel = read('web/admin/src/ConnectClaude.tsx');
const repo = one(panel, /MARKETPLACE_REPO = '([^']+)'/);
const name = one(panel, /MARKETPLACE = '([^']+)'/);

describe('the marketplace that lists the bwat plugin', () => {
  it('is the same in setup', () => {
    const setup = read('setup/plugin');
    expect([one(setup, /^marketplace_repo=(\S+)$/m), one(setup, /^marketplace=(\S+)$/m)]).toEqual([repo, name]);
  });

  // docs/setup-with-claude.md gives no plugin commands (the setup page runs ./bwat plugin), so
  // only the onboarding guide is checked.
  it.each(['docs/onboarding.md'])('is the one %s gives', (path) => {
    const doc = read(path);
    expect(doc).toContain(`claude plugin marketplace add ${repo}`);
    expect(doc).toContain(`claude plugin install bwat@${name} --config base_url=`);
  });
});
