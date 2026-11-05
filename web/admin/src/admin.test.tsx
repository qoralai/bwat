// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { makeQueryClient } from './api';

const TOKEN = 'id-token-for-ada';
const ADA = { id: '33333333-3333-4333-8333-333333333333', email: 'ada@example.com', display_name: 'Ada', role: 'owner' };

type Call = { method: string; path: string; authorization: string | null; body: unknown };
let calls: Call[];

/** The backend and the sign-in server, as one fake behind window.fetch. */
function backend({ role = 'owner', extra = {} as Record<string, [number, unknown]> } = {}): typeof fetch {
  const answers: Record<string, [number, unknown]> = {
    'GET /whoami': [200, { member: { ...ADA, role }, id_token: TOKEN }],
    'GET /v1/members': [200, { members: [ADA, { id: 'b0b', email: 'bob@example.com', display_name: null, role: 'member' }] }],
    'POST /v1/members': [201, { id: 'c1', email: 'cy@example.com', display_name: 'Cy', role: 'member' }],
    'GET /v1/console/settings': [200, {
      settingsVersion: 3,
      canManage: true,
      autoJoin: { requested: true, effective: false, ready: false, problems: ['Waiting for a verified meeting event.'], lastEventAt: null },
      settings: {
        auto_join_enabled: { value: null, default: true, revision: null, updatedAt: null, updatedBy: null },
        transcript_retention_days: { value: 30, default: 90, revision: 2, updatedAt: '2026-10-01T00:00:00Z', updatedBy: null },
      },
    }],
    'PUT /v1/console/settings/joining': [200, {
      settingsVersion: 4,
      canManage: true,
      autoJoin: { requested: false, effective: false, ready: false, problems: [], lastEventAt: null },
      settings: { auto_join_enabled: { value: false, default: true, revision: 1, updatedAt: '2026-10-03T00:00:00Z', updatedBy: ADA.id } },
    }],
    'GET /v1/console/settings/presence-image': [204, null],
    'GET /v1/console/model-keys': [200, { keys: [{ provider: 'openrouter', set: true, source: 'store', last4: 'wxyz' }] }],
    'GET /v1/console/secrets': [200, { secrets: [
      { name: 'zoom.webhook_secret', set: false, source: null, last4: null },
      { name: 'zoom.client_id', set: true, source: 'env', last4: null },
      { name: 'zoom.board_client_secret', set: true, source: 'store', last4: 'b0rd' },
      { name: 'zoom.s2s_client_secret', set: false, source: 'unavailable', last4: null },
    ] }],
    'PUT /v1/console/secrets/zoom.webhook_secret': [200, { name: 'zoom.webhook_secret', set: true, source: 'store', last4: 'abcd' }],
    'GET /v1/fleet': [200, { fleet: [
      { bot_id: 'bot-1', version: '0.1.0', ready: true, busy: true, stale: false, last_report_at: new Date().toISOString(), state: 'attending', hearing: true, error: null, claim_id: 'cl-1', meeting_number: '81234567890', occurrence_id: 'occ==', claim_state: 'attending', meeting_title: 'Weekly sync', meeting_started_at: '2026-10-06T16:00:00Z' },
      { bot_id: 'bot-2', version: '0.1.0', ready: false, busy: false, stale: false, last_report_at: new Date().toISOString(), state: 'idle', hearing: null, error: null, claim_id: null, meeting_number: null, occurrence_id: null, claim_state: null },
    ] }],
    'GET /v1/allocations': [200, { allocations: [
      { id: 'cl-9', meeting_number: '89990002222', claim_state: 'refused', refused_reason: 'allocations_exhausted', last_placement_failure: 'waiting_room_timeout', error: null, created_at: '2026-10-07T16:00:00Z', joined_at: null, ended_at: '2026-10-07T16:10:00Z' },
      { id: 'cl-8', meeting_number: '85550001111', claim_state: 'refused', refused_reason: 'recalled', error: null, created_at: '2026-10-04T16:00:00Z', joined_at: null, ended_at: '2026-10-04T16:01:00Z' },
    ] }],
    'GET /v1/meetings': [200, { next_cursor: null, meetings: [
      { id: 'm1', occurrence_id: 'occ==', title: 'Weekly sync', started_at: '2026-10-06T16:00:00Z', duration_seconds: 1800, attendee_count: 5, host_email: 'ada@example.com', bot_ids: ['bot-1'] },
      { id: 'm2', title: 'Nobody sent bwat', started_at: '2026-10-05T16:00:00Z', duration_seconds: 600, attendee_count: 2, host_email: null, bot_ids: [] },
    ] }],
    'PATCH /v1/allocations/cl-1': [200, { id: 'cl-1', claim_state: 'released' }],
    'POST /v1/allocations': [202, { id: 'cl-2', meeting_number: '89999999999', occurrence_id: null, claim_state: 'pending', refused_reason: null, error: null }],
    ...extra,
  };
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://bwat.test');
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      path: url.pathname,
      authorization: new Headers(init.headers).get('authorization'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const answer = answers[`${method} ${url.pathname}`];
    if (!answer) return new Response('{"error":"not_found"}', { status: 404 });
    if (answer[0] === 204) return new Response(null, { status: 204 });
    let body = answer[1];
    if (url.pathname === '/v1/meetings' && url.searchParams.get('with_bot') === '1' && answer[0] === 200) {
      const page = body as { meetings: { bot_ids: string[] }[] };
      body = { ...page, meetings: page.meetings.filter((m) => m.bot_ids.length > 0) };
    }
    return new Response(JSON.stringify(body), { status: answer[0], headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const writes = () => calls.filter((c) => c.method !== 'GET');

function show(hash: string) {
  window.location.hash = hash;
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = backend();
});
afterEach(() => cleanup());

describe('admin panel', () => {
  it('opens on the Overview, one of four tabs, and links Members, Settings and Plugins', async () => {
    show('#/');
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    expect(within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Overview', '#/'], ['Members', '#/members'], ['Settings', '#/settings'], ['Plugins', '#/plugins'],
    ]);
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByRole('heading', { name: 'Bots now' })).toBeTruthy();
  });

  it.each([
    ['#/status', '#/'],
    ['#/status?bot=bot-2', '#/'],
    ['#/history', '#/'],
    ['#/dictionary', '#/settings?place=cards'],
    ['#/?claude', '#/members?claude'],
  ])('moves the old link %s to %s', async (from, to) => {
    show(from);
    await screen.findByRole('navigation', { name: 'Sections' });
    expect(window.location.hash).toBe(to);
  });

  it('shows one line per bot from /v1/fleet, its ID and version in the tooltip, and Send POSTs /v1/allocations', async () => {
    show('#/');
    const bots = await screen.findByRole('list', { name: 'Bots' });
    await waitFor(() => expect(within(bots).getAllByRole('listitem')).toHaveLength(2));
    const [inMeeting, starting] = within(bots).getAllByRole('listitem');
    await waitFor(() => expect(inMeeting!.textContent).toContain('In 812 3456 7890 · hearing audio · Weekly sync'));
    expect(inMeeting!.title).toMatch(/^Bot bot-1 · version 0\.1\.0 · last heard /);
    // Not ready yet: starting, not ready.
    expect(starting!.textContent).toContain('Starting');
    expect(starting!.textContent).not.toContain('Ready');
    fireEvent.change(screen.getByLabelText('Zoom meeting link'), { target: { value: 'https://zoom.us/j/89999999999?pwd=abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send bwat' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'POST', path: '/v1/allocations', authorization: `Bearer ${TOKEN}`,
      body: { zoom_url: 'https://zoom.us/j/89999999999?pwd=abc' },
    });
  });

  it('says bwat is in a meeting, with its title and since when, once setup is done', async () => {
    globalThis.fetch = backend({ extra: { 'GET /v1/console/settings': [200, { settingsVersion: 1, canManage: true, settings: {},
      autoJoin: { requested: true, effective: true, ready: true, problems: [], lastEventAt: null } }] } });
    show('#/');
    const sentence = await screen.findByRole('heading', { level: 2, name: 'bwat is in 1 meeting' });
    expect(sentence.closest('.headline')!.className).not.toContain('needs');
    await waitFor(() => expect(sentence.closest('.headline')!.textContent).toMatch(/Weekly sync, meeting 812 3456 7890, since .+\. Hearing audio\./));
  });

  it('says bwat is ready, how it joins and how many bots are free, when no bot is in a meeting', async () => {
    globalThis.fetch = backend({ extra: {
      'GET /v1/console/settings': [200, { settingsVersion: 1, canManage: true, settings: {},
        autoJoin: { requested: true, effective: true, ready: true, problems: [], lastEventAt: null } }],
      'GET /v1/fleet': [200, { fleet: [{ bot_id: 'bot-3', version: '0.1.0', ready: true, stale: false, last_report_at: new Date().toISOString(), hearing: null, error: null, claim_id: null, meeting_number: null, claim_state: null }] }],
    } });
    show('#/');
    const sentence = await screen.findByRole('heading', { level: 2, name: 'bwat is ready' });
    expect(sentence.closest('.headline')!.textContent).toContain('bwat joins meetings in your Zoom account on its own, once the host is there. 1 bot is free.');
    expect(screen.getByRole('list', { name: 'Bots' }).textContent).toContain('Ready for the next meeting');
  });

  it('says what needs the admin while automatic joining waits for setup, with the checks under it', async () => {
    show('#/');
    const sentence = await screen.findByRole('heading', { level: 2, name: 'Needs you: automatic joining is waiting for setup' });
    expect(sentence.closest('.headline')!.className).toContain('needs');
    const joining = await screen.findByRole('region', { name: 'Automatic joining' });
    expect(within(joining).getByRole('button', { name: 'Recheck setup' })).toBeTruthy();
    expect(joining.querySelectorAll('.checks li')).toHaveLength(4);
  });

  it('says out of credit in words with its fix, never the code, and keeps the bot in its meeting', async () => {
    const base = backend();
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (new URL(String(input), 'http://bwat.test').pathname !== '/v1/fleet') return base(input, init);
      return new Response(JSON.stringify({ fleet: [
        { bot_id: 'bot-1', version: '0.1.0', ready: true, busy: true, stale: false, last_report_at: new Date().toISOString(), state: 'in_meeting', hearing: true, error: 'model_out_of_credit', claim_id: 'cl-1', meeting_number: '81234567890', occurrence_id: 'occ==', claim_state: 'attending', meeting_title: 'Weekly sync', meeting_started_at: '2026-10-06T16:00:00Z' },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    show('#/');
    const sentence = await screen.findByRole('heading', { level: 2, name: 'Needs you: OpenRouter is out of credit' });
    const box = sentence.closest('.headline') as HTMLElement;
    expect(box.className).toContain('needs');
    expect(within(box).getByRole('link', { name: 'Add credit on OpenRouter' }).getAttribute('href')).toBe('https://openrouter.ai/settings/credits');
    expect(within(box).getByRole('link', { name: 'Check the key' }).getAttribute('href')).toBe('#/settings?place=models');
    const line = within(screen.getByRole('list', { name: 'Bots' })).getByRole('listitem');
    expect(line.textContent).toContain('No transcript');
    expect(line.textContent).toContain('hearing audio, not transcribing');
    expect(line.textContent).toContain('Add credit on OpenRouter. bwat picks up again on its own.');
    expect(within(line).getByRole('button', { name: 'Recall' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('model_out_of_credit');
  });

  // Each state a bot in GET /v1/fleet can be in, alone and mixed, and the one sentence it gives.
  const IDLE = { ready: true, state: 'idle' };
  const STARTING = { ready: false, state: null };
  const JOINING = { claim_id: 'c1', claim_state: 'claimed', meeting_number: '81234567890', state: 'joining' };
  const ATTENDING = { claim_id: 'c2', claim_state: 'attending', meeting_number: '81234567891', state: 'in_meeting', meeting_title: 'Weekly sync' };
  // Recalled: its claim has ended, but it has not yet reported that it left.
  const LEAVING = { ready: true, state: 'in_meeting' };
  const STALE = { stale: true };
  const ERROR = { error: 'bridge_down', ready: false };
  it.each([
    ['no bot has checked in', [], 'Needs you: no bwat bot is running', "Until one checks in, bwat can't join a meeting."],
    ['a bot is free', [IDLE], 'bwat is ready', '1 bot is free.'],
    ['a bot is starting', [STARTING], 'bwat is starting', 'Its bots are starting up.'],
    ['a bot is joining a meeting Zoom has not named yet', [JOINING], 'bwat is joining a meeting', 'Meeting 812 3456 7890.'],
    ['a bot is joining a named meeting', [{ ...JOINING, meeting_title: 'Standup' }], 'bwat is joining a meeting', 'Standup, meeting 812 3456 7890.'],
    ['a bot is in a meeting', [ATTENDING], 'bwat is in 1 meeting', 'Weekly sync, meeting 812 3456 7891'],
    ['two bots are in meetings', [ATTENDING, { ...ATTENDING, claim_id: 'c3', meeting_number: '81234567892' }], 'bwat is in 2 meetings', 'meeting 812 3456 7892'],
    ['a bot is leaving a meeting', [LEAVING], 'bwat is leaving a meeting', 'free again once it has left'],
    ['every bot stopped answering', [STALE], 'Needs you: no bot is answering', 'The bots stopped checking in.'],
    ['a bot reports an error', [ERROR], "Needs you: a bot can't start its Zoom connection", "This bot can't start its Zoom connection."],
    ['one bot is free while another leaves', [LEAVING, IDLE], 'bwat is ready', '1 bot is free.'],
    ['one bot joins while another is free', [IDLE, JOINING], 'bwat is joining a meeting', 'Meeting 812 3456 7890.'],
    ['one bot is in a meeting while another joins', [JOINING, ATTENDING], 'bwat is in 1 meeting', 'Weekly sync'],
    ['one bot is free and another stopped answering', [STALE, IDLE], 'bwat is ready', '1 bot is free.'],
    ['one bot starts while another leaves', [LEAVING, STARTING], 'bwat is starting', 'Its bots are starting up.'],
    ['one bot is in a meeting and another reports an error', [ATTENDING, ERROR], "Needs you: a bot can't start its Zoom connection", 'Restart the bot.'],
    ['a bot in a meeting reports an error', [{ ...ATTENDING, error: 'transcription_unavailable' }], "Needs you: a bot can't reach the transcriber", 'Check the Deepgram key'],
  ])('says so in one sentence when %s', async (_, bots, sentence, detail) => {
    const bot = (i: number, over: object) => ({ bot_id: `bot-${i}`, version: '0.1.0', ready: true, stale: false, last_report_at: new Date().toISOString(), hearing: true, error: null, claim_id: null, meeting_number: null, occurrence_id: null, claim_state: null, state: 'idle', meeting_title: null, meeting_started_at: null, ...over });
    globalThis.fetch = backend({ extra: {
      'GET /v1/console/settings': [200, { settingsVersion: 1, canManage: true, settings: {}, autoJoin: { requested: true, effective: true, ready: true, problems: [], lastEventAt: null } }],
      'GET /v1/fleet': [200, { fleet: bots.map((over, i) => bot(i, over)) }],
    } });
    show('#/');
    const heading = await screen.findByRole('heading', { level: 2, name: sentence });
    expect(heading.closest('.headline')!.querySelector('p')!.textContent).toContain(detail);
  });

  it("names a send's meeting by its title once bwat has it, with the number beside it", async () => {
    globalThis.fetch = backend({ extra: { 'GET /v1/allocations': [200, { allocations: [
      { id: 'cl-3', meeting_number: '82222333444', meeting_title: 'Design Review', claim_state: 'refused', refused_reason: 'allocations_exhausted', last_placement_failure: 'waiting_room_timeout', error: null, created_at: '2026-10-08T16:00:00Z', joined_at: null, ended_at: '2026-10-08T16:10:00Z' },
      { id: 'cl-2', meeting_number: '82222333445', meeting_title: null, claim_state: 'pending', refused_reason: null, last_placement_failure: null, error: null, created_at: '2026-10-08T15:00:00Z', joined_at: null, ended_at: null },
    ] }] } });
    show('#/');
    const recent = await screen.findByRole('list', { name: 'Recent meetings' });
    const named = (await within(recent).findByText('Design Review')).closest('li')!;
    expect(named.querySelector('.meta')!.textContent).toContain('meeting 822 2233 3444');
    expect(named.textContent).not.toContain('Meeting 822 2233 3444');
    expect(within(recent).getByText('Meeting 822 2233 3445')).toBeTruthy();
  });

  it('lists a send still waiting for a bot, with Recall, and one Zoom refused, in words', async () => {
    globalThis.fetch = backend({ extra: { 'GET /v1/allocations': [200, { allocations: [
      { id: 'cl-7', meeting_number: '123456789', claim_state: 'pending', refused_reason: null, last_placement_failure: 'unable_to_connect', error: null, created_at: '2026-10-08T16:00:00Z', joined_at: null, ended_at: null },
      { id: 'cl-6', meeting_number: '1234567890', claim_state: 'released', refused_reason: 'zoom_join_failed', last_placement_failure: null, error: null, created_at: '2026-10-07T17:00:00Z', joined_at: null, ended_at: '2026-10-07T17:01:00Z' },
      { id: 'cl-5', meeting_number: '1234567891', claim_state: 'released', refused_reason: 'meeting_ended', last_placement_failure: null, error: null, created_at: '2026-10-07T15:00:00Z', joined_at: '2026-10-07T15:01:00Z', ended_at: '2026-10-07T16:01:00Z' },
    ] }] } });
    show('#/');
    const recent = await screen.findByRole('list', { name: 'Recent meetings' });
    await waitFor(() => expect(within(recent).getAllByRole('listitem')).toHaveLength(3));
    const [waiting, refused, joined] = within(recent).getAllByRole('listitem');
    expect(waiting!.querySelector('.meeting-title')!.textContent).toBe('Meeting 123 456 789');
    expect(waiting!.textContent).toContain('Waiting for a bot');
    expect(waiting!.textContent).toContain("Last try: bwat couldn't reach Zoom.");
    fireEvent.click(within(waiting!).getByRole('button', { name: 'Recall' }));
    fireEvent.click(within(waiting!).getByRole('button', { name: 'Confirm recall from 123 456 789' }));
    await waitFor(() => expect(writes()).toEqual([
      { method: 'PATCH', path: '/v1/allocations/cl-7', authorization: `Bearer ${TOKEN}`, body: { recall: true } },
    ]));
    expect(refused!.querySelector('.meeting-title')!.textContent).toBe('Meeting 123 456 7890');
    expect(refused!.textContent).toContain("Couldn't join");
    expect(refused!.textContent).toContain('Zoom refused to let bwat join. Check the meeting link and passcode, then send bwat again.');
    // One bwat got into is the meeting's own row, not a failed send.
    expect(joined!.querySelector('.meeting-title')!.textContent).toBe('Weekly sync');
  });

  it('keeps automatic joining on the Overview after a save that did not touch it, as the backend answers such a save without it', async () => {
    globalThis.fetch = backend({ extra: {
      // As the route answers a save with no joining key: no autoJoin.
      'PUT /v1/console/settings': [200, { settingsVersion: 2, canManage: true, settings: {
        auto_join_enabled: { value: null, default: true, revision: null, updatedAt: null, updatedBy: null },
        cards_granularity: { value: 'fewer', default: 'balanced', revision: 1, updatedAt: '2026-10-03T00:00:00Z', updatedBy: ADA.id },
      } }],
    } });
    show('#/settings?place=cards');
    fireEvent.change(await screen.findByRole('slider', { name: 'Card grouping' }), { target: { value: '0' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('status').textContent).toBe('Saved'));
    window.location.hash = '#/';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Needs you: automatic joining is waiting for setup' })).toBeTruthy();
    const joining = await screen.findByRole('region', { name: 'Automatic joining' });
    expect(joining.querySelectorAll('.checks li')).toHaveLength(4);
  });

  it('says what Settings just saved once the Overview opens again', async () => {
    const off = { settingsVersion: 2, canManage: true, autoJoin: { requested: false, effective: false, ready: false, problems: [], lastEventAt: null },
      settings: { auto_join_enabled: { value: false, default: true, revision: 1, updatedAt: '2026-10-03T00:00:00Z', updatedBy: ADA.id } } };
    globalThis.fetch = backend({ extra: {
      'PUT /v1/console/settings': [200, off],
      'GET /v1/fleet': [200, { fleet: [{ bot_id: 'bot-3', version: '0.1.0', ready: true, stale: false, last_report_at: new Date().toISOString(), hearing: null, error: null, claim_id: null, meeting_number: null, claim_state: null }] }],
    } });
    show('#/settings');
    fireEvent.click(await screen.findByLabelText('Join meetings on its own'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    // The next read answers with what was saved.
    globalThis.fetch = backend({ extra: {
      'GET /v1/console/settings': [200, off],
      'GET /v1/fleet': [200, { fleet: [{ bot_id: 'bot-3', version: '0.1.0', ready: true, stale: false, last_report_at: new Date().toISOString(), hearing: null, error: null, claim_id: null, meeting_number: null, claim_state: null }] }],
    } });
    window.location.hash = '#/';
    fireEvent(window, new HashChangeEvent('hashchange'));
    const sentence = await screen.findByRole('heading', { level: 2, name: 'bwat is ready' });
    await waitFor(() => expect(sentence.closest('.headline')!.textContent).toContain('bwat joins only when invited. 1 bot is free.'));
  });

  it('reads the settings once per visit: a return to the tab rereads the bots, not the settings', async () => {
    show('#/');
    await screen.findByRole('heading', { level: 2 });
    await screen.findByRole('list', { name: 'Recent meetings' });
    const count = (path: string) => calls.filter((c) => c.path === path).length;
    const before = { settings: count('/v1/console/settings'), fleet: count('/v1/fleet') };
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(count('/v1/fleet')).toBeGreaterThan(before.fleet));
    expect(count('/v1/console/settings')).toBe(before.settings);
    focusManager.setFocused(undefined);
  });

  it('offers a member no Recall, on a bot or on a waiting send, as the backend lets only admins recall', async () => {
    globalThis.fetch = backend({ role: 'member', extra: { 'GET /v1/allocations': [200, { allocations: [
      { id: 'cl-7', meeting_number: '123456789', claim_state: 'pending', refused_reason: null, last_placement_failure: null, error: null, created_at: '2026-10-08T16:00:00Z', joined_at: null, ended_at: null },
    ] }] } });
    show('#/');
    const bots = await screen.findByRole('list', { name: 'Bots' });
    await waitFor(() => expect(within(bots).getAllByRole('listitem')[0]!.textContent).toContain('In 812 3456 7890'));
    const recent = await screen.findByRole('list', { name: 'Recent meetings' });
    await within(recent).findByText('Waiting for a bot');
    expect(screen.queryByRole('button', { name: 'Recall' })).toBeNull();
  });

  it.each([
    ['has stopped answering', { stale: true }],
    ['reports an error', { error: 'mic_lost' }],
  ])('lets an admin recall a bot that %s while it still holds its meeting', async (_, over) => {
    const base = backend();
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (new URL(String(input), 'http://bwat.test').pathname !== '/v1/fleet') return base(input, init);
      return new Response(JSON.stringify({ fleet: [
        { bot_id: 'bot-1', version: '0.1.0', ready: true, stale: false, last_report_at: new Date().toISOString(), hearing: true, error: null, claim_id: 'cl-1', meeting_number: '81234567890', occurrence_id: 'occ==', claim_state: 'attending', meeting_title: 'Weekly sync', meeting_started_at: null, ...over },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    show('#/');
    const line = within(await screen.findByRole('list', { name: 'Bots' })).getByRole('listitem');
    fireEvent.click(await within(line).findByRole('button', { name: 'Recall' }));
    fireEvent.click(within(line).getByRole('button', { name: 'Confirm recall from 812 3456 7890' }));
    await waitFor(() => expect(writes()).toEqual([
      { method: 'PATCH', path: '/v1/allocations/cl-1', authorization: `Bearer ${TOKEN}`, body: { recall: true } },
    ]));
  });

  it('keeps a bot that reports an error in its meeting: its number and title, with the error in words beside them', async () => {
    const base = backend();
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (new URL(String(input), 'http://bwat.test').pathname !== '/v1/fleet') return base(input, init);
      return new Response(JSON.stringify({ fleet: [
        { bot_id: 'bot-1', version: '0.1.0', ready: true, stale: false, last_report_at: new Date().toISOString(), hearing: true, error: 'transcription_unavailable', claim_id: 'cl-1', meeting_number: '81234567890', occurrence_id: 'occ==', claim_state: 'attending', state: 'in_meeting', meeting_title: 'Weekly sync', meeting_started_at: null },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    show('#/');
    const line = within(await screen.findByRole('list', { name: 'Bots' })).getByRole('listitem');
    await waitFor(() => expect(line.textContent).toContain('In 812 3456 7890'));
    expect(line.textContent).toContain('Weekly sync');
    expect(line.textContent).toContain("This bot can't reach the transcriber. Check the Deepgram key in Settings → Models.");
    expect(line.textContent).not.toContain("Can't take a meeting");
    expect(line.querySelector('.pill')!.textContent).toBe('In a meeting');
  });

  it('lets an admin recall a meeting a bot holds even when that bot is not in the fleet read', async () => {
    globalThis.fetch = backend({ extra: {
      'GET /v1/fleet': [200, { fleet: [] }],
      'GET /v1/allocations': [200, { allocations: [
        { id: 'cl-4', meeting_number: '1234567892', claim_state: 'attending', refused_reason: null, last_placement_failure: null, error: null, created_at: '2026-10-08T16:00:00Z', joined_at: '2026-10-08T16:01:00Z', ended_at: null },
      ] }],
    } });
    show('#/');
    const row = (await within(await screen.findByRole('list', { name: 'Recent meetings' })).findByText('Meeting 123 456 7892')).closest('li')!;
    expect(row.textContent).toContain('In the meeting');
    fireEvent.click(within(row).getByRole('button', { name: 'Recall' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm recall from 123 456 7892' }));
    await waitFor(() => expect(writes().map((w) => w.path)).toEqual(['/v1/allocations/cl-4']));
  });

  describe('Recent meetings during a visit', () => {
    type Fake = { fleet: unknown[]; meetings: unknown[]; next: string | null; older: unknown[]; fleetFails?: boolean; olderFails?: boolean; olderGate?: Promise<void> };
    let fake: Fake;
    const bot = (over: object) => ({ bot_id: 'bot-1', version: '0.1.0', ready: true, stale: false, last_report_at: new Date().toISOString(), hearing: true, error: null, claim_id: null, meeting_number: null, occurrence_id: null, claim_state: null, meeting_title: null, meeting_started_at: null, ...over });
    const inMeeting = bot({ claim_id: 'cl-1', meeting_number: '81234567890', occurrence_id: 'occ==', claim_state: 'attending', meeting_title: 'Weekly sync', meeting_started_at: '2026-10-09T16:00:00Z' });
    const free = bot({});
    const meeting = (over: object) => ({ id: 'm9', occurrence_id: 'occ==', title: 'Weekly sync', started_at: '2026-10-09T16:00:00Z', ended_at: null, duration_seconds: null, host_email: null, bot_ids: ['bot-1'], ...over });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    beforeEach(() => {
      fake = { fleet: [free], meetings: [], next: null, older: [] };
      const base = backend({ extra: { 'GET /v1/allocations': [200, { allocations: [] }] } });
      globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input), 'http://bwat.test');
        if (url.pathname === '/v1/fleet') {
          calls.push({ method: 'GET', path: url.pathname, authorization: null, body: undefined });
          if (fake.fleetFails) return new Response('{"error":"internal"}', { status: 500, headers: { 'content-type': 'application/json' } });
          return json({ fleet: fake.fleet });
        }
        if (url.pathname === '/v1/meetings') {
          calls.push({ method: 'GET', path: url.pathname + url.search, authorization: null, body: undefined });
          if (url.searchParams.get('cursor') && fake.olderGate) await fake.olderGate;
          if (url.searchParams.get('cursor') && fake.olderFails) return new Response('{"error":"internal"}', { status: 500, headers: { 'content-type': 'application/json' } });
          return json(url.searchParams.get('cursor') ? { meetings: fake.older, next_cursor: null } : { meetings: fake.meetings, next_cursor: fake.next });
        }
        return base(input, init);
      }) as typeof fetch;
    });
    /** What the 10 s poll does, without waiting 10 s: the tab comes back into view. */
    const poll = () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    };
    afterEach(() => focusManager.setFocused(undefined));
    const row = async () => (await within(await screen.findByRole('list', { name: 'Recent meetings' })).findByText('Weekly sync')).closest('li')!;

    it('lists a meeting once a bot joins it, live while the bot holds it, then with its length once it ends', async () => {
      show('#/');
      await screen.findByText('No meetings yet. Once bwat has joined a meeting, it shows up here.');
      fake = { ...fake, fleet: [inMeeting], meetings: [meeting({})] };
      poll();
      await waitFor(async () => expect((await row()).textContent).toContain('in progress'));
      expect((await row()).querySelector('.pill.attending')!.textContent).toBe('In the meeting');
      fake = { ...fake, fleet: [free], meetings: [meeting({ ended_at: '2026-10-09T16:30:00Z', duration_seconds: 1800 })] };
      poll();
      await waitFor(async () => expect((await row()).textContent).toContain('30 min'));
      expect((await row()).querySelector('.pill')).toBeNull();
    });

    it('says bwat has left once its bot leaves a meeting that is still going', async () => {
      fake = { ...fake, fleet: [inMeeting], meetings: [meeting({})] };
      show('#/');
      await waitFor(async () => expect((await row()).textContent).toContain('in progress'));
      fake = { ...fake, fleet: [free] };
      poll();
      await waitFor(async () => expect((await row()).textContent).toContain('bwat has left'));
      expect((await row()).textContent).not.toContain('in progress');
      expect((await row()).querySelector('.pill')).toBeNull();
    });

    it('never says a meeting is in progress from a missing length alone', async () => {
      fake = { ...fake, fleet: [free], meetings: [meeting({})] };
      show('#/');
      await waitFor(async () => expect((await row()).textContent).toContain('bwat has left'));
      expect((await row()).querySelector('.pill')).toBeNull();
    });

    it('keeps the last known presence through a failed read of the bots, and never says bwat left from one', async () => {
      fake = { ...fake, fleet: [inMeeting], meetings: [meeting({})] };
      show('#/');
      await waitFor(async () => expect((await row()).textContent).toContain('in progress'));
      fake = { ...fake, fleetFails: true };
      poll();
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("couldn't load the bots"));
      expect((await row()).textContent).toContain('in progress');
      expect((await row()).textContent).not.toContain('bwat has left');
      fake = { ...fake, fleetFails: false, fleet: [free] };
      poll();
      await waitFor(async () => expect((await row()).textContent).toContain('bwat has left'));
    });

    it('says nothing of presence while the bots have never been read', async () => {
      fake = { ...fake, fleetFails: true, meetings: [meeting({})] };
      show('#/');
      await screen.findByRole('alert');
      const text = (await row()).textContent!;
      expect(text).not.toContain('bwat has left');
      expect(text).not.toContain('in progress');
      expect((await row()).querySelector('.pill')).toBeNull();
    });

    it('keeps Load more after its first read fails, and reads again on a press', async () => {
      fake = { ...fake, meetings: [meeting({ ended_at: '2026-10-09T16:30:00Z', duration_seconds: 1800 })], next: 'c2', olderFails: true,
        older: [meeting({ id: 'm8', occurrence_id: 'occ8', title: 'Older sync', started_at: '2026-10-01T16:00:00Z', ended_at: '2026-10-01T16:10:00Z', duration_seconds: 600 })] };
      show('#/');
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("couldn't load the meetings"));
      fake = { ...fake, olderFails: false };
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('Older sync')).toBeTruthy();
      expect(calls.filter((c) => c.path === '/v1/meetings?with_bot=1&cursor=c2')).toHaveLength(2);
    });

    it('keeps Load more, as Loading…, while its first read is on its way', async () => {
      let release!: () => void;
      fake = { ...fake, meetings: [meeting({ ended_at: '2026-10-09T16:30:00Z', duration_seconds: 1800 })], next: 'c2',
        olderGate: new Promise((resolve) => (release = resolve)),
        older: [meeting({ id: 'm8', occurrence_id: 'occ8', title: 'Older sync', started_at: '2026-10-01T16:00:00Z', ended_at: '2026-10-01T16:10:00Z', duration_seconds: 600 })] };
      show('#/');
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      const pending = await screen.findByRole('button', { name: 'Loading…' });
      expect((pending as HTMLButtonElement).disabled).toBe(true);
      release();
      expect(await screen.findByText('Older sync')).toBeTruthy();
    });

    it('drops a meeting deleted from the newest page after Load more, and keeps one only pushed down', async () => {
      const ended = (id: string, day: number) =>
        meeting({ id, occurrence_id: `occ-${id}`, title: `Sync ${id}`, started_at: `2026-10-0${day}T16:00:00Z`, ended_at: `2026-10-0${day}T16:10:00Z`, duration_seconds: 600 });
      fake = { ...fake, meetings: [ended('m3', 5), ended('m2', 4)], next: 'c2', older: [ended('m1', 3)] };
      show('#/');
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      await screen.findByText('Sync m1');
      // m2 is deleted: the newest page now reaches down to m1.
      fake = { ...fake, meetings: [ended('m3', 5), ended('m1', 3)], next: null };
      poll();
      await waitFor(() => expect(screen.queryByText('Sync m2')).toBeNull());
      const titles = [...document.querySelectorAll('.meetings .meeting-title')].map((t) => t.textContent);
      expect(titles).toEqual(['Sync m3', 'Sync m1']);
    });

    it('loses no meeting when a new one pushes the newest page down after Load more', async () => {
      const ended = (id: string, day: number) =>
        meeting({ id, occurrence_id: `occ-${id}`, title: `Sync ${id}`, started_at: `2026-10-0${day}T16:00:00Z`, ended_at: `2026-10-0${day}T16:10:00Z`, duration_seconds: 600 });
      fake = { ...fake, meetings: [ended('m3', 5), ended('m2', 4)], next: 'c2', older: [ended('m1', 3)] };
      show('#/');
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      await screen.findByText('Sync m1');
      // m4 arrives: the newest page is now m4 and m3, and m2 sits between it and the older pages.
      fake = { ...fake, meetings: [ended('m4', 6), ended('m3', 5)], next: 'c1' };
      poll();
      await screen.findByText('Sync m4');
      const titles = [...document.querySelectorAll('.meetings .meeting-title')].map((t) => t.textContent);
      expect(titles).toEqual(['Sync m4', 'Sync m3', 'Sync m2', 'Sync m1']);
    });

    it('rereads only the newest page on each poll, keeps the older pages Load more read, and rereads it once a send settles', async () => {
      fake = { ...fake, meetings: [meeting({ ended_at: '2026-10-09T16:30:00Z', duration_seconds: 1800 })], next: 'c2',
        older: [meeting({ id: 'm8', occurrence_id: 'occ8', title: 'Older sync', started_at: '2026-10-01T16:00:00Z', ended_at: '2026-10-01T16:10:00Z', duration_seconds: 600 })] };
      show('#/');
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('Older sync')).toBeTruthy();
      const reads = () => calls.filter((c) => c.path.startsWith('/v1/meetings')).map((c) => c.path);
      expect(reads()).toEqual(['/v1/meetings?with_bot=1', '/v1/meetings?with_bot=1&cursor=c2']);
      poll();
      await waitFor(() => expect(reads()).toEqual(['/v1/meetings?with_bot=1', '/v1/meetings?with_bot=1&cursor=c2', '/v1/meetings?with_bot=1']));
      expect(screen.getByText('Older sync')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Zoom meeting link'), { target: { value: 'https://zoom.us/j/89999999999' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send bwat' }));
      await waitFor(() => expect(reads()).toEqual(['/v1/meetings?with_bot=1', '/v1/meetings?with_bot=1&cursor=c2', '/v1/meetings?with_bot=1', '/v1/meetings?with_bot=1']));
      expect(screen.getByText('Older sync')).toBeTruthy();
    });
  });

  it('a recall that fails says so once on the Overview', async () => {
    const base = backend();
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) =>
      (init.method ?? 'GET').toUpperCase() === 'PATCH'
        ? new Response(JSON.stringify({ error: 'internal' }), { status: 500, headers: { 'content-type': 'application/json' } })
        : base(input, init)) as typeof fetch;
    show('#/');
    const bots = await screen.findByRole('list', { name: 'Bots' });
    fireEvent.click(await within(bots).findByRole('button', { name: 'Recall' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm recall from 812 3456 7890' }));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
  });

  it('says no meetings yet only once the meetings were read, never beside a failed read', async () => {
    globalThis.fetch = backend({ extra: { 'GET /v1/meetings': [500, { error: 'internal' }], 'GET /v1/allocations': [200, { allocations: [] }] } });
    show('#/');
    expect(await screen.findByText("We couldn't load the meetings. Reload the page to try again.")).toBeTruthy();
    expect(screen.queryByText(/No meetings yet/)).toBeNull();
  });

  it('lists recent meetings a bot joined, each opening its board, with failed sends in words among them', async () => {
    show('#/');
    const recent = await screen.findByRole('list', { name: 'Recent meetings' });
    await waitFor(() => expect(within(recent).getAllByRole('listitem')).toHaveLength(2));
    const [failed, joined] = within(recent).getAllByRole('listitem');
    expect(failed!.querySelector('.meeting-title')!.textContent).toBe('Meeting 899 9000 2222');
    expect(failed!.textContent).toContain("Couldn't join");
    expect(failed!.textContent).toContain("bwat tried more than once and couldn't get in.");
    expect(failed!.textContent).toContain("Last try: The host didn't let bwat in from the waiting room within 15 minutes.");
    expect(failed!.textContent).not.toContain('allocations_exhausted');
    expect(within(failed!).queryByRole('link')).toBeNull();
    expect(joined!.querySelector('.meeting-title')!.textContent).toBe('Weekly sync');
    expect(within(joined!).getByRole('link', { name: 'Open board' }).getAttribute('href')).toBe('/?meeting=m1');
    // Not a bot's meeting, and a recall someone chose: neither is listed.
    expect(screen.queryByText('Nobody sent bwat')).toBeNull();
    expect(screen.queryByText('Meeting 855 5000 1111')).toBeNull();
    expect(screen.queryByRole('link', { name: /status/ })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('an admin demoted while the page is open loses the credential controls on the refusal', async () => {
    let demoted = false;
    const base = backend();
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://bwat.test').pathname;
      if (path === '/v1/console/secrets/zoom.webhook_secret' && init.method === 'PUT') {
        demoted = true;
        return new Response('{"error":"forbidden"}', { status: 403 });
      }
      const res = await base(input, init);
      if (demoted && path === '/v1/console/settings') {
        return new Response(JSON.stringify({ ...(await res.json()), canManage: false }), { status: 200 });
      }
      return res;
    }) as typeof fetch;
    show('#/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Connections' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Main app (the meeting bot)' })).getByRole('button', { expanded: false }));
    fireEvent.change(await screen.findByLabelText('New Main app secret token'), { target: { value: 'whsec-very-secret-value' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Main app secret token' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Main app secret token' })).toBeNull());
  });

  it('a secret the store could not read is shown as unknown, never as not set', async () => {
    show('#/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Connections' }));
    const app = await screen.findByRole('group', { name: 'Server-to-server app (optional)' });
    expect(app.querySelector('small')!.textContent).toContain("couldn't be read");
    expect(app.querySelector('small')!.textContent).not.toContain('Not set');
    fireEvent.click(within(app).getByRole('button', { expanded: false }));
    const row = within(app).getByRole('group', { name: 'Server-to-server client secret' });
    expect(row.textContent).toContain("couldn't be read");
    expect(row.textContent).not.toContain('Not set');
  });

  it('Members lists everyone, by email until they have a name, and invites through POST /v1/members', async () => {
    show('#/members');
    expect(await screen.findByText('bob@example.com', { selector: 'td.name' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'cy@example.com' } });
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Cy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'POST', path: '/v1/members', authorization: `Bearer ${TOKEN}`,
      body: { email: 'cy@example.com', display_name: 'Cy' },
    });
  });

  // The commands a teammate runs to connect Claude Code, with this bwat's address. The
  // page is at http://localhost:3000 here; the plugin takes plain http only for 127.0.0.1.
  it('Members shows the commands that connect Claude Code to this bwat', async () => {
    show('#/members');
    const box = await screen.findByRole('region', { name: 'Connect Claude Code' });
    expect(box.querySelector('pre')!.textContent).toBe('claude plugin marketplace add qoralai/qoral-plugin-marketplace\n'
      + 'claude plugin install bwat@qoral-plugin-marketplace --config base_url=http://127.0.0.1:3000/v1');
    expect(box.textContent).toContain('/bwat:login');
  });

  it('puts each Zoom app in its own row, its fields opened in that row only', async () => {
    show('#/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Connections' }));
    const main = await screen.findByRole('group', { name: 'Main app (the meeting bot)' });
    const board = screen.getByRole('group', { name: 'Board app (the board in Zoom)' });
    fireEvent.click(within(board).getByRole('button', { expanded: false }));
    expect(within(board).getByRole('group', { name: 'Board app client secret' })).toBeTruthy();
    expect(within(main).queryByRole('group', { name: 'Board app client secret' })).toBeNull();
  });

  it('sends the bearer of the person the page shows, also after the account changes', async () => {
    let who = { member: ADA, id_token: TOKEN };
    const base = backend();
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (new URL(String(input), 'http://bwat.test').pathname === '/whoami') {
        calls.push({ method: 'GET', path: '/whoami', authorization: null, body: undefined });
        return new Response(JSON.stringify(who), { status: 200 });
      }
      return base(input, init);
    }) as typeof fetch;
    const client = makeQueryClient();
    window.location.hash = '#/members';
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByText('bob@example.com', { selector: 'td.name' });
    who = { member: { ...ADA, id: 'b0b', email: 'bob@example.com', display_name: 'Bob' }, id_token: 'id-token-for-bob' };
    await client.invalidateQueries({ queryKey: ['me'] });
    await screen.findByText('Bob', { selector: '.person .name' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'cy@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.authorization).toBe('Bearer id-token-for-bob');
  });

  it('never replays a change as another account after a 401', async () => {
    let who = { member: ADA, id_token: TOKEN };
    const base = backend();
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://bwat.test').pathname;
      if (path === '/whoami') return new Response(JSON.stringify(who), { status: 200 });
      if (path === '/v1/members' && init.method === 'POST') {
        const res = await base(input, init);
        // Ada's token lapsed; meanwhile Bob signed in on this browser in another tab.
        who = { member: { ...ADA, id: 'b0b', email: 'bob@example.com', display_name: 'Bob' }, id_token: 'id-token-for-bob' };
        return new Response('{"error":"unauthorized"}', { status: 401, headers: res.headers });
      }
      return base(input, init);
    }) as typeof fetch;
    show('#/members');
    await screen.findByText('bob@example.com', { selector: 'td.name' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'cy@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    // The page moves to the account now signed in, and the invite went once, as Ada.
    await screen.findByText('Bob', { selector: '.person .name' });
    expect(writes().map((w) => w.authorization)).toEqual([`Bearer ${TOKEN}`]);
  });

  it('sends the bearer on every backend call', async () => {
    show('#/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Connections' }));
    await screen.findByRole('group', { name: 'Main app (the meeting bot)' });
    const v1 = calls.filter((c) => c.path.startsWith('/v1/'));
    expect(v1.length).toBeGreaterThan(0);
    expect(v1.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('names no workspace, voice or another product anywhere in the panel', () => {
    const dir = import.meta.dirname;
    for (const file of readdirSync(dir)) {
      if (file === 'admin.test.tsx') continue;
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/workspace|voice|aura/i);
    }
  });

  describe('Finish setting up (QOR-4334)', () => {
    const items = [
      { id: 'zoom-board', title: 'Create the board app', detail: 'From the setup page.', link: 'https://github.com/qoralai/bwat/blob/main/docs/onboarding.md', done_at: null, done_by: null },
      { id: 'share', title: 'Share bwat with the team', detail: '', link: null, done_at: '2026-10-19T00:00:00Z', done_by: ADA.id },
    ];

    it('shows an admin the setup page\'s open steps on the Overview only, and ticks one off', async () => {
      globalThis.fetch = backend({ extra: {
        'GET /v1/setup-checklist': [200, { items }],
        'POST /v1/setup-checklist/zoom-board/done': [200, { ...items[0], done_at: '2026-10-19T01:00:00Z' }],
      } });
      show('#/');
      const section = await screen.findByRole('region', { name: 'Finish setting up' });
      expect(within(section).getByText('Create the board app')).toBeTruthy();
      expect(within(section).queryByText('Share bwat with the team')).toBeNull();
      expect(within(section).getByRole('link', { name: 'How to do it' }).getAttribute('target')).toBe('_blank');
      expect(screen.queryByRole('link', { name: /setup step/ })).toBeNull();
      fireEvent.click(within(section).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(writes()).toEqual([
        { method: 'POST', path: '/v1/setup-checklist/zoom-board/done', authorization: `Bearer ${TOKEN}`, body: undefined },
      ]));
    });

    it('counts the open steps in a pill linking to the Overview on every other page', async () => {
      globalThis.fetch = backend({ extra: { 'GET /v1/setup-checklist': [200, { items }] } });
      for (const hash of ['#/members', '#/settings', '#/plugins']) {
        show(hash);
        const pill = await screen.findByRole('link', { name: '1 setup step open' });
        expect(pill.getAttribute('href')).toBe('#/');
        expect(screen.queryByRole('region', { name: 'Finish setting up' })).toBeNull();
        cleanup();
      }
    });

    it('shows nothing when every step is done, or to a member', async () => {
      globalThis.fetch = backend({ extra: { 'GET /v1/setup-checklist': [200, { items: [items[1]] }] } });
      show('#/members');
      await waitFor(() => expect(calls.some((c) => c.path === '/v1/setup-checklist')).toBe(true));
      await screen.findAllByText('bob@example.com');
      expect(screen.queryByRole('region', { name: 'Finish setting up' })).toBeNull();
      cleanup();
      calls = [];
      globalThis.fetch = backend({ role: 'member', extra: { 'GET /v1/setup-checklist': [200, { items }] } });
      show('#/members');
      await screen.findAllByText('Ada');
      expect(calls.some((c) => c.path === '/v1/setup-checklist')).toBe(false);
    });
  });
});
