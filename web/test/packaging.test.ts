import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The web plugins (plugins/<name>/) ship in the image: compiled with the server and their board
// scripts copied. Without them a plugin's surface fails closed, silently, so check the packaging.
const read = (name: string) => readFileSync(join(import.meta.dirname, '..', name), 'utf8');

describe('packaging the web plugins', () => {
  it('compiles them with the server and the tests', () => {
    expect(JSON.parse(read('tsconfig.build.json')).include).toContain('plugins');
    expect(JSON.parse(read('tsconfig.json')).include).toContain('plugins');
  });

  it('copies them into the build stage and the image', () => {
    const stages = read('Dockerfile').split(/^FROM /m).slice(1);
    expect(stages).toHaveLength(2);
    for (const stage of stages) expect(stage).toMatch(/^COPY plugins \.\/plugins$/m);
  });
});
