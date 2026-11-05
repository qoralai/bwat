import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REASONS, reasonOf } from './reasons';

/* Every reason code a person can meet on the Overview reads as a sentence. The codes are read
   from the code that sets them, so a new one fails here until it has its words. Claim states
   (done, abandoned, ...) and a held claim's verdicts (drained, running, lapsed) share the SQL
   with the reasons and are not reasons. */

const root = join(import.meta.dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!);
const NOT_REASONS = new Set(['pending', 'claimed', 'attending', 'done', 'abandoned', 'drained', 'running', 'lapsed']);

function codes(): Record<string, string[]> {
  const claims = read('backend/src/claims.ts');
  const lifecycle = read('bot/bwat_bot/lifecycle.py');
  const bridge = read('bot/bwat_bot/zoom_bridge.py');
  const transcription = read('bot/bwat_bot/transcription.py');
  const retry = /RETRY_REASONS[^=]*= new Set\(\[([^\]]*)\]/.exec(claims)![1]!;
  return {
    'backend/src/claims.ts': [
      ...all(retry, /'([a-z_]+)'/g),
      ...all(claims, /(?:THEN|ELSE) '([a-z_]+)'/g),
      ...all(claims, /endClaim\(`'[a-z]+'`, `'([a-z_]+)'`\)/g),
    ].filter((c) => !NOT_REASONS.has(c)),
    'bot/bwat_bot/lifecycle.py': [
      ...all(lifecycle, /_release\(claim, "([a-z_]+)"/g),
      ...all(lifecycle, /_report_ready\(False, "([a-z_]+)"\)/g),
      ...all(/WAITS = \{([^}]*)\}/.exec(lifecycle)![1]!, /"([a-z_]+)"/g),
      ...all(/ENDINGS = \{([^}]*)\}/.exec(lifecycle)![1]!, /"([a-z_]+)"/g),
    ],
    'bot/bwat_bot/zoom_bridge.py': [...all(bridge, /\d+: "([a-z_]+)"/g), ...all(bridge, /(?:Failed|Left)\("([a-z_]+)"\)/g), ...all(bridge, /FAIL_REASONS\.get\(.*, "([a-z_]+)"\)\)/g)],
    'bot/bwat_bot/transcription.py': all(transcription, /OUT_OF_CREDIT = "([a-z_]+)"/g),
  };
}

describe('reason codes in words', () => {
  it('finds the codes it checks in each file', () => {
    for (const [file, found] of Object.entries(codes())) expect(found.length, file).toBeGreaterThan(0);
  });

  it('has a sentence for every code the backend and the bot set', () => {
    for (const [file, found] of Object.entries(codes())) {
      for (const code of found) expect(REASONS[code], `${code} (${file})`).toBeDefined();
    }
  });

  it('says what happened as a sentence, and never shows an unknown code raw', () => {
    for (const code of Object.keys(REASONS)) {
      const { say, fix } = reasonOf(code);
      expect(say, code).toMatch(/^[A-Zb].*\.$/);
      // A number bwat could say is an install's setting, read below, never a constant.
      expect(say + (fix ?? ''), code).not.toMatch(/3 times|within 5 minutes/);
      if (fix) expect(fix, code).toMatch(/\.$/);
      expect(say + (fix ?? ''), code).not.toContain('_');
    }
    expect(reasonOf('something_new')).toEqual({ say: 'Something went wrong.', fix: 'Send bwat again. If it keeps happening, check the bot is running.' });
  });

  it("says each wait as this install sets it, and its defaults without a read", () => {
    const entry = (value: unknown) => ({ value, default: null, revision: 1, updatedAt: null });
    const read = { settingsVersion: 1, canManage: true, settings: { waiting_room_min: entry(30), wait_for_start_min: entry(0), idle_leave_min: entry(1) } };
    expect(reasonOf('waiting_room_timeout', read).say).toBe("The host didn't let bwat in from the waiting room within 30 minutes.");
    expect(reasonOf('waiting_for_host_timeout', read).say).toBe("The meeting didn't start while bwat waited.");
    expect(reasonOf('idle', read).say).toBe('Nobody spoke for 1 minute, so bwat left.');
    expect(reasonOf('waiting_room_timeout').say).toBe("The host didn't let bwat in from the waiting room within 15 minutes.");
    expect(reasonOf('waiting_for_host_timeout').say).toBe("The meeting didn't start within 10 minutes of bwat arriving.");
    expect(reasonOf('idle').say).toBe('Nobody spoke for 5 minutes, so bwat left.');
  });
});
