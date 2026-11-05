import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The web half of the repository's plugin-section guard (backend/test/guards/independence.test.ts),
 * so a change that touches only web/ runs it too: a plugin's name appears in web/ only in its own
 * section (web/plugins/<name>/, web/test/plugins/<name>/) and in the web registry, and the registry
 * imports exactly the folders under web/plugins/. A name is any plugin's, backend or web side.
 */
const WEB = join(import.meta.dirname, '..');
const REPO = join(WEB, '..');
const REGISTRY = 'web/server/src/plugins/index.ts';
// The panel's registry of the plugins' setup cards (admin/src/pluginSetup.ts) names them too.
const ADMIN_REGISTRY = 'web/admin/src/pluginSetup.ts';
// It names ticket keys (QOR-####), not a plugin.
const EXEMPT = [REGISTRY, ADMIN_REGISTRY, 'web/test/no-other-names.test.ts'];
const dirsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()) : []);
const WEB_PLUGINS = dirsIn(join(WEB, 'plugins'));
const NAMES = [...new Set([...WEB_PLUGINS, ...dirsIn(join(REPO, 'backend', 'src', 'plugins'))])];

// Every file under web/ git holds or would add (new files included), whatever its type.
const webFiles = () =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'web'], { cwd: REPO, encoding: 'utf8' })
    .split('\0').filter((f) => f && existsSync(join(REPO, f)));

describe('web plugins stay in their plugin section', () => {
  it('finds the plugins', () => {
    expect(WEB_PLUGINS.length).toBeGreaterThan(0);
  });

  it('names no plugin in web/ outside its section and the registry', () => {
    const offenders: string[] = [];
    for (const file of webFiles()) {
      if (EXEMPT.includes(file)) continue;
      const text = readFileSync(join(REPO, file), 'utf8');
      for (const name of NAMES) {
        if ([`web/plugins/${name}/`, `web/test/plugins/${name}/`].some((p) => file.startsWith(p))) continue;
        if (new RegExp(name, 'i').test(text)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the registry imports exactly the folders under web/plugins/', () => {
    const text = readFileSync(join(REPO, REGISTRY), 'utf8');
    const imported = [...text.matchAll(/^import .* from '(?:\.\.\/)+plugins\/([^/']+)\/index\.ts';$/gm)].map((m) => m[1]!).sort();
    expect(imported).toEqual([...WEB_PLUGINS].sort());
  });
});
