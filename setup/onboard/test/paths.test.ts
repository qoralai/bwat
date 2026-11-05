import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadMaster } from '../flow.ts';
import { ROOT } from '../root.ts';

// Every script of setup/ that reads or spells out a path (setup/paths itself is the reader).
const scripts = readdirSync(join(ROOT, 'setup')).filter((f) => statSync(join(ROOT, 'setup', f)).isFile() && f !== 'paths').map((f) => `setup/${f}`);

describe('the scripts', () => {
  it('include every script that reads paths', () => {
    for (const script of ['setup/prep', 'setup/bwat', 'setup/zoom-secrets', 'setup/zoom-sdk']) assert.ok(scripts.includes(script), script);
  });

  it('spell out no path the master names', () => {
    const paths = [...loadMaster().paths.values()];
    assert.ok(paths.length > 0);
    for (const script of scripts) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      for (const { name, path } of paths) assert.ok(!text.includes(path), `${script} spells out ${name}: ${path}; use $(setup/paths ${name})`);
    }
  });

  it('read every path they use by a name the master defines', () => {
    const names = new Set(loadMaster().paths.keys());
    for (const script of scripts) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      for (const [, name] of text.matchAll(/paths ([a-z0-9-]+)\)/g)) assert.ok(names.has(name!), `${script} reads ${name}, which the master lacks`);
    }
  });

  // Lines that hold a ">" or a vendor host but no vendor click path, each with the reason it is allowed.
  const ALLOWED: [RegExp, string][] = [
  ];

  it('write no vendor click path or vendor host outside setup/paths, whatever its wording', () => {
    const master = loadMaster().paths;
    const hosts = new Set(['marketplace.zoom.us', 'console.cloud.google.com', 'openrouter.ai', 'zoom.us']);
    for (const { path } of master.values()) for (const [, host] of path.matchAll(/https?:\/\/([\w.-]+)/g)) hosts.add(host!);
    const files = readdirSync(join(ROOT, 'setup')).filter((f) => statSync(join(ROOT, 'setup', f)).isFile() && f !== 'paths');
    assert.ok(files.includes('prep') && files.includes('zoom-sdk'));
    const found: string[] = [];
    for (const file of files) {
      readFileSync(join(ROOT, 'setup', file), 'utf8').split('\n').forEach((line, i) => {
        const bare = line.replace(/\$\((?:setup\/paths|\$paths) [a-z0-9-]+\)/g, '§');
        if (ALLOWED.some(([re]) => re.test(line))) return;
        const where = `setup/${file}:${i + 1}: ${line.trim()}`;
        for (const host of hosts) if (new RegExp(`${host.replace(/\./g, '\\.')}/\\w`).test(bare)) found.push(`${where}\n  links ${host} below its front page`);
        if (/\b[A-Z][\w']* > [A-Za-z"]|\b\w+ > [A-Z]/.test(bare)) found.push(`${where}\n  looks like a click path`);
      });
    }
    assert.deepEqual(found, [], 'read these from setup/paths (a field\'s name may follow a path)');
  });
});
