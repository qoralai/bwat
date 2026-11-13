// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { Settings } from './Settings';
import { makeQueryClient } from './api';
import { settingDef } from './catalogue';

/* The admin Settings page: five places, one save bar, and a member's sentences. */

type Entry = { value: unknown; default: unknown; revision: number | null; updatedAt: string | null };
type Call = { method: string; path: string; body: unknown };

const entry = (value: unknown, fallback: unknown, revision: number | null = null): Entry => ({
  value,
  default: fallback,
  revision,
  updatedAt: revision === null ? null : '2026-10-01T00:00:00Z',
});

let calls: Call[];
let stored: Record<string, Entry>;
/** Answers for one path, in place of the default one. */
let answers: Record<string, (body: unknown) => [number, unknown]>;
/** While set, every write waits for it: the moments must not play before the server answers. */
let gate: Promise<void> | null;
/** When set, only a write to this path waits for the gate. */
let gatePath: string | null;
type Secret = { set: boolean; source: 'store' | 'env' | 'unavailable' | null; last4: string | null };
let keys: (Secret & { provider: string })[];
let secrets: (Secret & { name: string })[];

const EVENTS = 'Waiting for a verified meeting event from this Zoom account. Check the main app’s event subscription.';
type AutoJoin = { requested: boolean; effective: boolean; ready: boolean; problems: string[]; lastEventAt: string | null };
const waiting = (...problems: string[]): AutoJoin => ({ requested: true, effective: false, ready: false, problems, lastEventAt: null });
const READY: AutoJoin = { requested: true, effective: true, ready: true, problems: [], lastEventAt: '2026-10-19T09:00:00Z' };
let autoJoin: AutoJoin;

function initialSettings(): Record<string, Entry> {
  return {
    auto_join_enabled: entry(null, true),
    auto_join_require_host: entry(true, true, 4),
    bypass_waiting_room: entry(null, true),
    wait_for_start_min: entry(null, 10),
    waiting_room_min: entry(null, 15),
    idle_leave_min: entry(null, 5),
    display_name: entry(null, 'bwat'),
    chat_posts_enabled: entry(null, true),
    chat_agenda_enabled: entry(null, true),
    cards_granularity: entry(null, 'balanced'),
    transcript_retention_days: entry(30, 90, 2),
    transcript_keep_forever: entry(false, true, 5),
    jev_enabled: entry(null, true),
    jev_model: entry(null, 'typesafe/jev-1.13'),
    jev_threshold_pct: entry(null, 65),
    jev_link_threshold_pct: entry(null, 85),
    jev_deadline_s: entry(null, 60),
  };
}

const json = (status: number, body: unknown) =>
  status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function backend(role: 'owner' | 'member'): typeof fetch {
  const read = () => ({
    settingsVersion: 3,
    canManage: role !== 'member',
    settings: stored,
    ...(role === 'member' ? {} : { autoJoin }),
  });
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'http://bwat.test').pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (gate && (gatePath ? path === gatePath : method !== 'GET')) await gate;
    const special = answers[`${method} ${path}`];
    if (special) return json(...special(body));
    if (path === '/whoami') return json(200, { member: { id: 'a', email: 'ada@example.com', display_name: 'Ada', role }, id_token: 't' });
    if (method === 'GET' && path === '/v1/console/settings') return json(200, read());
    if (method === 'PUT' && path === '/v1/console/settings') {
      // Each saved key moves to the next revision, as the backend's does.
      const changes = (body as { changes: Record<string, { value: unknown; expectedRevision: number | null }> }).changes;
      for (const [key, change] of Object.entries(changes)) {
        stored = { ...stored, [key]: entry(change.value, stored[key]!.default, (change.expectedRevision ?? 0) + 1) };
      }
      // As the route answers: autoJoin only when the save touched a joining key.
      const answer: Record<string, unknown> = read();
      if (!Object.keys(changes).some((k) => settingDef(k)?.section === 'joining')) delete answer.autoJoin;
      return json(200, answer);
    }
    if (path === '/v1/console/settings/presence-image') return json(204, null);
    if (path === '/v1/console/corrections') return json(200, { dictionary: { state: 'absent', revision: null, payload: null } });
    if (path === '/v1/console/model-keys') return json(200, { keys });
    if (path === '/v1/console/secrets') return json(200, { secrets });
    if (path === '/v1/console/google-signin') {
      return json(200, {
        signIn: 'google', configured: true, webClientIds: ['web.apps.example.com'], pluginClient: { id: 'plugin.apps.example.com', secret: { set: true, last4: 'pl4g' } },
        domains: { effective: ['example.com'], env: ['example.com'], saved: null, revision: null, updatedAt: null },
      });
    }
    const key = /^\/v1\/console\/model-keys\/(\w+)(\/validate)?$/.exec(path);
    if (key && method === 'POST') return json(200, { result: 'valid' });
    if (key && method === 'PUT') {
      const typed = (body as { key: string }).key;
      const next = { provider: key[1]!, set: true, source: 'store' as const, last4: typed.slice(-4) };
      keys = keys.map((k) => (k.provider === next.provider ? next : k));
      return json(200, next);
    }
    const secret = /^\/v1\/console\/secrets\/([\w.]+)$/.exec(path);
    if (secret && method === 'DELETE') {
      const next = { name: secret[1]!, set: false, source: null, last4: null };
      secrets = secrets.map((x) => (x.name === next.name ? next : x));
      return json(200, next);
    }
    if (secret && method === 'PUT') {
      const next = { name: secret[1]!, set: true, source: 'store' as const, last4: (body as { value: string }).value.slice(-4) };
      secrets = secrets.map((x) => (x.name === next.name ? next : x));
      return json(200, next);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
}

function show(role: 'owner' | 'member' = 'owner') {
  globalThis.fetch = backend(role);
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <Settings />
    </QueryClientProvider>,
  );
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const place = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
/** An owner's page, loaded, on one place. */
const openPlace = async (name: string) => {
  show();
  await screen.findByLabelText('Join meetings on its own');
  place(name);
};
const bar = () => screen.getByRole('region', { name: 'Unsaved changes' });

beforeEach(() => {
  calls = [];
  stored = initialSettings();
  answers = {};
  gate = null;
  gatePath = null;
  autoJoin = waiting(EVENTS);
  keys = [
    { provider: 'openrouter', set: true, source: 'store', last4: 'wxyz' },
    { provider: 'deepgram', set: true, source: 'env', last4: '22ab' },
    { provider: 'openai', set: false, source: null, last4: null },
    { provider: 'anthropic', set: false, source: null, last4: null },
    { provider: 'cerebras', set: false, source: null, last4: null },
    { provider: 'custom', set: false, source: null, last4: null },
  ];
  secrets = [
    { name: 'zoom.client_id', set: true, source: 'store', last4: 'c1d0' },
    { name: 'zoom.client_secret', set: true, source: 'store', last4: 'a81f' },
    { name: 'zoom.webhook_secret', set: false, source: null, last4: null },
    { name: 'zoom.board_client_secret', set: true, source: 'store', last4: '07be' },
    { name: 'zoom.s2s_account_id', set: false, source: null, last4: null },
    { name: 'zoom.s2s_client_id', set: false, source: null, last4: null },
    { name: 'zoom.s2s_client_secret', set: false, source: null, last4: null },
  ];
});
afterEach(cleanup);

describe('the admin Settings page, in five places', () => {
  it('offers Meeting bot, Cards, Models, Data and Connections, one at a time, opening on Meeting bot, each under its title alone', async () => {
    show();
    const nav = await screen.findByRole('navigation', { name: 'Settings pages' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Meeting bot', 'Cards', 'Models', 'Retention', 'Connections']);
    expect(within(nav).getByRole('button', { name: 'Meeting bot' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: 'Meeting bot' })).toBeTruthy();
    expect(screen.queryByText(/How bwat joins and shows up|How bwat turns what is said|How long bwat keeps|The Zoom apps|Which models bwat uses/)).toBeNull();
    expect(document.querySelector('.settings-pane .sub')).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Card grouping' })).toBeNull();
    place('Cards');
    expect(within(nav).getByRole('button', { name: 'Cards' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('slider', { name: 'Card grouping' })).toBeTruthy();
    expect(screen.queryByLabelText('Join meetings on its own')).toBeNull();
  });

  it('opens on the place a link names, as the Zoom invite box links to Connections, and on Meeting bot for a member', async () => {
    window.location.hash = '#/settings?place=connections&row=zoom-s2s';
    try {
      show();
      const nav = await screen.findByRole('navigation', { name: 'Settings pages' });
      expect(within(nav).getByRole('button', { name: 'Connections' }).getAttribute('aria-current')).toBe('page');
      cleanup();
      show('member');
      const member = await screen.findByRole('navigation', { name: 'Settings pages' });
      expect(within(member).getByRole('button', { name: 'Meeting bot' }).getAttribute('aria-current')).toBe('page');
    } finally {
      window.location.hash = '';
    }
  });

  it('keeps settings bwat does not offer here out of every place (another change builds them)', async () => {
    show();
    await screen.findByLabelText('Join meetings on its own');
    for (const name of ['Meeting bot', 'Cards', 'Models', 'Retention', 'Connections']) {
      place(name);
      expect(screen.queryByText(/Join muted|Camera off|Reset to default|keeps listening for follow-ups/)).toBeNull();
    }
  });
});

describe('a member reads sentences, not greyed-out fields', () => {
  it('says how bwat joins, what it is called, how cards are grouped and how long transcripts stay', async () => {
    show('member');
    const nav = await screen.findByRole('navigation', { name: 'Settings pages' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Meeting bot', 'Cards', 'Retention']);
    expect(await screen.findByText('bwat joins meetings in your Zoom account on its own, once the host is there.')).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'It shows up as bwat, with its picture as its video.')).toBeTruthy();
    expect(screen.getByText('It posts in the meeting chat.')).toBeTruthy();
    expect(screen.getByText('Only an owner or an admin changes these.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    place('Cards');
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Cards are grouped balanced.')).toBeTruthy();
    expect(screen.getByText('Faster cards are on.')).toBeTruthy();
    // Anyone signed in keeps the dictionary, so a member has it too.
    expect(await screen.findByRole('region', { name: 'Dictionary' })).toBeTruthy();
    place('Retention');
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Transcripts are deleted after 30 days. Cards stay.')).toBeTruthy();
    expect(calls.some((c) => /model-keys|cards-model|secrets|presence-image/.test(c.path))).toBe(false);
  });

  it('says bwat joins only when invited while automatic joining is off', async () => {
    stored.auto_join_enabled = entry(false, true, 1);
    stored.transcript_keep_forever = entry(null, true);
    show('member');
    expect(await screen.findByText('bwat joins only when invited.')).toBeTruthy();
    place('Retention');
    expect(screen.getByText('Transcripts are kept forever. Cards stay.')).toBeTruthy();
  });

  it('says the bot posts nothing on joining while the agenda is off', async () => {
    stored.chat_agenda_enabled = entry(false, true, 1);
    show('member');
    expect(await screen.findByText('It posts in the meeting chat, but nothing on joining.')).toBeTruthy();
  });
});

describe('one save bar', () => {
  it('rises with the number of changes across every place, edges each changed row, and Undo takes them all back', async () => {
    show();
    const auto = (await screen.findByLabelText('Join meetings on its own')) as HTMLInputElement;
    expect(bar().className).not.toContain('show');
    fireEvent.click(auto);
    expect(bar().className).toContain('show');
    expect(within(bar()).getByText('1 change')).toBeTruthy();
    expect(auto.closest('.setting')!.className).toContain('changed');
    place('Cards');
    fireEvent.change(screen.getByRole('slider', { name: 'Card grouping' }), { target: { value: '2' } });
    expect(within(bar()).getByText('2 changes')).toBeTruthy();
    // Save is the one primary button; Undo is quiet text beside it.
    expect(within(bar()).getByRole('button', { name: 'Undo' }).className).toBe('button quiet');
    expect(within(bar()).getByRole('button', { name: 'Save' }).className).toBe('button primary');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Undo' }));
    expect(bar().className).not.toContain('show');
    expect((screen.getByRole('slider', { name: 'Card grouping' }) as HTMLInputElement).value).toBe('1');
    expect(document.querySelector('.changed')).toBeNull();
    place('Meeting bot');
    expect((screen.getByLabelText('Join meetings on its own') as HTMLInputElement).checked).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('counts nothing once a change is put back by hand', async () => {
    show();
    const auto = await screen.findByLabelText('Join meetings on its own');
    fireEvent.click(auto);
    fireEvent.click(auto);
    expect(bar().className).not.toContain('show');
  });

  it('saves every place it changed in one request with the revisions it read, then the lens closes, only once the server has answered', async () => {
    show();
    fireEvent.click(await screen.findByLabelText('Only once the host is there'));
    place('Retention');
    fireEvent.click(within(screen.getByRole('group', { name: 'Keep transcripts' })).getByRole('button', { name: 'Forever' }));
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(bar().querySelector('.lensmark')).toBeNull();
    expect(within(bar()).getByRole('status').textContent).toBe('');
    release();
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/v1/console/settings',
        body: { changes: { auto_join_require_host: { value: false, expectedRevision: 4 }, transcript_keep_forever: { value: true, expectedRevision: 5 } } },
      },
    ]);
    await waitFor(() => expect(within(bar()).getByRole('status').textContent).toBe('Saved'));
    expect(bar().querySelector('.lensmark')!.getAttribute('aria-hidden')).toBe('true');
    expect(within(bar()).queryByText(/change/)).toBeNull();
    expect(document.querySelector('.changed')).toBeNull();
  });

  it('keeps what the reader typed while a save was on its way: only a field still as sent takes the answer', async () => {
    show();
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Scribe' } });
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.change(name, { target: { value: 'Scribe 2' } });
    release();
    await waitFor(() => expect(stored.display_name!.value).toBe('Scribe'));
    await waitFor(() => expect(within(bar()).getByRole('status').textContent).toBe('Saved'));
    expect(name.value).toBe('Scribe 2');
    expect(name.closest('.setting')!.className).toContain('changed');
  });

  it('keeps a draft typed after a save through a lost and regained connection, and reads nothing behind it', async () => {
    show();
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Scribe' } });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(bar()).getByRole('status').textContent).toBe('Saved'));
    fireEvent.change(name, { target: { value: 'Scribe 2' } });
    const reads = calls.filter((c) => c.method === 'GET' && c.path === '/v1/console/settings').length;
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/v1/console/settings')).toHaveLength(reads);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Scribe 2');
    expect(screen.getByLabelText('Name').closest('.setting')!.className).toContain('changed');
  });

  it('saves nothing when one place changed elsewhere: says which, keeps the draft, and waits for a Reload', async () => {
    answers['PUT /v1/console/settings'] = () => [409, { error: 'stale', currentRevisions: { auto_join_require_host: 4, cards_granularity: null, transcript_keep_forever: 6 } }];
    show();
    fireEvent.click(await screen.findByLabelText('Only once the host is there'));
    place('Cards');
    fireEvent.change(screen.getByRole('slider', { name: 'Card grouping' }), { target: { value: '2' } });
    place('Retention');
    fireEvent.click(within(screen.getByRole('group', { name: 'Keep transcripts' })).getByRole('button', { name: 'Forever' }));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Nothing was saved. Retention changed elsewhere: reload to see it.')).toBeTruthy();
    expect(writes()).toHaveLength(1);
    expect(within(bar()).getByText('3 changes')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Keep transcripts' })).getByRole('button', { name: 'Forever' }).closest('.setting')!.className).toContain('changed');
    expect(within(bar()).getByRole('status').textContent).toBe('');
    fireEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(bar().className).not.toContain('show'));
  });

  it('says nothing was saved, and what cannot be, when the server refuses a value', async () => {
    answers['PUT /v1/console/settings'] = () => [400, { error: 'invalid_settings', problems: ['Card grouping must be one of fewer, balanced, more.'] }];
    show();
    fireEvent.click(await screen.findByLabelText('Only once the host is there'));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Nothing was saved. These settings can't be saved:")).toBeTruthy();
    expect(within(alert).getByText('Card grouping must be one of fewer, balanced, more.')).toBeTruthy();
    expect(within(bar()).getByText('1 change')).toBeTruthy();
  });

  it('names what cannot be saved, as the page names it, and holds Save until it is fixed', async () => {
    show();
    await screen.findByLabelText('Join meetings on its own');
    place('Retention');
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '0' } });
    expect(screen.getByText('Days to keep transcripts must be a whole number from 1 to 36500.')).toBeTruthy();
    expect((within(bar()).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '14' } });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'PUT', path: '/v1/console/settings', body: { changes: { transcript_retention_days: { value: 14, expectedRevision: 2 } } } });
  });

  it('drops a half-typed number of days once Forever is chosen, so Save is not held by a field no longer shown', async () => {
    show();
    await screen.findByLabelText('Join meetings on its own');
    place('Retention');
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: 'abc' } });
    expect((within(bar()).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(screen.getByRole('group', { name: 'Keep transcripts' })).getByRole('button', { name: 'Forever' }));
    expect(screen.queryByText('Days to keep transcripts must be a whole number from 1 to 36500.')).toBeNull();
    expect(within(bar()).getByText('1 change')).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(Object.keys((writes()[0]!.body as { changes: object }).changes)).toEqual(['transcript_keep_forever']);
  });
});

describe('the places, item by item', () => {
  it('keeps transcripts as one choice: Forever, or Delete after N days', async () => {
    show();
    await screen.findByLabelText('Join meetings on its own');
    place('Retention');
    const transcripts = within(screen.getByRole('group', { name: 'Keep transcripts' }));
    expect(transcripts.getByRole('button', { name: 'Delete after' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Days') as HTMLInputElement).value).toBe('30');
    expect(screen.getByText('Cards stay. Only the word-for-word transcript is deleted.')).toBeTruthy();
    fireEvent.click(transcripts.getByRole('button', { name: 'Forever' }));
    expect(transcripts.getByRole('button', { name: 'Forever' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('Days')).toBeNull();
    fireEvent.click(transcripts.getByRole('button', { name: 'Delete after' }));
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '14' } });
    expect(within(bar()).getByText('1 change')).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ changes: { transcript_retention_days: { value: 14, expectedRevision: 2 } } });
  });

  // Untouched cards stay open forever unless an admin picks a number of days.
  it('keeps untouched cards open Forever by default, or closes them after the days an admin enters', async () => {
    show();
    await screen.findByLabelText('Join meetings on its own');
    place('Retention');
    const cards = within(screen.getByRole('group', { name: 'Keep untouched cards open' }));
    expect(cards.getByRole('button', { name: 'Forever' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('Days before a card closes')).toBeNull();
    fireEvent.click(cards.getByRole('button', { name: 'Close after' }));
    const days = screen.getByLabelText('Days before a card closes') as HTMLInputElement;
    expect(days.placeholder).toBe('10');
    fireEvent.change(days, { target: { value: '30' } });
    expect(within(bar()).getByText('2 changes')).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({
      changes: { cards_keep_open_forever: { value: false, expectedRevision: null }, cards_close_after_days: { value: 30, expectedRevision: null } },
    });
  });

  it('calls the card size Card grouping, and the fast writer Faster cards, with one line that keeps its data fact', async () => {
    show();
    await screen.findByLabelText('Join meetings on its own');
    place('Cards');
    const grouping = screen.getByRole('slider', { name: 'Card grouping' }) as HTMLInputElement;
    expect([grouping.min, grouping.max, grouping.value, grouping.getAttribute('aria-valuetext')]).toEqual(['0', '2', '1', 'Balanced']);
    expect([...document.querySelectorAll('.step-ends span')].map((e) => e.textContent)).toEqual(['Fewer, fuller', 'Balanced', 'More, smaller']);
    fireEvent.change(grouping, { target: { value: '0' } });
    expect(grouping.getAttribute('aria-valuetext')).toBe('Fewer, fuller');
    const faster = screen.getByRole('switch', { name: 'Faster cards' }) as HTMLInputElement;
    expect(faster.checked).toBe(true);
    expect(faster.closest('.setting')!.querySelector('small')!.textContent).toBe(
      'Writes a card as soon as something worth one is said, using your OpenRouter key, and only while OpenRouter lists it as zero data retention.',
    );
    expect(screen.queryByText(/Jev/)).toBeNull();
    expect(screen.queryByLabelText('Jev threshold')).toBeNull();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'PUT', path: '/v1/console/settings', body: { changes: { cards_granularity: { value: 'fewer', expectedRevision: null } } } });
  });

  it('offers neither the join timings nor the Jev tuning thresholds anywhere, and never sends their stored values', async () => {
    show();
    await screen.findByLabelText('Join meetings on its own');
    for (const name of ['Meeting bot', 'Cards', 'Models', 'Retention', 'Connections']) {
      place(name);
      for (const label of ['Wait for a meeting to start', 'Wait in a waiting room', 'Leave after a silence of', 'Jev threshold', 'Link threshold', 'Card deadline']) {
        expect(screen.queryByLabelText(label), `${label} in ${name}`).toBeNull();
      }
    }
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
    place('Meeting bot');
    fireEvent.click(screen.getByLabelText('Join meetings on its own'));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(Object.keys((writes()[0]!.body as { changes: object }).changes)).toEqual(['auto_join_enabled']);
  });

  it('offers Skip the waiting room under Joining and the chat posts under In the meeting, as switches saved with the rest', async () => {
    show();
    const skip = (await screen.findByRole('switch', { name: 'Skip the waiting room' })) as HTMLInputElement;
    // The host and the waiting room stay beside Join meetings on its own.
    expect([...skip.closest('.block')!.querySelectorAll('[role="switch"]')].map((s) => s.closest('.setting')!.querySelector('label')!.textContent)).toEqual([
      'Join meetings on its own', 'Only once the host is there', 'Skip the waiting room',
    ]);
    const chat = screen.getByRole('switch', { name: 'Post to the meeting chat' }) as HTMLInputElement;
    expect([skip.checked, chat.checked]).toEqual([true, true]);
    expect(skip.closest('.block')!.querySelector('h4')!.textContent).toBe('Joining');
    expect(chat.closest('.block')!.querySelector('h4')!.textContent).toBe('In the meeting');
    expect(chat.closest('.setting')!.textContent).toContain('The hello, open items from last time, 5 minutes left and time up.');
    fireEvent.click(skip);
    fireEvent.click(chat);
    expect(within(bar()).getByText('2 changes')).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/v1/console/settings',
        body: { changes: { bypass_waiting_room: { value: false, expectedRevision: null }, chat_posts_enabled: { value: false, expectedRevision: null } } },
      },
    ]);
  });

  it('offers the agenda on joining as its own switch under In the meeting', async () => {
    show();
    const agenda = (await screen.findByRole('switch', { name: 'Post the agenda on joining' })) as HTMLInputElement;
    expect(agenda.checked).toBe(true);
    expect(agenda.closest('.block')!.querySelector('h4')!.textContent).toBe('In the meeting');
    expect(agenda.closest('.setting')!.textContent).toContain('A short summary of what is still open from last time, or the hello.');
    fireEvent.click(agenda);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ changes: { chat_agenda_enabled: { value: false, expectedRevision: null } } });
  });

  it('says automatic joining\'s state in one line and leaves its checks to the Overview', async () => {
    show();
    await screen.findByLabelText('Join meetings on its own');
    const box = document.querySelector('.setup')!;
    expect(box.className).toContain('warn');
    expect(box.querySelector('p')!.textContent).toBe('Automatic joining is waiting for setup.');
    expect(within(box as HTMLElement).getByRole('link', { name: 'See the checks on Overview' }).getAttribute('href')).toBe('#/');
    expect(document.querySelector('.checks')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recheck setup' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Meeting bot' }).querySelector('.dot')!.className).toBe('dot');
  });

  it('lights the Meeting bot dot once automatic joining is ready', async () => {
    autoJoin = READY;
    show();
    await screen.findByLabelText('Join meetings on its own');
    expect(document.querySelector('.setup')!.className).toBe('setup');
    expect(screen.getByRole('button', { name: 'Meeting bot' }).querySelector('.dot')!.className).toBe('dot ok');
  });
});

describe('keys and credentials', () => {
  const openConnections = async () => {
    await openPlace('Connections');
    return within(await screen.findByRole('region', { name: 'Zoom' }));
  };
  const openModels = async () => {
    await openPlace('Models');
    return within(await screen.findByRole('region', { name: 'Providers' }));
  };

  it('shows the Google sign-in card under Connections, after Zoom', async () => {
    await openConnections();
    const google = await screen.findByRole('region', { name: 'Google sign-in' });
    expect(await within(google).findByText(/^Google sign-in: set up/)).toBeTruthy();
  });

  it('lists only the providers that have a key, with its last four, and offers the rest under Add provider', async () => {
    const providers = await openModels();
    const openrouter = await providers.findByRole('group', { name: 'OpenRouter required' });
    expect(openrouter.textContent).toContain('Key ending wxyz');
    expect(openrouter.querySelector('.req')!.textContent).toBe('required');
    expect(within(openrouter).getByRole('button', { name: 'Remove' })).toBeTruthy();
    const deepgram = providers.getByRole('group', { name: 'Deepgram' });
    expect(deepgram.querySelector('.req')).toBeNull();
    expect(deepgram.textContent).toContain("Set by this install's environment, ending 22ab");
    expect(within(deepgram).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(providers.queryByRole('group', { name: 'OpenAI' })).toBeNull();
    // The rest wait under Other, Deepgram among them: transcription runs through OpenRouter by default.
    const other = providers.getByRole('heading', { name: 'Other' });
    expect(other.compareDocumentPosition(openrouter) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(other.compareDocumentPosition(deepgram) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const add = providers.getByLabelText('Add a provider') as HTMLSelectElement;
    expect([...add.options].map((o) => o.textContent)).toEqual(['Add provider…', 'OpenAI', 'Anthropic', 'Cerebras', 'Custom endpoint']);
    fireEvent.change(add, { target: { value: 'cerebras' } });
    expect(providers.getByLabelText('New Cerebras key')).toBeTruthy();
    expect(screen.queryByText(/never shows a key again|picks up a new key/)).toBeNull();
  });

  it('keeps a required provider listed while it has no key, for Add', async () => {
    keys = keys.map((k) => (k.provider === 'openrouter' ? { ...k, set: false, source: null, last4: null } : k));
    const providers = await openModels();
    const openrouter = await providers.findByRole('group', { name: 'OpenRouter required' });
    expect(openrouter.textContent).toContain('Not set');
    expect(within(openrouter).getByRole('button', { name: 'Add' })).toBeTruthy();
    expect([...(providers.getByLabelText('Add a provider') as HTMLSelectElement).options].map((o) => o.textContent)).not.toContain('OpenRouter');
  });

  it('takes a provider added without a key back off the list, on Cancel or on Remove, without writing anything', async () => {
    const providers = await openModels();
    await providers.findByRole('group', { name: 'OpenRouter required' });
    const add = () => providers.getByLabelText('Add a provider') as HTMLSelectElement;
    fireEvent.change(add(), { target: { value: 'cerebras' } });
    const cerebras = providers.getByRole('group', { name: 'Cerebras' });
    fireEvent.click(within(cerebras).getByRole('button', { name: 'Cancel' }));
    expect(providers.queryByRole('group', { name: 'Cerebras' })).toBeNull();
    expect([...add().options].map((o) => o.textContent)).toContain('Cerebras');
    fireEvent.change(add(), { target: { value: 'anthropic' } });
    const anthropic = providers.getByRole('group', { name: 'Anthropic' });
    // Closing the field leaves the row; Remove takes it off.
    fireEvent.click(within(anthropic).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(anthropic).getByRole('button', { name: 'Remove' }));
    expect(providers.queryByRole('group', { name: 'Anthropic' })).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('keeps a new provider listed while its key is saving: Cancel waits', async () => {
    const providers = await openModels();
    await providers.findByRole('group', { name: 'OpenRouter required' });
    fireEvent.change(providers.getByLabelText('Add a provider'), { target: { value: 'cerebras' } });
    const cerebras = providers.getByRole('group', { name: 'Cerebras' });
    fireEvent.change(within(cerebras).getByLabelText('New Cerebras key'), { target: { value: 'csk-new-key-c3b4' } });
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    fireEvent.click(within(cerebras).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect((within(cerebras).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    release();
  });

  it('rolls the new last four in only once the server has the key, then checks it with the provider', async () => {
    const providers = await openModels();
    const openrouter = await providers.findByRole('group', { name: 'OpenRouter required' });
    expect(within(openrouter).queryByLabelText('New OpenRouter key')).toBeNull();
    fireEvent.click(within(openrouter).getByRole('button', { name: 'Replace' }));
    expect(document.activeElement).toBe(within(openrouter).getByLabelText('New OpenRouter key'));
    fireEvent.change(within(openrouter).getByLabelText('New OpenRouter key'), { target: { value: 'sk-or-v1-new-key-n3w4' } });
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    fireEvent.click(within(openrouter).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(openrouter.querySelector('.digits.roll')).toBeNull();
    expect(openrouter.textContent).toContain('wxyz');
    release();
    await waitFor(() => expect(openrouter.querySelector('.digits.roll')?.textContent).toBe('n3w4'));
    expect([...openrouter.querySelectorAll('.digits.roll span')].map((e) => (e as HTMLElement).style.animationDelay)).toEqual(['0ms', '40ms', '80ms', '120ms']);
    expect(within(openrouter).queryByLabelText('New OpenRouter key')).toBeNull();
    await waitFor(() => expect(writes()).toEqual([
      { method: 'PUT', path: '/v1/console/model-keys/openrouter', body: { key: 'sk-or-v1-new-key-n3w4' } },
      { method: 'POST', path: '/v1/console/model-keys/openrouter/validate', body: {} },
    ]));
    // A passed check is a tick after the last four, its words in its tooltip.
    const tick = await within(openrouter).findByRole('img', { name: 'Check: the provider accepted this key.' });
    expect([tick.textContent, tick.title, tick.closest('small') !== null]).toEqual(['✓', 'Check: the provider accepted this key.', true]);
    expect(within(openrouter).queryByRole('status')).toBeNull();
  });

  it('puts Zoom, then Google sign-in under Connections', async () => {
    await openConnections();
    expect([...document.querySelectorAll('.settings-pane section')].map((s) => s.querySelector('h4')!.textContent)).toEqual(['Zoom', 'Google sign-in']);
    await within(screen.getByRole('region', { name: 'Zoom' })).findByRole('group', { name: 'Main app (the meeting bot)' });
  });

  it('connects Zoom one app at a time: what each has set, never more than its last four, its fields opened in place', async () => {
    await openConnections();
    const zoom = within(screen.getByRole('region', { name: 'Zoom' }));
    const main = await zoom.findByRole('group', { name: 'Main app (the meeting bot)' });
    const board = zoom.getByRole('group', { name: 'Board app (the board in Zoom)' });
    const s2s = zoom.getByRole('group', { name: 'Server-to-server app (optional)' });
    const summary = (app: HTMLElement) => app.querySelector('small')!.textContent;
    expect(summary(main)).toBe('Client ID and secret set, secret token not set · ending a81f');
    expect(summary(board)).toBe('Client secret ending 07be');
    expect(summary(s2s)).toBe('Not set: hosts allow recording when Zoom asks');
    // One button per app: Replace once all of its values are set, Add while one is missing.
    expect(within(board).getAllByRole('button').map((b) => b.textContent)).toEqual(['Replace']);
    expect(within(s2s).getAllByRole('button').map((b) => b.textContent)).toEqual(['Add']);
    expect(within(main).getAllByRole('button').map((b) => b.textContent)).toEqual(['Add']);
    expect(within(main).queryByLabelText('New Main app secret token')).toBeNull();
    fireEvent.click(within(main).getByRole('button', { name: 'Add' }));
    // The app's fields open in place, each saved on its own.
    expect(within(main).getByLabelText('New Main app client ID')).toBeTruthy();
    expect(within(main).getByLabelText('New Main app client secret')).toBeTruthy();
    fireEvent.change(within(main).getByLabelText('New Main app secret token'), { target: { value: 'whsec-very-secret-value' } });
    const token = within(main).getByRole('group', { name: 'Main app secret token' });
    fireEvent.click(within(token).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(token.querySelector('.digits.roll')?.textContent).toBe('alue'));
    expect(writes()).toEqual([{ method: 'PUT', path: '/v1/console/secrets/zoom.webhook_secret', body: { value: 'whsec-very-secret-value' } }]);
    expect(summary(main)).toBe('Client ID, secret and secret token all set · ending a81f');
    expect(main.querySelector('.secret-row > button')!.textContent).toBe('Replace');
    expect(main.textContent).not.toContain('whsec');
  });

  it('folds how to set the Zoom apps up, and where to find them, behind one closed disclosure', async () => {
    await openConnections();
    await screen.findByRole('group', { name: 'Main app (the meeting bot)' });
    const help = screen.getByText('How to set this up').closest('details')!;
    expect(help.open).toBe(false);
    expect(within(help).getByText(/zoom-manifest\.json/)).toBeTruthy();
    expect(within(help).getByText(/zoom-board-manifest\.json/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open your Zoom apps' }).map((a) => a.closest('details'))).toEqual([help]);
    expect(screen.getAllByText(/zoom-manifest\.json/)).toHaveLength(1);
  });

  it('shows how to set the Zoom apps up only once it knows what is set, never beside a failed read', async () => {
    answers['GET /v1/console/secrets'] = () => [500, { error: 'internal' }];
    await openConnections();
    expect(await screen.findByText("We couldn't load the Zoom credentials. Reload the page to try again.")).toBeTruthy();
    expect(screen.queryByText('How to set this up')).toBeNull();
  });

  it('drops how to set the Zoom apps up once all three are set', async () => {
    secrets = secrets.map((x) => ({ ...x, set: true, source: 'store' as const, last4: 'ab12' }));
    await openConnections();
    await screen.findByRole('group', { name: 'Main app (the meeting bot)' });
    expect(screen.queryByText('How to set this up')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open your Zoom apps' })).toBeNull();
  });
});

describe('Cards', () => {
  const openCards = () => openPlace('Cards');
  const shown = () => [...document.querySelectorAll('.mini > div')].filter((d) => !d.classList.contains('gone')).map((d) => d.textContent);

  it('folds one real moment into fewer or more cards as the slider moves, hiding the folded ones from screen readers', async () => {
    await openCards();
    expect(screen.getByText(/The service restarted mid-release and everyone's sessions froze/)).toBeTruthy();
    expect(shown()).toEqual(['To-doMove releases to a blue-green rollout', "RiskA restart mid-release freezes everyone's sessions"]);
    expect(screen.queryByLabelText('Word')).toBeNull();
    const grouping = screen.getByRole('slider', { name: 'Card grouping' });
    fireEvent.change(grouping, { target: { value: '0' } });
    expect(shown()).toEqual([
      'To-doMove releases to a blue-green rolloutKeep the old instance up while the new one starts, switch everyone over, then turn it off. Sessions froze on the last restart.',
    ]);
    fireEvent.change(grouping, { target: { value: '2' } });
    expect(shown()).toHaveLength(4);
    expect([...document.querySelectorAll('.mini > div.gone')].every((d) => d.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect([...document.querySelectorAll('.mini > div:not(.gone)')].some((d) => d.hasAttribute('aria-hidden'))).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('keeps the Dictionary at the foot of Cards, with its own save beside the page\'s', async () => {
    await openCards();
    const dictionary = await screen.findByRole('region', { name: 'Dictionary' });
    const pane = document.querySelector('.settings-pane')!;
    const blocks = [...pane.querySelectorAll(':scope > .block')];
    expect(blocks.at(-1)).toBe(dictionary);
    expect(within(dictionary).getByText('Manage preferred spellings and common transcription mistakes.')).toBeTruthy();
    expect(await within(dictionary).findByRole('button', { name: 'Reload dictionary' })).toBeTruthy();
    expect(within(dictionary).getByRole('button', { name: 'Save dictionary' })).toBeTruthy();
    place('Retention');
    expect(screen.queryByRole('region', { name: 'Dictionary' })).toBeNull();
  });

  it('leaves every model to Models: Cards neither reads nor names the card writer, the Jev model or a key', async () => {
    await openCards();
    expect(screen.getByRole('switch', { name: 'Faster cards' })).toBeTruthy();
    expect(calls.some((c) => /cards-model|model-keys/.test(c.path))).toBe(false);
    expect(screen.queryByText(/Card writer|OpenRouter key:|Jev model/)).toBeNull();
  });
});

describe('Models', () => {
  const openModels = () => openPlace('Models');

  it('holds the card writer, the Jev model and the providers, in that order, and nothing else, under its title alone', async () => {
    await openModels();
    expect(screen.getByRole('heading', { name: 'Models' })).toBeTruthy();
    expect(screen.queryByText('Which models bwat uses, and the keys it uses them with.')).toBeNull();
    expect([...document.querySelectorAll('.settings-pane section')].map((s) => s.querySelector('h4')!.textContent)).toEqual(['Card writer', 'Jev', 'Providers']);
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/console/cards-model')).toBe(true));
    expect(await within(screen.getByRole('region', { name: 'Providers' })).findByRole('group', { name: 'OpenRouter required' })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Card grouping' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Zoom' })).toBeNull();
  });

  it('keeps the card writer model behind Change model', async () => {
    answers['GET /v1/console/cards-model'] = () => [200, { endpoint: 'openrouter', host: 'openrouter.ai', model: 'anthropic/claude-sonnet-5', default: 'anthropic/claude-sonnet-5', saved: false, elsewhere: null, revision: null, listed: true, paused: null, suggestions: [{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', price: null }] }];
    await openModels();
    const writer = await screen.findByRole('region', { name: 'Card writer' });
    expect(await within(writer).findByRole('button', { name: 'Change model' })).toBeTruthy();
    expect(within(writer).queryByLabelText('Card writer model')).toBeNull();
  });

  it('saves the Jev model with the save bar, as before', async () => {
    await openModels();
    const jev = screen.getByLabelText('Jev model') as HTMLInputElement;
    expect(jev.placeholder).toBe('e.g. typesafe/jev-1.13');
    const block = jev.closest('section')!;
    expect(block.querySelector('h4')!.textContent).toBe('Jev');
    // Card writer and Providers save on their own buttons; this one waits for the bar.
    expect(block.textContent).toContain('while Faster cards is on in Cards. A change here saves with the bar below, not with Save model.');
    fireEvent.change(jev, { target: { value: 'typesafe/jev-2' } });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'PUT', path: '/v1/console/settings', body: { changes: { jev_model: { value: 'typesafe/jev-2', expectedRevision: null } } } });
  });

  it('names Models when the Jev model changed elsewhere', async () => {
    answers['PUT /v1/console/settings'] = () => [409, { error: 'stale', currentRevisions: { jev_model: 3 } }];
    await openModels();
    fireEvent.change(screen.getByLabelText('Jev model'), { target: { value: 'typesafe/jev-2' } });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Nothing was saved. Models changed elsewhere: reload to see it.')).toBeTruthy();
  });

  it('opens on Models from a link; a member has no Models and lands on Meeting bot', async () => {
    window.location.hash = '#/settings?place=models';
    try {
      show();
      const nav = await screen.findByRole('navigation', { name: 'Settings pages' });
      expect(within(nav).getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('page');
      cleanup();
      show('member');
      const member = await screen.findByRole('navigation', { name: 'Settings pages' });
      expect(within(member).queryByRole('button', { name: 'Models' })).toBeNull();
      expect(within(member).getByRole('button', { name: 'Meeting bot' }).getAttribute('aria-current')).toBe('page');
    } finally {
      window.location.hash = '';
    }
  });
});
