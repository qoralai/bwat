import { afterEach, describe, expect, it } from 'vitest';
import { CARD, CARD_OWNED, fakeServer, loadPage, TOKEN, until } from './board-harness.ts';

// A feature plugin's card action (ui/plugins.js cardAction): a button in a card's action row,
// beside Send, or a link once the plugin says the card has one. Probed with the probe plugin's
// fixtures (test/fixtures/plugins/probe/board/).
let close: (() => void) | undefined;
afterEach(() => close?.());

type Answer = () => [number, unknown] | Promise<[number, unknown]>;
const server = (script: string, probe: Answer = () => [200, { key: 'PRB-1' }], { config = (() => [200, {}]) as Answer, others = [] as string[] } = {}) => fakeServer({
  boardPlugins: {
    plugins: [{ name: 'probe', token: null, scripts: [`/plugins/probe/${script}`] }, ...others.map((o) => ({ name: 'other', token: null, scripts: [`/plugins/other/${o}`] }))],
    reserved: [],
  },
  extra: { [`POST /v1/plugins/probe/cards/${CARD_OWNED}`]: probe, 'GET /v1/plugins/probe/config': config },
});
const open = async (s: ReturnType<typeof server>, storage: Record<string, string> = {}) => {
  const loaded = await loadPage('board.html', s, '', { storage });
  close = () => loaded.window.close();
  return loaded;
};
const tile = (document: Document, id: string) => document.querySelector(`#card-list [data-card="${id}"]`);
const action = (document: Document, id: string) => tile(document, id)?.querySelector<HTMLButtonElement>('[data-plugin-action="probe"]');
const sendButton = (document: Document, id: string) => tile(document, id)?.querySelector('[data-send]');

describe("a plugin's card action", () => {
  it('is a button beside Send on the cards the plugin offers it for, and on no other card', async () => {
    const { document } = await open(server('actions.js'));
    await until(() => !!action(document, CARD_OWNED));
    expect(action(document, CARD_OWNED)!.textContent).toBe('Probe it');
    expect(action(document, CARD_OWNED)!.nextElementSibling).toBe(sendButton(document, CARD_OWNED));
    expect(action(document, CARD)).toBeFalsy();
  });

  it('runs once on a press, as the signed-in person, then shows what the plugin links and says so', async () => {
    const { document, server: s } = await open(server('actions.js'));
    await until(() => !!action(document, CARD_OWNED));
    action(document, CARD_OWNED)!.click();
    expect(action(document, CARD_OWNED)!.getAttribute('aria-disabled')).toBe('true');
    expect(action(document, CARD_OWNED)!.textContent).toBe('Probing…');
    await until(() => !!tile(document, CARD_OWNED)?.querySelector('a[href="https://probe.example/PRB-1"]'));
    const link = tile(document, CARD_OWNED)!.querySelector<HTMLAnchorElement>('a[href="https://probe.example/PRB-1"]')!;
    expect(link.textContent).toBe('PRB-1');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(action(document, CARD_OWNED)).toBeFalsy();
    expect(document.getElementById('whisper')!.textContent).toContain('Probed as PRB-1.');
    const runs = s.calls.filter((c) => c.method === 'POST' && c.path === `/v1/plugins/probe/cards/${CARD_OWNED}`);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('runs once while it is running, though the tile is drawn again and pressed again meanwhile', async () => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const { document, window, server: s } = await open(server('actions.js', async () => { await held; return [200, { key: 'PRB-1' }]; }));
    await until(() => !!action(document, CARD_OWNED));
    const first = action(document, CARD_OWNED)!;
    first.click();
    (window as unknown as { eval: (js: string) => void }).eval('render({keepReader:true})');
    await until(() => action(document, CARD_OWNED) !== first);
    const again = action(document, CARD_OWNED)!;
    expect(again.getAttribute('aria-disabled')).toBe('true');
    expect(again.textContent).toBe('Probing…');
    again.click();
    answer();
    await until(() => !!tile(document, CARD_OWNED)?.querySelector('a[href="https://probe.example/PRB-1"]'));
    expect(s.calls.filter((c) => c.method === 'POST' && c.path === `/v1/plugins/probe/cards/${CARD_OWNED}`)).toHaveLength(1);
  });

  it('is pressable again when the plugin could not do it', async () => {
    const { document } = await open(server('actions.js', () => [502, { error: 'probe_failed' }]));
    await until(() => !!action(document, CARD_OWNED));
    action(document, CARD_OWNED)!.click();
    await until(() => document.getElementById('whisper')!.textContent!.includes('Probe refused.'));
    expect(action(document, CARD_OWNED)!.hasAttribute('aria-disabled')).toBe(false);
    // Labelled as the plugin gives the action now, not as it was before the press.
    expect(action(document, CARD_OWNED)!.textContent).toBe('Retry probe');
  });

  it('draws no link that is not https', async () => {
    const { document } = await open(server('bad-actions.js'));
    await until(() => !!sendButton(document, CARD_OWNED));
    expect(tile(document, CARD_OWNED)!.querySelector('a[href^="javascript"]')).toBeNull();
    expect(tile(document, CARD_OWNED)!.textContent).not.toContain('Not a web link');
  });

  it("loses only its own action when the plugin throws: the card, its Send and another plugin's action are drawn", async () => {
    const { document } = await open(server('throws.js', undefined, { others: ['link.js'] }));
    await until(() => !!sendButton(document, CARD_OWNED));
    expect(action(document, CARD_OWNED)).toBeFalsy();
    await until(() => !!tile(document, CARD_OWNED)?.querySelector('a[href="https://other.example/OTH-7"]'));
  });

  it('is offered once the plugin knows, after its own read at start, without waiting for the next poll', async () => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const { document } = await open(server('late.js', undefined, { config: async () => { await held; return [200, {}]; } }));
    await until(() => !!sendButton(document, CARD_OWNED));
    expect(action(document, CARD_OWNED)).toBeFalsy();
    answer();
    await until(() => !!action(document, CARD_OWNED));
  });

  it("draws the plugin's label as text, and is pressable again when its run throws", async () => {
    const { document } = await open(server('late.js'));
    await until(() => !!action(document, CARD_OWNED));
    expect(action(document, CARD_OWNED)!.textContent).toBe('<b>Late</b> probe');
    expect(action(document, CARD_OWNED)!.querySelector('b')).toBeNull();
    action(document, CARD_OWNED)!.click();
    await until(() => !action(document, CARD_OWNED)!.hasAttribute('aria-disabled'));
    expect(action(document, CARD_OWNED)!.textContent).toBe('<b>Late</b> probe');
  });

  it('is not drawn while this person has hidden the plugin', async () => {
    const { document } = await open(server('actions.js'), { 'bwat.hidden-plugins': '["probe"]' });
    await until(() => !!sendButton(document, CARD_OWNED));
    expect(action(document, CARD_OWNED)).toBeFalsy();
  });

  it("is drawn from the plugin's own read of each card, taken with every board read", async () => {
    const records: { card_id: string; key: string; url: string }[] = [];
    const s = fakeServer({
      boardPlugins: { plugins: [{ name: 'probe', token: null, scripts: ['/plugins/probe/records.js'] }], reserved: [] },
      extra: { 'GET /v1/plugins/probe/records': () => [200, { records }] },
    });
    const { document, window } = await open(s);
    await until(() => !!sendButton(document, CARD_OWNED));
    expect(tile(document, CARD_OWNED)!.querySelector('a[href^="https://probe.example"]')).toBeNull();
    expect(s.calls.some((c) => c.path === '/v1/plugins/probe/records')).toBe(true);
    records.push({ card_id: CARD_OWNED, key: 'PRB-9', url: 'https://probe.example/PRB-9' });
    (window as unknown as { eval: (js: string) => void }).eval('refresh(true)');
    await until(() => !!tile(document, CARD_OWNED)?.querySelector('a[href="https://probe.example/PRB-9"]'));
    // Each card has only its own record.
    expect(tile(document, CARD)?.querySelector('a[href^="https://probe.example"]') ?? null).toBeNull();
    expect((window as unknown as { eval: (js: string) => unknown }).eval('({}).probe')).toBeUndefined();
  });

  it("keeps the board drawing when the plugin's read fails: the card simply has no data of it", async () => {
    const s = fakeServer({
      boardPlugins: { plugins: [{ name: 'probe', token: null, scripts: ['/plugins/probe/records.js'] }], reserved: [] },
      extra: { 'GET /v1/plugins/probe/records': () => [503, { error: 'down' }] },
    });
    const { document } = await open(s);
    await until(() => !!sendButton(document, CARD_OWNED));
    expect(tile(document, CARD_OWNED)!.querySelector('a[href^="https://probe.example"]')).toBeNull();
  });
});
