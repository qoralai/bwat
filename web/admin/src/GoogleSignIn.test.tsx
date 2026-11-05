// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from './api';
import { GoogleSignIn, type GoogleSignInRead } from './GoogleSignIn';

/* The Google sign-in card in Settings, Connections. */

const SELF_HOSTED: GoogleSignInRead = {
  signIn: 'google',
  configured: true,
  webClientIds: ['web-client.apps.googleusercontent.com'],
  pluginClient: { id: 'plugin-client.apps.googleusercontent.com', secret: { set: true, last4: 'PS42' } },
  domains: { effective: ['example.com'], env: ['example.com'], saved: null, revision: null, updatedAt: null },
};

let read: GoogleSignInRead;
let puts: unknown[];
let refuse: { status: number; body: object } | null;
beforeEach(() => {
  read = structuredClone(SELF_HOSTED);
  puts = [];
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    if (input === '/whoami') return Response.json({ member: { id: 'ada', email: 'ada@example.com', role: 'owner', display_name: 'Ada' }, id_token: 't' });
    if (input === '/v1/console/google-signin/domains' && init.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { domains: string[] | null };
      puts.push(body);
      if (refuse) return Response.json(refuse.body, { status: refuse.status });
      const saved = body.domains;
      read = { ...read, domains: { ...read.domains, saved, effective: saved ?? read.domains.env, revision: (read.domains.revision ?? 0) + 1 } };
      return Response.json(read);
    }
    if (input === '/v1/console/google-signin') return Response.json(read);
    return Response.json({}, { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const show = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <GoogleSignIn />
    </QueryClientProvider>,
  );
/** The card once its read has answered: more than its heading. */
const card = async () => {
  const c = await screen.findByRole('region', { name: 'Google sign-in' });
  await waitFor(() => expect(c.textContent).not.toBe('Google sign-in'));
  return c;
};

it('says it is set up in one line, then the allowed domains, and nothing about its clients', async () => {
  show();
  const c = await card();
  expect(within(c).getByText((_, el) => el?.className === 'google-line' && el.textContent === 'Google sign-in: set up ✓')).toBeTruthy();
  expect(within(c).getByRole('textbox', { name: 'Allowed email domains' })).toBeTruthy();
  expect(c.textContent).not.toContain('web-client.apps.googleusercontent.com');
  expect(c.textContent).not.toContain('PS42');
  expect(c.textContent).not.toContain('./bwat setup');
});

it.each([
  ['its client ID', { id: null, secret: { set: true, last4: 'PS42' } }, 'Plugin client ID'],
  ['its secret', { id: 'plugin-client.apps.googleusercontent.com', secret: { set: false, last4: null } }, 'Plugin client secret'],
])('says the plugin sign-in is not set up, and what is missing, while the plugin client lacks %s', async (_, pluginClient, missing) => {
  read = { ...read, pluginClient };
  show();
  const c = await card();
  expect(c.querySelector('.google-line')).toBeNull();
  expect(within(c).getByText('Plugin sign-in not set up')).toBeTruthy();
  const row = within(c).getByText(missing).closest('.google-row')!;
  expect(row.textContent).toContain('Not set');
  expect(within(c).getByRole('textbox', { name: 'Allowed email domains' })).toBeTruthy();
});

it('says what is missing when Google sign-in is not set up: both client ids, the plugin secret only as its last four, and where they are set', async () => {
  read = { ...read, configured: false, webClientIds: [] };
  show();
  const c = await card();
  expect(within(c).getByText('Not set up')).toBeTruthy();
  expect(within(c).getByText('Not set')).toBeTruthy();
  expect(within(c).getByText('plugin-client.apps.googleusercontent.com')).toBeTruthy();
  expect(c.textContent).toContain('Set, ending PS42');
  expect(c.textContent).toContain('If they are set in your infrastructure, ask whoever manages this install.');
  expect(c.textContent).toContain('./bwat setup');
});

it('saves a list of domains over the install one, and Use the install list clears it', async () => {
  show();
  const box = (await screen.findByRole('textbox', { name: 'Allowed email domains' })) as HTMLInputElement;
  expect(box.value).toBe('example.com');
  fireEvent.change(box, { target: { value: 'example.com, newco.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save domains' }));
  await waitFor(() => expect(puts).toEqual([{ domains: ['example.com', 'newco.com'], expectedRevision: null }]));
  expect(await screen.findByText(/Saved here\. It replaces/)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Saved.');
  expect(box.value).toBe('example.com, newco.com');

  fireEvent.click(screen.getByRole('button', { name: 'Use the install list' }));
  await waitFor(() => expect(puts.at(-1)).toEqual({ domains: null, expectedRevision: 1 }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Use the install list' })).toBeNull());
  // The button that was pressed is gone: focus stays in the card, on the field, which shows the install's list.
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe('example.com');
});

it("never rereads behind an edit: a save keeps the revision it was read at, so another admin's change is refused, not dropped", async () => {
  let reads = 0;
  const served = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input === '/v1/console/google-signin' && (init?.method ?? 'GET') === 'GET') reads += 1;
    return (served as (i: string, n?: RequestInit) => Promise<Response>)(input, init);
  }));
  show();
  const box = await screen.findByRole('textbox', { name: 'Allowed email domains' });
  // Another admin saves meanwhile, then this tab is focused again.
  read = { ...read, domains: { ...read.domains, saved: ['example.com', 'b.example'], effective: ['example.com', 'b.example'], revision: 7 } };
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  fireEvent.change(box, { target: { value: 'example.com, c.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save domains' }));
  await waitFor(() => expect(puts.at(-1)).toEqual({ domains: ['example.com', 'c.example'], expectedRevision: null }));
  expect(reads).toBe(1);
});

it("says plainly why a save was refused, in the server's words", async () => {
  refuse = { status: 400, body: { error: 'own_domain_missing', message: 'Keep example.com in the list: it is your own email domain. Nothing was saved.' } };
  show();
  const box = await screen.findByRole('textbox', { name: 'Allowed email domains' });
  fireEvent.change(box, { target: { value: 'newco.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save domains' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Keep example.com in the list: it is your own email domain. Nothing was saved.');
});

it('says a local install signs in with its code and does not use Google', async () => {
  read = { ...read, signIn: 'code', configured: false };
  show();
  const c = await card();
  expect(c.textContent).toContain('People sign in with this install’s code. Google sign-in isn’t used.');
  expect(c.textContent).toContain('./bwat setup --tier team');
  expect(within(c).queryByRole('textbox')).toBeNull();
  expect(within(c).queryByText('web-client.apps.googleusercontent.com')).toBeNull();
});
