// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';

const payload = {
  targets: [{ id: 'bwat', canonical: 'Bwat', hardness: 'hard', proper_noun: true, extra: 'keep' }],
  aliases: [{ alias: 'boat', target_id: 'bwat', scopes: ['body'], case_sensitive: true }],
  people: [{ id: 'ada', canonical: 'Ada' }], extra: { keep: true },
};
let stored: Record<string, unknown>;
let writes: Record<string, unknown>[];
let stale: boolean;
let hold: Promise<void> | null;
beforeEach(() => {
  stored = { state: 'set', revision: 4, version: '2026-10-06.1', payload: structuredClone(payload) };
  writes = []; stale = false; hold = null;
  window.location.hash = '#/dictionary';
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    if (input === '/whoami') return Response.json({ member: { id: 'ada', email: 'ada@example.com', role: 'member', display_name: 'Ada' }, id_token: 'test' });
    if (input === '/v1/console/settings') return Response.json({ settingsVersion: 1, canManage: false, settings: {} });
    if (input !== '/v1/console/corrections') return Response.json({}, { status: 404 });
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (hold) await hold;
      if (stale) return Response.json({ error: 'stale' }, { status: 409 });
      stored = { state: 'set', revision: 5, version: '2026-10-06.2', payload: body.payload };
    }
    return Response.json({ dictionary: stored });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function show() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
}
/** Adds a correction row per pair, typing what it hears and what it should say. */
async function addCorrections(pairs: [string, string][]) {
  for (const [heard, to] of pairs) {
    fireEvent.click(await screen.findByRole('button', { name: 'Add a correction' }));
    const row = String(screen.getAllByLabelText(/^Heard as /).length);
    fireEvent.change(screen.getByLabelText(`Heard as ${row}`), { target: { value: heard } });
    fireEvent.change(screen.getByLabelText(`Corrected to ${row}`), { target: { value: to } });
  }
}
it('edits dictionary words under Settings, Cards, where the old link lands, saves the loaded revision and preserves hidden fields', async () => {
  show();
  expect(await screen.findByRole('region', { name: 'Dictionary' })).toBeTruthy();
  expect(window.location.hash).toBe('#/settings?place=cards');
  expect(screen.queryByRole('link', { name: 'Dictionary' })).toBeNull();
  fireEvent.change(await screen.findByLabelText('Word 1'), { target: { value: 'BWAT' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dictionary' }));
  await screen.findByText('Dictionary saved.');
  expect(writes[0]).toEqual({ expectedRevision: 4, payload: { ...payload, targets: [{ ...payload.targets[0], canonical: 'BWAT' }] } });
  fireEvent.click(screen.getByRole('button', { name: 'Reload dictionary' }));
  await waitFor(() => expect((screen.getByLabelText('Word 1') as HTMLInputElement).value).toBe('BWAT'));
});
it('starts an absent dictionary and adds a word and a correction', async () => {
  stored = { state: 'absent', revision: null, payload: null }; show();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a word' }));
  fireEvent.change(screen.getByLabelText('Word 1'), { target: { value: 'Bwat' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add a correction' }));
  fireEvent.change(screen.getByLabelText('Heard as 1'), { target: { value: 'boat' } });
  fireEvent.change(screen.getByLabelText('Corrected to 1'), { target: { value: 'Bwat' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dictionary' }));
  await screen.findByText('Dictionary saved.');
  expect(writes[0]!.expectedRevision).toBeNull();
  const result = writes[0]!.payload as typeof payload;
  expect(result.targets).toHaveLength(1);
  expect(result.targets[0]).toMatchObject({ canonical: 'Bwat', hardness: 'hard', proper_noun: true });
  expect(result.aliases[0]!.target_id).toBe(result.targets[0]!.id);
});
it('adds a correction’s new spelling to the words in the same save', async () => {
  stored = { state: 'absent', revision: null, payload: null }; show();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a correction' }));
  fireEvent.change(screen.getByLabelText('Heard as 1'), { target: { value: 'cube cuddle' } });
  fireEvent.change(screen.getByLabelText('Corrected to 1'), { target: { value: ' kubectl ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dictionary' }));
  await screen.findByText('Dictionary saved.');
  expect(writes).toHaveLength(1);
  const result = writes[0]!.payload as typeof payload;
  expect(result.targets).toEqual([{ id: expect.any(String), canonical: 'kubectl', hardness: 'hard', proper_noun: true, scopes: ['body'] }]);
  expect(result.aliases).toEqual([{ alias: 'cube cuddle', target_id: result.targets[0]!.id, hardness: 'hard', scopes: ['body'] }]);
  expect((screen.getByLabelText('Word 1') as HTMLInputElement).value).toBe('kubectl');
  expect(screen.getByLabelText('Word 1').className).toContain('fresh');
  expect((screen.getByLabelText('Corrected to 1') as HTMLInputElement).value).toBe('kubectl');
});
it('points a correction at the word or person already spelt that way, ignoring case, and adds a new word once', async () => {
  show();
  await addCorrections([['bote', 'bwat'], ['aider', 'ADA'], ['cube cuddle', 'kubectl'], ['cube control', 'Kubectl']]);
  fireEvent.click(screen.getByRole('button', { name: 'Save dictionary' }));
  await screen.findByText('Dictionary saved.');
  const result = writes[0]!.payload as typeof payload;
  expect(result.targets.map((word) => word.canonical)).toEqual(['Bwat', 'kubectl']);
  expect(result.aliases.map((correction) => correction.target_id)).toEqual(['bwat', 'bwat', 'ada', result.targets[1]!.id, result.targets[1]!.id]);
});
it('binds a correction to an existing word once its spelling is typed back, so it follows that word', async () => {
  show();
  const to = await screen.findByLabelText('Corrected to 1');
  fireEvent.change(to, { target: { value: 'Bwatx' } });
  fireEvent.change(to, { target: { value: 'Bwat' } });
  expect((screen.getByRole('button', { name: 'Save dictionary' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Word 1'), { target: { value: 'BWAT2' } });
  expect((screen.getByLabelText('Corrected to 1') as HTMLInputElement).value).toBe('BWAT2');
  fireEvent.click(screen.getByRole('button', { name: 'Save dictionary' }));
  await screen.findByText('Dictionary saved.');
  expect(writes[0]).toEqual({ expectedRevision: 4, payload: { ...payload, targets: [{ ...payload.targets[0], canonical: 'BWAT2' }] } });
});
it('blocks a save where one correction’s new spelling is what another correction hears', async () => {
  show();
  await addCorrections([['cube cuddle', 'kubectl'], ['Kubectl', 'Bwat']]);
  expect(screen.getByText('“Kubectl” is already the spelling of another word.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save dictionary' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Corrected to 3'), { target: { value: 'KUBECTL' } });
  expect(screen.queryByText(/is already the spelling of another word/)).toBeNull();
});
it('blocks a save where a correction hears a word that is in Words', async () => {
  show();
  fireEvent.change(await screen.findByLabelText('Heard as 1'), { target: { value: 'bwat' } });
  fireEvent.change(screen.getByLabelText('Corrected to 1'), { target: { value: 'Boat' } });
  expect(screen.getByText('“bwat” is already the spelling of another word.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save dictionary' }) as HTMLButtonElement).disabled).toBe(true);
});
it('does not block a dictionary the server accepts, where a stored word has spaces around it', async () => {
  stored = { ...stored, payload: { ...structuredClone(payload), targets: [{ ...payload.targets[0], canonical: ' Bwat ' }] } };
  show();
  await addCorrections([['bwat', 'kubectl']]);
  expect(screen.queryByText(/is already the spelling of another word/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Save dictionary' }) as HTMLButtonElement).disabled).toBe(false);
});
it('lists each problem once when several corrections share it', async () => {
  show();
  await addCorrections([['bwat', 'Boat'], ['bwat', 'Boat']]);
  expect(screen.getAllByText('“bwat” is already the spelling of another word.')).toHaveLength(1);
});
it('does not bind a cleared correction to a word whose spelling is still blank', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a word' }));
  fireEvent.change(screen.getByLabelText('Corrected to 1'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Word 2'), { target: { value: 'kubectl' } });
  expect((screen.getByLabelText('Corrected to 1') as HTMLInputElement).value).toBe('');
});
it('keeps a word when its correction is removed', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Remove correction 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save dictionary' }));
  await screen.findByText('Dictionary saved.');
  expect(writes[0]!.payload).toEqual({ ...payload, aliases: [] });
});
it('keeps edits after a stale save and offers an explicit reload', async () => {
  stale = true; show();
  fireEvent.change(await screen.findByLabelText('Word 1'), { target: { value: 'Changed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dictionary' }));
  await screen.findByText(/Someone else changed the dictionary/);
  expect((screen.getByLabelText('Word 1') as HTMLInputElement).value).toBe('Changed');
  fireEvent.click(screen.getByRole('button', { name: 'Reload dictionary' }));
  await waitFor(() => expect((screen.getByLabelText('Word 1') as HTMLInputElement).value).toBe('Bwat'));
});
it('does not silently redirect a correction when its word is removed', async () => {
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Remove word 1' }));
  expect(screen.getByText(/Enter what correction 1 should say/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save dictionary' }) as HTMLButtonElement).disabled).toBe(true);
  expect(writes).toHaveLength(0);
});
it('underlines a new word in the logo’s orange arc once the dictionary is saved, never before', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a word' }));
  fireEvent.change(screen.getByLabelText('Word 2'), { target: { value: 'kubectl' } });
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  fireEvent.click(screen.getByRole('button', { name: 'Save dictionary' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(screen.getByLabelText('Word 2').className).not.toContain('fresh');
  release();
  await screen.findByText('Dictionary saved.');
  expect(screen.getByLabelText('Word 2').className).toContain('fresh');
  expect(screen.getByLabelText('Word 1').className).not.toContain('fresh');
});
