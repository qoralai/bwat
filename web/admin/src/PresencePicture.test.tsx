// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Settings } from './Settings';
import { makeQueryClient } from './api';

const URL_PATH = '/v1/console/settings/presence-image';
const DEFAULT_SRC = '/admin/presence-default.png';

/** A PNG's signature and IHDR: all the page reads of one. */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG's start, an APP0 segment, then its frame header. */
function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  const view = new DataView(bytes.buffer);
  view.setUint16(13, height);
  view.setUint16(15, width);
  return bytes;
}

type Call = { method: string; path: string; contentType: string | null; body: unknown };
let calls: Call[];
let stored: Uint8Array<ArrayBuffer> | null;
let refuse: [number, string] | null;
/** While set, a change to the picture waits for it. */
let hold: Promise<void> | null;

function backend({ role = 'owner' } = {}): typeof fetch {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'http://bwat.test').pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, path, contentType: new Headers(init.headers).get('content-type'), body: init.body });
    if (path === '/whoami') return json(200, { member: { id: 'a', email: 'ada@example.com', display_name: 'Ada', role }, id_token: 't' });
    if (path === '/v1/console/settings') return json(200, { settingsVersion: 1, canManage: role !== 'member', settings: {} });
    if (path === '/v1/console/model-keys') return json(200, { keys: [] });
    if (path === '/v1/console/secrets') return json(200, { secrets: [] });
    if (path !== URL_PATH) return json(404, { error: 'not_found' });
    if (role === 'member') return json(403, { error: 'forbidden' });
    if (refuse) return json(refuse[0], { error: refuse[1] });
    if (method !== 'GET' && hold) await hold;
    if (method === 'PUT') stored = new Uint8Array(png(1920, 1080));
    if (method === 'DELETE') stored = null;
    if (method !== 'GET' || !stored) return new Response(null, { status: 204 });
    return new Response(stored, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
}

function show(role = 'owner') {
  globalThis.fetch = backend({ role });
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <Settings />
    </QueryClientProvider>,
  );
}

const picture = () => screen.findByRole('img', { name: 'The picture bwat shows in meetings' });
const row = async () => within(await screen.findByRole('group', { name: 'Picture' }));
const choose = async (bytes: Uint8Array<ArrayBuffer>, name = 'logo.png', type = 'image/png') =>
  fireEvent.change((await row()).getByLabelText('Upload a picture'), { target: { files: [new File([bytes], name, { type })] } });

beforeEach(() => {
  calls = [];
  stored = null;
  refuse = null;
  hold = null;
  // jsdom has no object URLs.
  // The page's CSP allows img-src 'self' data: only, so a preview must never be a blob: URL.
  URL.createObjectURL = () => { throw new Error('blob: URLs are refused by the CSP'); };
});
afterEach(cleanup);

describe('the in-meeting picture', () => {
  it('claims no picture, default or own, while the picture cannot be read', async () => {
    refuse = [500, 'internal'];
    show();
    expect(await screen.findByText("We couldn't load the picture. Reload the page to try again.")).toBeTruthy();
    expect(screen.queryByText(/The default logo|Your picture/)).toBeNull();
    expect(screen.queryByRole('img', { name: 'The picture bwat shows in meetings' })).toBeNull();
    expect(screen.getByText('16:9, up to 2 MB')).toBeTruthy();
  });

  it('shows the bundled logo while nothing is uploaded, with nothing to go back from', async () => {
    show();
    await waitFor(async () => expect((await picture()).getAttribute('src')).toBe(DEFAULT_SRC));
    expect((await row()).getByText(/the default logo/i)).toBeTruthy();
    expect(((await row()).getByRole('button', { name: 'Use the default' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the uploaded picture, and Use the default removes it', async () => {
    stored = png(1280, 720);
    show();
    await waitFor(async () => expect((await picture()).getAttribute('src')).toMatch(/^data:image\/(png|jpeg);base64,/));
    const back = (await row()).getByRole('button', { name: 'Use the default' }) as HTMLButtonElement;
    await waitFor(() => expect(back.disabled).toBe(false));
    fireEvent.click(back);
    await waitFor(async () => expect((await picture()).getAttribute('src')).toBe(DEFAULT_SRC));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([URL_PATH]);
  });

  it('uploads a 16:9 PNG or JPEG as the raw picture, and shows the one the server stored', async () => {
    show();
    await picture();
    await choose(png(1920, 1080));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe(URL_PATH);
    expect(put.contentType).toBe('image/png');
    expect(put.body).toBeInstanceOf(Blob);
    await waitFor(async () => expect((await picture()).getAttribute('src')).toMatch(/^data:image\/(png|jpeg);base64,/));

    // A browser that gives no type: sent as a type the server takes; it reads the bytes.
    await choose(jpeg(1280, 720), 'photo.jpg', '');
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PUT')[1]!.contentType).toBe('image/png');
  });







  // QOR-5023 (Z1): the server alone judges the picture; the page sends what was chosen.
  it('sends any picture chosen for the server to judge, typed one the server takes', async () => {
    show();
    await picture();
    await choose(new TextEncoder().encode('GIF89a not a png'), 'a.gif', 'image/gif');
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'PUT')!.contentType).toBe('image/png');
  });

  it.each([
    [[415, 'unsupported_media_type'], 'Choose a PNG or JPEG picture. Nothing was saved.'],
    [[400, 'not_an_image'], 'Choose a PNG or JPEG picture. Nothing was saved.'],
    [[413, 'too_large'], 'The picture must be 2 MB or smaller. Nothing was saved.'],
    [[400, 'too_many_pixels'], 'The picture must be at most 3840 by 2160. Nothing was saved.'],
  ] as const)('says the server refused %j in plain words', async (refused, words) => {
    show();
    await picture();
    refuse = [...refused];
    await choose(png(1000, 1000));
    expect((await (await row()).findByRole('alert')).textContent).toBe(words);
  });

  it('never rereads the settings when an upload is refused as forbidden: a draft on the page stays', async () => {
    show();
    await picture();
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/v1/console/settings').length;
    const before = reads();
    refuse = [403, 'forbidden'];
    await choose(png(1920, 1080));
    expect((await (await row()).findByRole('alert')).textContent).toBe('Only admins can change the picture.');
    expect(reads()).toBe(before);
  });

  it("says why the server refused an upload, and keeps what was shown", async () => {
    show();
    await picture();
    refuse = [400, 'not_16_9'];
    await choose(png(1920, 1080));
    expect((await (await row()).findByRole('alert')).textContent).toBe('The picture must be 16:9. Nothing was saved.');
    expect((await picture()).getAttribute('src')).toBe(DEFAULT_SRC);
  });

  it('is not offered to a member, who never asks for it', async () => {
    show('member');
    await screen.findByText('Only an owner or an admin changes these.');
    expect(screen.queryByRole('group', { name: 'Picture' })).toBeNull();
    expect(calls.some((c) => c.path === URL_PATH)).toBe(false);
  });

  it('ships the same logo the bot shows by default', () => {
    const web = readFileSync(join(import.meta.dirname, '..', 'public', 'presence-default.png'));
    const bot = readFileSync(join(import.meta.dirname, '..', '..', '..', 'bot', 'presence', 'default.png'));
    expect(web.equals(bot)).toBe(true);
  });
});

describe('the tile in the gallery', () => {
  it('shows the picture and the name together in a 16:9 tile, the name as it is typed', async () => {
    show();
    const img = await picture();
    const tile = img.closest('.tile')!;
    expect(tile.querySelector('.lbl')!.textContent).toBe('bwat');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme notes' } });
    expect(tile.querySelector('.lbl')!.textContent).toBe('Acme notes');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    expect(tile.querySelector('.lbl')!.textContent).toBe('bwat');
    expect(document.querySelector('.presence-preview')).toBeNull();
  });

  it('fades a new picture in only once the server has it', async () => {
    show();
    await picture();
    expect((await picture()).className).not.toContain('fresh');
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    await choose(png(1920, 1080));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect((await picture()).className).not.toContain('fresh');
    release();
    await waitFor(async () => expect((await picture()).className).toContain('fresh'));
  });
});
