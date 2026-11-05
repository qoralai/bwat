import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { OCCURRENCE_STATES } from '../src/meetings.ts';
import { SEGMENT_SOURCES } from '../src/routes/meetings.ts';
import { PERSON, resetAllocationsBeforeEach, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting, meetingIdOf, pushTranscript, segment } from './meetings.ts';

/**
 * backend/README.md documents the meeting responses as the plugin's contract (D135/D144).
 * The documented shapes must be the shapes the routes answer, key for key.
 */

// A Windows checkout (core.autocrlf) gives the README CRLF line endings; the parsers below expect LF.
const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');

/** The first ```json block after a heading that starts with `heading`. */
function documented(heading: string): Record<string, unknown> {
  const at = readme.indexOf(`### ${heading}`);
  if (at < 0) throw new Error(`README has no "### ${heading}" section`);
  const block = /```json\n([\s\S]*?)```/.exec(readme.slice(at));
  if (!block) throw new Error(`README's "${heading}" section has no json block`);
  return JSON.parse(block[1]!);
}

/** Every key path in a value, arrays read through their first element. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.length ? keyPaths(value[0], `${prefix}[]`) : [`${prefix}[]`];
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...keyPaths(v, `${prefix}.${k}`)]);
}
const shape = (value: unknown) => [...new Set(keyPaths(value))].filter((p) => p !== '').sort();

describeDb('the documented meeting responses (D135/D144)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);
  let meetingId: string;

  beforeAll(async () => {
    const bot = await botInMeeting(t, 'readme-occ', '955666771');
    await pushTranscript(t, 'readme-occ', bot.bot_token, {
      epoch: 1,
      segments: [segment(0, { speaker_member_id: '00000000-0000-4000-8000-0000000000d1' }), segment(1, { source: 'chat' })],
    });
    meetingId = await meetingIdOf(t, 'readme-occ');
  });

  it('documents GET /meetings key for key', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/meetings', headers: PERSON });
    expect(shape(documented('History'))).toEqual(shape(res.json()));
  });

  it('documents GET /meetings/{meetingId}/transcript key for key', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/meetings/${meetingId}/transcript`, headers: PERSON });
    expect(shape(documented('Reading a transcript'))).toEqual(shape(res.json()));
  });

  it('documents every occurrence state, and complete as a boolean', () => {
    const read = documented('Reading a transcript') as { occurrence_state: string; complete: unknown };
    expect(read.occurrence_state.split(' | ')).toEqual([...OCCURRENCE_STATES]);
    expect(typeof read.complete).toBe('boolean');
  });

  it('documents paging the transcript to the end with cursor and next_cursor', () => {
    const at = readme.indexOf('### Reading a transcript');
    const section = readme.slice(at, readme.indexOf('\n## ', at));
    expect(section).toMatch(/Paging to the end/);
    expect(section).toMatch(/`next_cursor`/);
    expect(section).toMatch(/`cursor`/);
  });

  it('documents every push refusal and the admission rule, and the live refusal of a delete', () => {
    const at = readme.indexOf('### Pushing a transcript');
    const section = readme.slice(at, readme.indexOf('\n### ', at + 1));
    for (const code of ['stale_epoch', 'transcript_complete', 'meeting_deleted', 'stale_claim']) {
      expect(section).toContain(`409 {"error":"${code}"}`);
    }
    expect(section).not.toContain('"error":"meeting_ended"');
    for (const rule of ['lease_until', 'transcript epoch', 'locked until the', 'deleted_occurrences', 'drain_until']) {
      expect(section).toContain(rule);
    }
    const row = (route: string) => readme.split('\n').find((l) => l.startsWith(`| \`${route}\``));
    for (const code of ['stale_epoch', 'meeting_deleted', 'stale_claim']) {
      expect(row('POST /meetings/{occurrenceId}/transcript')).toContain(`\`409 ${code}\``);
    }
    expect(row('DELETE /meetings/{meetingId}')).toContain('`409 meeting_live`');
  });

  it('documents the deletion fence, the transcript lookup by occurrence and the drain bound', () => {
    const at = readme.indexOf('### Retention and deletes');
    const deletes = readme.slice(at, readme.indexOf('\n### ', at + 1));
    for (const rule of ['deleted_occurrences', 'meeting_deleted', 'skips a meeting a claim is open for', "meeting's lock"]) {
      expect(deletes).toContain(rule);
    }
    const read = readme.slice(readme.indexOf('### Reading a transcript'));
    expect(read).toContain('Zoom occurrence');
    expect(read).toContain('canonical UUID');
    expect(readme.split('\n').find((l) => l.startsWith('| `GET /meetings/{meetingId}/transcript`'))).toContain('occurrence');
    expect(readme).toContain('`drain_expired`');
  });

  it('documents every segment source, in the read and in the push', () => {
    const read = documented('Reading a transcript') as { segments: Array<{ source: string }> };
    expect(read.segments[0]!.source.split(' | ')).toEqual([...SEGMENT_SOURCES]);
    const push = documented('Pushing a transcript') as { segments: Array<{ source: string }> };
    expect(push.segments[0]!.source.split(' | ')).toEqual([...SEGMENT_SOURCES]);
  });
});
