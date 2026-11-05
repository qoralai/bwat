// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CardsModel } from './CardsModel';

// The card writer's model, picked on Settings, Models.

const SUGGESTIONS = [
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus (latest: 5.5)', price: '$4 / $20 per M tokens' },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet (latest: 5.5)', price: '$3 / $15 per M tokens' },
  { id: 'openai/gpt-6.1-sol', label: 'GPT Sol (latest: 6.1)', price: null },
];
const VIEW = {
  endpoint: 'openrouter',
  host: 'openrouter.ai',
  model: 'anthropic/claude-opus-5.5',
  default: 'anthropic/claude-opus-5.5',
  saved: false,
  elsewhere: null,
  revision: null,
  listed: true,
  paused: null,
  suggestions: SUGGESTIONS,
};
let view: Record<string, unknown>;
let puts: Record<string, unknown>[];
let answers: [number, Record<string, unknown>][];
beforeEach(() => {
  view = structuredClone(VIEW);
  puts = [];
  answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      if (input === '/whoami') return Response.json({ member: { id: 'ada', email: 'ada@example.com', role: 'admin', display_name: 'Ada' }, id_token: 'test' });
      if (input !== '/v1/console/cards-model') return Response.json({}, { status: 404 });
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(body);
        const answer = answers.shift();
        if (answer) return Response.json(answer[1], { status: answer[0] });
        view = { ...view, model: body.model, saved: true, revision: ((view.revision as number | null) ?? 0) + 1 };
      }
      return Response.json(view);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CardsModel />
    </QueryClientProvider>,
  );
/** The picker, opened with Change model. */
const picker = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
  return screen.getByLabelText('Card writer model') as HTMLSelectElement;
};

it('says the model in use and keeps the picker behind Change model, folded again on Cancel', async () => {
  show();
  expect(await screen.findByText('anthropic/claude-opus-5.5', { selector: 'b' })).toBeTruthy();
  expect(screen.queryByLabelText('Card writer model')).toBeNull();
  expect(screen.getByRole('button', { name: 'Change model' }).getAttribute('aria-expanded')).toBe('false');
  await picker();
  expect(screen.queryByRole('button', { name: 'Change model' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('Card writer model')).toBeNull();
  expect(puts).toEqual([]);
});

it('offers each suggestion with its price, and the model in use picked', async () => {
  show();
  const select = await picker();
  expect([...select.options].map((o) => o.textContent)).toEqual([
    'Claude Opus (latest: 5.5) · $4 / $20 per M tokens',
    'Claude Sonnet (latest: 5.5) · $3 / $15 per M tokens',
    'GPT Sol (latest: 6.1)',
    'Another model ID…',
  ]);
  expect(select.value).toBe('anthropic/claude-opus-5.5');
  // Only the default: it can be saved as the choice (or past its no-ZDR warning).
  expect(screen.getByRole('button', { name: 'Save model' })).toHaveProperty('disabled', false);
});

it('checks the saved model again on Save, so one that lost its ZDR endpoint reaches the warning', async () => {
  view.saved = true;
  view.revision = 1;
  answers.push([409, { error: 'no_zdr', message: 'No provider of anthropic/claude-opus-5.5 promises to keep no data.' }]);
  show();
  await picker();
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Save anyway' }));
  await screen.findByText('Saved. The card writer uses it from its next pass.');
  expect(puts.at(-1)).toEqual({ model: 'anthropic/claude-opus-5.5', expectedRevision: 1, acceptNoZdr: true });
});

it('saves a suggestion with the revision it read, and says so', async () => {
  show();
  fireEvent.change(await picker(), { target: { value: 'anthropic/claude-sonnet-5.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  await screen.findByText('Saved. The card writer uses it from its next pass.');
  expect(puts).toEqual([{ model: 'anthropic/claude-sonnet-5.5', expectedRevision: null }]);
});

it('takes any other model id typed in', async () => {
  show();
  fireEvent.change(await picker(), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: ' mistral/large-3 ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  await screen.findByText('Saved. The card writer uses it from its next pass.');
  expect(puts[0]).toEqual({ model: 'mistral/large-3', expectedRevision: null });
});

it('shows the warning before a model with no zero-retention provider is saved, and saves only on Save anyway', async () => {
  answers.push([409, { error: 'no_zdr', message: 'No provider of plain/model promises to keep no data.' }]);
  show();
  fireEvent.change(await picker(), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'plain/model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  const warning = await screen.findByRole('alert');
  expect(warning.textContent).toContain('No provider of plain/model promises to keep no data.');
  fireEvent.click(within(warning).getByRole('button', { name: 'Save anyway' }));
  await screen.findByText('Saved. The card writer uses it from its next pass.');
  expect(puts).toEqual([
    { model: 'plain/model', expectedRevision: null },
    { model: 'plain/model', expectedRevision: null, acceptNoZdr: true },
  ]);
});

it('cancelling the warning saves nothing, says nothing went wrong, and puts focus back on the picker', async () => {
  answers.push([409, { error: 'no_zdr', message: 'No provider of plain/model promises to keep no data.' }]);
  show();
  fireEvent.change(await picker(), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'plain/model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText('Card writer model'));
  expect(puts).toHaveLength(1);
});

it('says the save is unconfirmed, not refused, when the server fails', async () => {
  answers.push([500, { error: 'internal' }]);
  show();
  fireEvent.change(await picker(), { target: { value: 'anthropic/claude-sonnet-5.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  expect((await screen.findByRole('alert')).textContent).toBe("We couldn't confirm the save. Reload to see which model is in use.");
});

it("shows the server's plain reason when a save is refused", async () => {
  answers.push([400, { error: 'model_refused', message: 'OpenRouter does not offer x/y. Check the model ID. Nothing was saved.' }]);
  show();
  fireEvent.change(await picker(), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'x/y' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  expect((await screen.findByRole('alert')).textContent).toBe('OpenRouter does not offer x/y. Check the model ID. Nothing was saved.');
});

it('says in red when the writer has paused on the model in use', async () => {
  view.paused = { model: 'anthropic/claude-opus-5.5', error: 'not found (404)' };
  show();
  const note = await screen.findByRole('alert');
  expect(note.className).toContain('error');
  expect(note.textContent).toBe(
    'Paused: anthropic/claude-opus-5.5 is unavailable, not found (404). No new cards are written until you save a model that works.',
  );
});

it('saves the model in use again while the writer is paused on it, so the writer tries it again', async () => {
  view.paused = { model: 'anthropic/claude-opus-5.5', error: 'not found (404)' };
  show();
  // Paused, the picker is open at once, with nothing to cancel back to.
  await screen.findByLabelText('Card writer model');
  expect(screen.queryByRole('button', { name: 'Change model' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  await screen.findByText('Saved. The card writer uses it from its next pass.');
  expect(puts).toEqual([{ model: 'anthropic/claude-opus-5.5', expectedRevision: null }]);
});

it('asks for a new pick when the saved one was for another endpoint', async () => {
  view.elsewhere = { model: 'router-opus', host: 'models.example.com' };
  show();
  expect(await screen.findByText(/router-opus was picked for models\.example\.com/)).toBeTruthy();
  expect(screen.getByLabelText('Card writer model')).toBeTruthy();
  // The default in use can be picked for this endpoint.
  expect(screen.getByRole('button', { name: 'Save model' })).toHaveProperty('disabled', false);
});

it('says the prices are unavailable while OpenRouter cannot be read', async () => {
  view.listed = false;
  view.suggestions = SUGGESTIONS.map((s) => ({ ...s, price: null }));
  show();
  expect(await screen.findByText("Prices can't be read from OpenRouter right now.")).toBeTruthy();
});
