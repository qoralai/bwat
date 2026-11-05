// The onboarding page's secret field (setup/onboard/static/secret-field.js) in jsdom:
// the keys it takes, what it shows, and that the value never reaches the DOM.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const STATIC = join(import.meta.dirname, '..', '..', 'setup', 'onboard', 'static');
const SECRET = 'GOCSPX-' + 'q'.repeat(24) + 'a1b2';

type Mask = { hidden: number; last4: string | null };
type Saves = { key: string; value: string }[];

function field(status: ({ set: boolean } & Mask) | null = null, reply: (value: string) => Promise<Mask> = (v) => Promise.resolve(
  v.length >= 16 ? { hidden: v.length - 4, last4: v.slice(-4) } : { hidden: v.length, last4: null })) {
  const dom = new JSDOM('<!doctype html><main id="root"></main><button id="next">next</button>', { runScripts: 'outside-only', url: 'http://127.0.0.1:4000/' });
  const { window } = dom;
  window.eval(readFileSync(join(STATIC, 'mask.js'), 'utf8'));
  window.eval(readFileSync(join(STATIC, 'secret-field.js'), 'utf8'));
  const saves: Saves = [];
  const save = (key: string, value: string) => { saves.push({ key, value }); return reply(value); };
  const create = (window as unknown as { bwatSecretField: { create: (...a: unknown[]) => HTMLElement } }).bwatSecretField.create;
  const node = create(window.document, 'BWAT_GOOGLE_CLIENT_SECRET', status, save);
  window.document.getElementById('root')!.appendChild(node);
  const input = node.querySelector('input')!;
  const shown = node.querySelector('output')!;
  const note = node.querySelector('.draft-status')!;
  const key = (k: string, init: Record<string, unknown> = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    const allowed = input.dispatchEvent(event);
    return { prevented: !allowed };
  };
  const type = (text: string) => { for (const c of text) key(c); };
  const paste = (text: string) => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { getData: (type: string) => (type === 'text/plain' ? text : '') };
    return !input.dispatchEvent(event);
  };
  const focus = () => input.dispatchEvent(new window.FocusEvent('focus'));
  const blur = () => input.dispatchEvent(new window.FocusEvent('blur'));
  /** The value must never be anywhere in the document: not text, not an attribute, not the input. */
  const clean = (value = SECRET) => {
    expect(input.value).toBe('');
    expect(window.document.documentElement.outerHTML).not.toContain(value.slice(7, 20));
  };
  return { window, node, input, shown, note, key, type, paste, focus, blur, clean, saves };
}

describe('the secret field', () => {
  it('is a password input that asks password managers and autofill to stay away, with no form round it', () => {
    const { input, node } = field();
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.hasAttribute('data-1p-ignore')).toBe(true);
    expect(input.getAttribute('data-lpignore')).toBe('true');
    expect(node.closest('form')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe(node.querySelector('output')!.id);
  });

  it('marks its label with the 🔒 the guide explains, hidden from screen readers, which read the key', () => {
    const { node } = field();
    const label = node.querySelector('label')!;
    expect(label.textContent).toBe('🔒 BWAT_GOOGLE_CLIENT_SECRET');
    expect(label.querySelector('[aria-hidden="true"]')!.textContent).toBe('🔒 ');
  });

  it('appends every key that produces a character, space and symbols included', () => {
    const f = field();
    f.focus();
    f.type('ab C-_.~!');
    f.key('é');
    f.key('@', { ctrlKey: true, altKey: true, modifierAltGraph: true });
    expect(f.shown.textContent).toBe('*'.repeat(11));
    f.blur();
    expect(f.saves).toEqual([{ key: 'BWAT_GOOGLE_CLIENT_SECRET', value: 'ab C-_.~!é@' }]);
  });

  it('clears the whole field on Backspace', () => {
    const f = field();
    f.type('abcdef');
    expect(f.key('Backspace').prevented).toBe(true);
    expect(f.shown.textContent).toBe('Paste or type the secret');
    f.blur();
    expect(f.saves).toEqual([]);
  });

  it('ignores arrows, Home, End, Delete, Escape, function keys and shortcuts', () => {
    const f = field();
    f.type('abc');
    for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Escape', 'F5', 'Shift', 'Dead']) {
      expect(f.key(k).prevented, k).toBe(true);
    }
    for (const k of ['a', 'z', 'c', 'x']) expect(f.key(k, { ctrlKey: true }).prevented).toBe(true);
    expect(f.key('a', { metaKey: true }).prevented).toBe(true);
    expect(f.saves).toEqual([]);
  });

  it('saves on Enter, and on leaving the field, once', () => {
    const f = field();
    f.type('abc');
    expect(f.key('Enter').prevented).toBe(true);
    expect(f.saves).toEqual([{ key: 'BWAT_GOOGLE_CLIENT_SECRET', value: 'abc' }]);
    f.blur();
    expect(f.saves).toHaveLength(1);
    const g = field();
    g.type('def');
    g.blur();
    expect(g.saves).toEqual([{ key: 'BWAT_GOOGLE_CLIENT_SECRET', value: 'def' }]);
    g.focus();
    g.blur();
    expect(g.saves).toHaveLength(1);
  });

  it('leaves Tab, Shift+Tab and the paste shortcuts to the browser', () => {
    const f = field();
    expect(f.key('Tab').prevented).toBe(false);
    expect(f.key('Tab', { shiftKey: true }).prevented).toBe(false);
    expect(f.key('v', { ctrlKey: true }).prevented).toBe(false);
    expect(f.key('v', { metaKey: true }).prevented).toBe(false);
    expect(f.key('Insert', { shiftKey: true }).prevented).toBe(false);
  });

  it('appends a paste, without its line breaks', () => {
    const f = field();
    f.type('GOCSPX-');
    expect(f.paste('q'.repeat(24) + 'a1b2\r\n')).toBe(true);
    f.blur();
    expect(f.saves[0]!.value).toBe(SECRET);
  });

  it('shows the last 4 only while unfocused and only with 12 hidden before them; asterisks while focused', async () => {
    const f = field();
    f.focus();
    f.paste(SECRET);
    expect(f.shown.textContent).toBe('*'.repeat(35));
    f.blur();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.shown.textContent).toBe('*'.repeat(31) + 'a1b2  saved');
    f.focus();
    expect(f.shown.textContent).toBe('*'.repeat(35));
    const short = field();
    short.paste('abcdefghijklmno');
    short.blur();
    await new Promise((r) => setTimeout(r, 0));
    expect(short.shown.textContent).toBe('*'.repeat(15) + '  saved');
  });

  it('keeps the value out of the input and the document at every step', async () => {
    const f = field();
    f.focus();
    f.type('GOCSPX-');
    f.clean();
    f.paste('q'.repeat(24) + 'a1b2');
    f.clean();
    f.blur();
    f.clean();
    await Promise.resolve();
    f.clean();
  });

  it('drops anything that reaches the input another way, and refuses a drop', () => {
    const f = field();
    f.input.value = 'autofilled';
    f.input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    expect(f.input.value).toBe('');
    f.blur();
    expect(f.saves).toEqual([]);
    expect(f.input.dispatchEvent(new f.window.Event('drop', { bubbles: true, cancelable: true }))).toBe(false);
  });

  it('after a save shows the server\'s mask, and a new keystroke starts a new value', async () => {
    const f = field();
    f.paste(SECRET);
    f.blur();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.shown.textContent).toBe('*'.repeat(31) + 'a1b2  saved');
    f.type('xyz');
    f.key('Enter');
    expect(f.saves.map((s) => s.value)).toEqual([SECRET, 'xyz']);
  });

  it('says Saving…, then Saved., and has no button', async () => {
    const f = field();
    expect(f.node.querySelector('button')).toBeNull();
    f.paste(SECRET);
    f.blur();
    expect(f.note.textContent).toBe('Saving…');
    await new Promise((r) => setTimeout(r, 0));
    expect(f.note.textContent).toBe('Saved.');
    f.type('x');
    expect(f.note.textContent).toBe('');
  });

  it('shows a value saved earlier by its mask alone', () => {
    const f = field({ set: true, hidden: 31, last4: 'a1b2' });
    expect(f.shown.textContent).toBe('*'.repeat(31) + 'a1b2  saved');
  });

  it('forgets an unsaved value when the page is hidden or left', () => {
    const f = field();
    f.type('abc');
    Object.defineProperty(f.window.document, 'visibilityState', { value: 'hidden', configurable: true });
    f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
    f.blur();
    f.type('def');
    f.window.dispatchEvent(new f.window.Event('pagehide'));
    f.blur();
    expect(f.saves).toEqual([]);
  });

  it('shows the server\'s refusal and keeps nothing', async () => {
    const f = field(null, () => Promise.reject(new Error('that does not look like a credential')));
    f.type('bad value');
    f.blur();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.note.textContent).toBe('that does not look like a credential');
    f.focus();
    f.blur();
    expect(f.saves).toHaveLength(1);
  });
  it('after a save, draws the mask once as its asterisks and its last four, so they can arrive; the text is the same', async () => {
    const f = field();
    f.paste(SECRET);
    f.blur();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.shown.classList.contains('onboard-mask-arrive')).toBe(true);
    expect(f.shown.querySelector('.onboard-mask-stars')!.textContent).toBe('*'.repeat(SECRET.length - 4));
    expect(f.shown.querySelector('.onboard-mask-four')!.textContent).toBe('a1b2');
    expect(f.shown.textContent).toBe('*'.repeat(SECRET.length - 4) + 'a1b2  saved');
    f.clean();
    f.focus();
    f.blur();
    expect(f.shown.classList.contains('onboard-mask-arrive')).toBe(false);
    expect(f.shown.querySelector('span')).toBeNull();
  });

  it('a mask that was already saved when the page opened does not arrive again', () => {
    const f = field({ set: true, hidden: 20, last4: 'zz99' });
    expect(f.shown.classList.contains('onboard-mask-arrive')).toBe(false);
    expect(f.shown.textContent).toBe('*'.repeat(20) + 'zz99  saved');
  });
});
