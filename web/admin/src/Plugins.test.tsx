// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';

// A plugin's own setup card, from the admin registry (pluginSetup.ts), here a probe's.
vi.mock('./pluginSetup', () => ({ PLUGIN_SETUP: { polls: () => <p>Polls setup card</p> } }));

type Row = { name: string; display_name: string; description: string; on: boolean; needs: { env: string; to: string } | null };
let role: 'admin' | 'member';
let rows: Row[];
let holds: Record<string, string | null>;
let writes: { name: string; on: boolean }[];
beforeEach(() => {
  role = 'admin';
  rows = [
    { name: 'shelves', display_name: 'Shelves', description: 'Group cards on shelves.', on: true, needs: null },
    { name: 'polls', display_name: 'Polls', description: 'Run quick polls.', on: false, needs: null },
    { name: 'framed', display_name: 'Framed', description: 'Opens the board in a frame.', on: false, needs: { env: 'BWAT_FRAME_ANCESTORS', to: 'allow Framed to frame the board' } },
  ];
  holds = { shelves: '3 shelves and the tags on 21 cards', polls: null, framed: null };
  writes = [];
  window.location.hash = '#/plugins';
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    if (input === '/whoami') return Response.json({ member: { id: 'ada', email: 'ada@example.com', role, display_name: 'Ada' }, id_token: 'test' });
    const held = input.match(/^\/v1\/console\/plugins\/([a-z]+)\/holds$/);
    if (held) return Response.json({ holds: holds[held[1]!] });
    const one = input.match(/^\/v1\/console\/plugins\/([a-z]+)$/);
    if (one && init.method === 'PUT') {
      const { on } = JSON.parse(String(init.body)) as { on: boolean };
      writes.push({ name: one[1]!, on });
      rows = rows.map((r) => (r.name === one[1] ? { ...r, on } : r));
    }
    if (input === '/v1/console/plugins' || one) return Response.json({ canManage: role === 'admin', plugins: rows });
    return Response.json({}, { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function show() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App />
    </QueryClientProvider>,
  );
}
const row = async (name: string) => (await screen.findByRole('switch', { name })).closest('.plugin') as HTMLElement;

it('lists every shipped plugin with what it adds and a switch, in its own tab after Settings', async () => {
  show();
  const tabs = (await screen.findAllByRole('link')).map((a) => a.textContent);
  expect(tabs.indexOf('Plugins')).toBe(tabs.indexOf('Settings') + 1);
  expect((await screen.findByRole('switch', { name: 'Shelves' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('switch', { name: 'Polls' }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText('Group cards on shelves.')).toBeTruthy();
});

it('a plugin that needs setup says what the operator must set, and its switch stays off', async () => {
  show();
  const framed = await row('Framed');
  expect(within(framed).getByText('Needs setup')).toBeTruthy();
  expect(within(framed).getByText(/needs to allow Framed to frame the board/).textContent).toContain('BWAT_FRAME_ANCESTORS');
  expect((within(framed).getByRole('switch') as HTMLInputElement).disabled).toBe(true);
});

it('turns a plugin on at once', async () => {
  show();
  fireEvent.click(await screen.findByRole('switch', { name: 'Polls' }));
  expect(await within(await row('Polls')).findByText('On')).toBeTruthy();
  expect(writes).toEqual([{ name: 'polls', on: true }]);
});

it('a plugin that holds nothing turns off at once', async () => {
  rows = rows.map((r) => (r.name === 'polls' ? { ...r, on: true } : r));
  show();
  fireEvent.click(await screen.findByRole('switch', { name: 'Polls' }));
  expect(await within(await row('Polls')).findByText('Off')).toBeTruthy();
  expect(writes).toEqual([{ name: 'polls', on: false }]);
});

it('a plugin that holds data asks first, inline, and keeps it on if told to', async () => {
  show();
  fireEvent.click(await screen.findByRole('switch', { name: 'Shelves' }));
  const shelves = await row('Shelves');
  expect(
    (await within(shelves).findByText(/^Turn off Shelves\?/)).textContent,
  ).toBe('Turn off Shelves? Its 3 shelves and the tags on 21 cards disappear from the board until you turn it back on. Nothing is deleted.');
  fireEvent.click(within(shelves).getByRole('button', { name: 'Keep it on' }));
  expect(within(shelves).queryByText(/^Turn off Shelves\?/)).toBeNull();
  expect(writes).toEqual([]);

  fireEvent.click(screen.getByRole('switch', { name: 'Shelves' }));
  fireEvent.click(await within(shelves).findByRole('button', { name: 'Turn off' }));
  expect(await within(shelves).findByText('Off')).toBeTruthy();
  expect(writes).toEqual([{ name: 'shelves', on: false }]);
});

it('a member sees which are on, read only', async () => {
  role = 'member';
  show();
  expect(await screen.findByText('is on.', { exact: false })).toBeTruthy();
  expect(screen.getByText('Polls and Framed are off.')).toBeTruthy();
  expect(screen.getByText('Only an owner or an admin changes these.')).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('moves focus into the check as it appears and back to the switch once it is answered', async () => {
  show();
  const shelves = await screen.findByRole('switch', { name: 'Shelves' });
  shelves.focus();
  fireEvent.click(shelves);
  const keep = await screen.findByRole('button', { name: 'Keep it on' });
  await waitFor(() => expect(document.activeElement).toBe(keep));
  expect(screen.getByRole('group', { name: 'Turn off Shelves' }).getAttribute('aria-describedby')).toBeTruthy();
  fireEvent.click(keep);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Shelves' })));

  fireEvent.click(screen.getByRole('switch', { name: 'Shelves' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Shelves' })));
});

it('says why a switch that needs setup is off', async () => {
  show();
  const framed = await screen.findByRole('switch', { name: 'Framed' });
  const described = (framed.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  expect(described).toContain('BWAT_FRAME_ANCESTORS');
});

it("shows a plugin's own setup card under it once it is on, to an owner or admin", async () => {
  show();
  const polls = await row('Polls');
  expect(within(polls).queryByText('Polls setup card')).toBeNull();
  fireEvent.click(screen.getByRole('switch', { name: 'Polls' }));
  expect(await within(await row('Polls')).findByText('Polls setup card')).toBeTruthy();
  // A plugin with no setup card shows none.
  expect(within(await row('Shelves')).queryByText(/setup card/)).toBeNull();
});

it("shows no plugin's setup card to a member", async () => {
  role = 'member';
  rows = rows.map((r) => (r.name === 'polls' ? { ...r, on: true } : r));
  show();
  expect(await screen.findByText('Only an owner or an admin changes these.')).toBeTruthy();
  expect(screen.queryByText('Polls setup card')).toBeNull();
});
