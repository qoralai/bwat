// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { makeQueryClient } from './api';

/* Automatic joining's four checks and Recheck setup, on the Overview. */

type AutoJoin = { requested: boolean; effective: boolean; ready: boolean; problems: string[]; notices?: string[]; lastEventAt: string | null };
const EVENTS = 'Waiting for a verified meeting event from this Zoom account. Check the main app’s event subscription.';
const CREDENTIALS = 'Set the main Zoom app’s Meeting SDK client ID and client secret.';
const waiting = (...problems: string[]): AutoJoin => ({ requested: true, effective: false, ready: false, problems, lastEventAt: null });
const READY: AutoJoin = { requested: true, effective: true, ready: true, problems: [], lastEventAt: '2026-10-19T09:00:00Z' };

let autoJoin: AutoJoin;
/** While set, a read of `gatePath` waits for it: the checks must not light before the recheck answers. */
let gate: Promise<void> | null;
let gatePath: string | null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function show() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://bwat.test').pathname;
    if (gate && path === gatePath) await gate;
    if (path === '/whoami') return json(200, { member: { id: 'a', email: 'ada@example.com', display_name: 'Ada', role: 'owner' }, id_token: 't' });
    if (path === '/v1/console/settings') return json(200, { settingsVersion: 1, canManage: true, settings: {}, autoJoin });
    if (path === '/v1/fleet') return json(200, { fleet: [] });
    if (path === '/v1/allocations') return json(200, { allocations: [] });
    if (path === '/v1/meetings') return json(200, { meetings: [], next_cursor: null });
    if (path === '/v1/setup-checklist') return json(200, { items: [] });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  window.location.hash = '#/';
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  autoJoin = waiting(EVENTS);
  gate = null;
  gatePath = null;
});
afterEach(cleanup);

describe('the checks light up in turn', () => {
  const checks = () => [...document.querySelectorAll('.checks li')];
  const box = () => document.querySelector('.overview .setup')!;

  it('lists what Recheck setup checks, each failing one grey with what to fix, and one only waiting as not seen yet', async () => {
    autoJoin = waiting(CREDENTIALS, EVENTS);
    show();
    await screen.findByRole('button', { name: 'Recheck setup' });
    expect(box().className).toContain('warn');
    expect(box().textContent).toContain('Automatic joining is waiting for setup.');
    expect(checks().map((li) => li.querySelector('.name')!.textContent)).toEqual([
      'Main Zoom app credentials', 'Meeting events from Zoom', 'Zoom account access', 'A meeting bot is ready',
    ]);
    expect(checks().map((li) => li.querySelector('.dot')!.className)).toEqual(['dot', 'dot', 'dot ok', 'dot ok']);
    expect(checks()[0]!.textContent).toContain(CREDENTIALS);
    // No meeting event has arrived yet: nothing has failed, so the server's sentence is not shown.
    expect(checks()[1]!.querySelector('small')!.textContent).toBe('Not seen yet');
    expect(checks()[1]!.textContent).not.toContain(EVENTS);
    expect(checks().every((li) => li.querySelector('.dot')!.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(screen.queryByText(/Meeting SDK credentials are checked for presence/)).toBeNull();
  });

  it('greys A meeting bot is ready while no bot has checked in', async () => {
    autoJoin = waiting('No ready bot has checked in recently. Start or repair the meeting bot.');
    show();
    await screen.findByRole('button', { name: 'Recheck setup' });
    expect(checks().map((li) => li.querySelector('.dot')!.className)).toEqual(['dot ok', 'dot ok', 'dot ok', 'dot']);
    expect(checks()[3]!.textContent).toContain('Start or repair the meeting bot.');
    expect(document.querySelector('.other-problems')).toBeNull();
  });

  it.each([
    'Set the Zoom server-to-server account ID, client ID and client secret.',
    'Zoom did not report the granted permissions, so automatic joining setup could not be verified. Check the server-to-server app and retry.',
    'Add meeting:read:meeting:admin to the Zoom server-to-server app.',
    'Add meeting:read:local_recording_token:admin to the Zoom server-to-server app.',
    'Zoom could not verify account access. Check that the server-to-server app is activated and its credentials are correct, then retry.',
    'Zoom is temporarily unavailable. Automatic joining setup could not be checked. Try again shortly.',
  ])('greys Zoom account access while the server-to-server app fails: %s', async (problem) => {
    autoJoin = waiting(problem);
    show();
    await screen.findByRole('button', { name: 'Recheck setup' });
    expect(checks().map((li) => li.querySelector('.dot')!.className)).toEqual(['dot ok', 'dot ok', 'dot', 'dot ok']);
    expect(checks()[2]!.textContent).toContain(problem);
  });

  it("shows the server-to-server app's advice under Zoom account access, which still passes", async () => {
    const advice = 'Add user:read:user:admin to the Zoom server-to-server app, so bwat can link a person’s Zoom account to their bwat account by email.';
    autoJoin = { ...READY, notices: [advice] };
    show();
    await screen.findByRole('button', { name: 'Recheck setup' });
    expect(box().className).not.toContain('warn');
    expect(checks().map((li) => li.querySelector('.dot')!.className)).toEqual(['dot ok', 'dot ok', 'dot ok', 'dot ok']);
    expect(checks()[2]!.textContent).toContain(advice);
    expect(checks().filter((li) => li.textContent!.includes(advice))).toHaveLength(1);
  });

  it('lights only the checks that changed, 120ms apart, once the recheck returns, and then reads ready', async () => {
    autoJoin = waiting(CREDENTIALS, EVENTS, 'Automatic joining is disabled by this installation’s environment.');
    show();
    await screen.findByRole('button', { name: 'Recheck setup' });
    expect(screen.getByText('Automatic joining is disabled by this installation’s environment.')).toBeTruthy();
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    gatePath = '/v1/console/settings';
    autoJoin = READY;
    fireEvent.click(screen.getByRole('button', { name: 'Recheck setup' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Checking setup…' })).toBeTruthy());
    expect(document.querySelector('.checks .lit')).toBeNull();
    expect(box().className).toContain('warn');
    release();
    // The dots light first; the box keeps its words and colour until the last one has.
    await waitFor(() => expect(document.querySelector('.checks .lit')).toBeTruthy());
    expect(box().textContent).toContain('Automatic joining is waiting for setup.');
    expect(box().className).toContain('warn');
    await waitFor(() => expect(box().textContent).toContain('Automatic joining is ready for meetings in your Zoom account.'));
    expect(box().className).not.toContain('warn');
    const lit = [...document.querySelectorAll('.checks .dot.lit')] as HTMLElement[];
    expect(lit.map((d) => d.closest('li')!.querySelector('.name')!.textContent)).toEqual(['Main Zoom app credentials', 'Meeting events from Zoom']);
    expect(lit.map((d) => d.style.animationDelay)).toEqual(['0ms', '120ms']);
    expect(checks().map((li) => li.querySelector('.dot')!.className)).toEqual(['dot ok lit', 'dot ok lit', 'dot ok', 'dot ok']);
  });
});
