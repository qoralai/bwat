import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { platformTags } from '../platform.ts';

describe('platformTags', () => {
  it('names macOS, Apple silicon, Windows, WSL and Linux', () => {
    assert.deepEqual(platformTags('darwin', 'arm64', ''), ['mac', 'apple-silicon']);
    assert.deepEqual(platformTags('darwin', 'x64', ''), ['mac']);
    assert.deepEqual(platformTags('win32', 'x64', ''), ['windows']);
    assert.deepEqual(platformTags('linux', 'x64', 'Linux version 5.15.153.1-microsoft-standard-WSL2'), ['windows', 'wsl']);
    assert.deepEqual(platformTags('linux', 'x64', 'Linux version 6.8.0-45-generic'), ['linux']);
  });
});
