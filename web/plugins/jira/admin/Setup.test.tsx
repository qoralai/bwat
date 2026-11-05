// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../../../admin/src/App';

/* The jira plugin's setup card on the panel's Plugins page: Jira as one connection. */

type Setting = { value: unknown; revision: number | null };
type Secret = { name: string; set: boolean; source: 'store' | 'env' | null; last4: string | null };
type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let settings: Record<string, Setting>;
let secrets: Secret[];
let enabled: boolean;
let on: boolean;
/** Answers for one path, in place of the default one. */
let answers: Record<string, () => [number, unknown]>;
/** While set, a write to `gatePath` waits for it. */
let gate: Promise<void> | null;
let gatePath: string | null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unset = (): Setting => ({ value: null, revision: null });

beforeEach(() => {
  calls = [];
  settings = { jira_site_url: unset(), jira_project_key: unset(), jira_account_email: unset() };
  secrets = [{ name: 'zoom.client_id', set: true, source: 'store', last4: 'c1d0' }, { name: 'jira.api_token', set: false, source: null, last4: null }];
  enabled = false;
  on = true;
  answers = {};
  gate = null;
  gatePath = null;
  window.location.hash = '#/plugins';
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(String(input), 'http://bwat.test').pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (gate && path === gatePath) await gate;
    const special = answers[`${method} ${path}`];
    if (special) return json(...special());
    if (path === '/whoami') return json(200, { member: { id: 'a', email: 'ada@example.com', display_name: 'Ada', role: 'owner' }, id_token: 't' });
    if (path === '/v1/console/plugins') {
      return json(200, { canManage: true, plugins: [{ name: 'jira', display_name: 'Jira', description: 'File a to-do or a risk in Jira Cloud with one press.', on, needs: null }] });
    }
    if (path === '/v1/console/plugins/jira/settings' && method === 'PUT') {
      // Each saved key moves to the next revision, as the backend's does.
      for (const [key, change] of Object.entries((body as { changes: Record<string, { value: unknown; expectedRevision: number | null }> }).changes)) {
        settings = { ...settings, [key]: { value: change.value, revision: (change.expectedRevision ?? 0) + 1 } };
      }
    }
    if (path === '/v1/console/plugins/jira/settings') return json(200, { canManage: true, settings });
    if (path === '/v1/plugins/jira/status') return json(200, { enabled });
    if (path === '/v1/plugins/jira/check') return json(200, { result: 'connected' });
    if (path === '/v1/console/secrets') return json(200, { secrets });
    const secret = /^\/v1\/console\/secrets\/([\w.]+)$/.exec(path);
    if (secret) {
      // As the backend's: Jira is enabled once all four values are set, before any check.
      enabled = method === 'PUT';
      const next = method === 'PUT'
        ? { name: secret[1]!, set: true, source: 'store' as const, last4: (body as { value: string }).value.slice(-4) }
        : { name: secret[1]!, set: false, source: null, last4: null };
      secrets = secrets.map((x) => (x.name === next.name ? next : x));
      return json(200, next);
    }
    return json(404, { error: 'not_found' });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const writes = () => calls.filter((c) => c.method !== 'GET');
const stored = (site: string, project: string, email: string | null, token: Partial<Secret>) => {
  enabled = true;
  settings = { jira_site_url: { value: site, revision: 3 }, jira_project_key: { value: project, revision: 3 }, jira_account_email: { value: email, revision: email ? 3 : null } };
  secrets = secrets.map((x) => (x.name === 'jira.api_token' ? { ...x, set: true, ...token } : x));
};
const openJira = async () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App />
    </QueryClientProvider>,
  );
  return within(await screen.findByRole('region', { name: 'Jira' }));
};

describe("the jira plugin's setup card", () => {
  it('sits under the plugin on the Plugins page while it is on, and not while it is off', async () => {
    const jira = await openJira();
    expect(screen.getByRole('switch', { name: 'Jira' }).closest('.plugin')!.contains(jira.getByText('Not connected'))).toBe(true);
    cleanup();
    on = false;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole('switch', { name: 'Jira' });
    expect(screen.queryByRole('region', { name: 'Jira' })).toBeNull();
  });

  it('links the Atlassian API token page, opening in a new tab', async () => {
    const jira = await openJira();
    fireEvent.click(await jira.findByRole('button', { name: 'Connect Jira' }));
    const link = jira.getByRole('link', { name: 'https://id.atlassian.com/manage-profile/security/api-tokens' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it("connects with one card: saves the plugin's settings and its token, then checks with Jira before the dot lights", async () => {
    const jira = await openJira();
    expect(await jira.findByText('Not connected')).toBeTruthy();
    expect(jira.getByText('Connect to give cards a Route to Jira button.')).toBeTruthy();
    expect(jira.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    fireEvent.click(jira.getByRole('button', { name: 'Connect Jira' }));
    expect(document.activeElement).toBe(jira.getByLabelText('Jira site'));
    fireEvent.change(jira.getByLabelText('Jira site'), { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(jira.getByLabelText('Project key'), { target: { value: 'ABC' } });
    fireEvent.change(jira.getByLabelText('Account email'), { target: { value: 'ops@acme.test' } });
    fireEvent.change(jira.getByLabelText('API token'), { target: { value: 'atlassian-token-4f2a' } });
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    gatePath = '/v1/plugins/jira/check';
    fireEvent.click(jira.getByRole('button', { name: 'Check and connect' }));
    expect(await jira.findByText('Checking…')).toBeTruthy();
    await waitFor(() => expect(writes()).toHaveLength(3));
    const route = document.querySelector('.routebtn')!;
    expect(route.className).not.toContain('in');
    release();
    expect(await jira.findByText('Connected to ABC')).toBeTruthy();
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/v1/console/plugins/jira/settings',
        body: {
          changes: {
            jira_site_url: { value: 'https://acme.atlassian.net', expectedRevision: null },
            jira_project_key: { value: 'ABC', expectedRevision: null },
            jira_account_email: { value: 'ops@acme.test', expectedRevision: null },
          },
        },
      },
      { method: 'PUT', path: '/v1/console/secrets/jira.api_token', body: { value: 'atlassian-token-4f2a' } },
      { method: 'POST', path: '/v1/plugins/jira/check', body: {} },
    ]);
    await waitFor(() => expect(document.querySelector('.jira .digits.roll')?.textContent).toBe('4f2a'));
    expect(document.querySelector('.jira .secret-row small')!.textContent).toBe('acme.atlassian.net · as ops@acme.test · token ending 4f2a');
    expect(document.querySelector('.jira .dot')!.className).toBe('dot ok breathe');
    expect(route.className).toContain('in');
    expect(route.textContent).toBe('Route to Jira · ABC');
    expect(jira.getByRole('status').textContent).toBe('Connected to ABC');
    expect(document.activeElement).toBe(jira.getByRole('button', { name: 'Replace token' }));
  });

  it('forgets a typed token on Cancel, so reopening the form starts empty', async () => {
    const jira = await openJira();
    fireEvent.click(await jira.findByRole('button', { name: 'Connect Jira' }));
    fireEvent.change(jira.getByLabelText('API token'), { target: { value: 'atlassian-token-4f2a' } });
    fireEvent.click(jira.getByRole('button', { name: 'Cancel' }));
    // The form closes: focus goes back to the button that opened it.
    await waitFor(() => expect(document.activeElement).toBe(jira.getByRole('button', { name: 'Connect Jira' })));
    fireEvent.click(jira.getByRole('button', { name: 'Connect Jira' }));
    expect((jira.getByLabelText('API token') as HTMLInputElement).value).toBe('');
  });

  it('says what is wrong before it saves, and why when Jira refuses; the dot stays grey', async () => {
    answers['POST /v1/plugins/jira/check'] = () => [200, { result: 'refused' }];
    const jira = await openJira();
    fireEvent.click(await jira.findByRole('button', { name: 'Connect Jira' }));
    fireEvent.change(jira.getByLabelText('Jira site'), { target: { value: 'https://jira.example.com' } });
    expect(jira.getByText("Jira site address must be your Jira site's address, like https://yourcompany.atlassian.net.")).toBeTruthy();
    fireEvent.change(jira.getByLabelText('Jira site'), { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(jira.getByLabelText('Project key'), { target: { value: 'abc' } });
    expect(jira.getByText('Jira project key must be a Jira project key, like ABC.')).toBeTruthy();
    expect((jira.getByRole('button', { name: 'Check and connect' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(jira.getByLabelText('Project key'), { target: { value: 'ABC' } });
    fireEvent.change(jira.getByLabelText('Account email'), { target: { value: 'ops@acme.test' } });
    fireEvent.change(jira.getByLabelText('API token'), { target: { value: 'atlassian-token-bad1' } });
    fireEvent.click(jira.getByRole('button', { name: 'Check and connect' }));
    expect(await jira.findByText('Jira refused this token.', { selector: 'small' })).toBeTruthy();
    expect(jira.getByRole('status').textContent).toBe('Jira refused this token.');
    expect(document.activeElement).toBe(jira.getByRole('button', { name: 'Connect Jira' }));
    expect(document.querySelector('.jira .dot')!.className).toBe('dot');
    expect(document.querySelector('.routebtn')!.className).not.toContain('in');
  });

  it('asks Jira again on a fresh page, says it is not connected when Jira refuses what is stored, and Disconnect takes the wrong token away', async () => {
    answers['POST /v1/plugins/jira/check'] = () => [200, { result: 'refused' }];
    stored('https://acme.atlassian.net', 'ABC', null, { source: 'store', last4: 'bad1' });
    const jira = await openJira();
    expect(await jira.findByText('Jira refused this token.', { selector: 'small' })).toBeTruthy();
    fireEvent.click(await jira.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(writes().at(-1)).toEqual({ method: 'DELETE', path: '/v1/console/secrets/jira.api_token', body: undefined }));
  });

  it('offers no Disconnect for a token set by the install’s environment', async () => {
    stored('https://acme.atlassian.net', 'ABC', null, { source: 'env', last4: '4f2a' });
    const jira = await openJira();
    expect(await jira.findByText('Connected to ABC')).toBeTruthy();
    expect(jira.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('does not claim Jira is not connected when the check itself fails', async () => {
    answers['POST /v1/plugins/jira/check'] = () => [503, { error: 'unavailable' }];
    stored('https://acme.atlassian.net', 'ABC', null, { source: 'store', last4: '4f2a' });
    const jira = await openJira();
    expect(await jira.findByText("Couldn't check Jira just now.")).toBeTruthy();
    expect(jira.queryByText('Not connected')).toBeNull();
    expect(await jira.findByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('shows a connection already made, without moving, and Disconnect takes the token away', async () => {
    stored('https://acme.atlassian.net', 'ABC', 'ops@acme.com', { source: 'store', last4: '4f2a' });
    const jira = await openJira();
    expect(await jira.findByText('Connected to ABC')).toBeTruthy();
    expect(document.querySelector('.jira')!.className).not.toContain('fresh');
    expect(document.querySelector('.jira .dot')!.className).toBe('dot ok');
    expect(document.querySelector('.jira .digits.roll')).toBeNull();
    expect(document.querySelector('.routebtn')!.className).toContain('in');
    expect(document.querySelector('.jira .secret-row small')!.textContent).toBe('acme.atlassian.net · as ops@acme.com · token ending 4f2a');
    // Replace token keeps the account: its email is filled in.
    fireEvent.click(jira.getByRole('button', { name: 'Replace token' }));
    expect((jira.getByLabelText('Account email') as HTMLInputElement).value).toBe('ops@acme.com');
    fireEvent.click(jira.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(jira.getByRole('button', { name: 'Disconnect' }));
    expect(await jira.findByText('Not connected')).toBeTruthy();
    // Said, and focus lands on the card's button, not on the page.
    expect(jira.getByRole('status').textContent).toBe('Jira disconnected');
    await waitFor(() => expect(document.activeElement).toBe(jira.getByRole('button', { name: 'Connect Jira' })));
    expect(writes()).toEqual([
      { method: 'POST', path: '/v1/plugins/jira/check', body: {} },
      { method: 'DELETE', path: '/v1/console/secrets/jira.api_token', body: undefined },
    ]);
  });
});
