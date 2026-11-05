/**
 * The card writer's model as an admin picked it. Kept in bwat.settings under
 * `cards_model`, but not in the settings catalogue: it is saved only through
 * PUT /console/cards-model, which checks the model with its endpoint before it stores it.
 *
 * `base_url` is the address it was checked against. The choice applies only while
 * BWAT_CARDS_MODEL_URL is still that address; otherwise BWAT_CARDS_MODEL does. `no_zdr`:
 * the admin saved it past the warning that no endpoint of it is on OpenRouter's
 * zero-data-retention list, so the writer may send to it without that routing.
 */
export const CARDS_MODEL_KEY = 'cards_model';

export interface SavedCardsModel {
  model: string;
  base_url: string;
  no_zdr?: true;
}

export const isSaved = (value: unknown): value is SavedCardsModel =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SavedCardsModel).model === 'string' &&
  typeof (value as SavedCardsModel).base_url === 'string';

/**
 * The model the writer uses: the saved one while it was checked against `baseUrl`, else
 * `envModel`. `chosen` is the saved choice in force; `elsewhere` one saved for another
 * address, which the admin page asks to pick again.
 */
export function effectiveCardsModel(saved: SavedCardsModel | null, baseUrl: string, envModel: string) {
  const applies = saved !== null && saved.base_url === baseUrl;
  return {
    model: applies ? saved.model : envModel,
    chosen: applies ? saved : null,
    elsewhere: applies ? null : saved,
  };
}

/**
 * The models the admin page suggests on OpenRouter, each the latest standard-tier model of
 * its family, as chosen on 28 Oct 2026. Pinned ids, updated each release; any
 * other id can still be typed in.
 */
export const SUGGESTED: readonly (readonly [id: string, label: string])[] = [
  ['anthropic/claude-opus-5.5', 'Claude Opus (latest: 5.5)'],
  ['anthropic/claude-sonnet-5.5', 'Claude Sonnet (latest: 5.5)'],
  ['openai/gpt-6-astra', 'GPT Astra (latest: 6)'],
  ['openai/gpt-6.1-sol', 'GPT Sol (latest: 6.1)'],
  ['openai/gpt-6.1-terra', 'GPT Terra (latest: 6.1)'],
];

/** One entry of an endpoint's GET /models; `pricing` is OpenRouter's, per token, as text. */
export interface ListedModel {
  id: string;
  pricing?: { prompt?: unknown; completion?: unknown };
}

const dollars = (perToken: unknown) => {
  const n = typeof perToken === 'string' ? Number(perToken) : NaN;
  // OpenRouter marks a price it cannot state (a router model) as -1.
  return Number.isFinite(n) && n >= 0 ? `$${Number((n * 1e6).toFixed(2))}` : null;
};

/** "$X / $Y per M tokens" from OpenRouter's per-token prices; null when either is not a price. */
export function pricePerMillion(pricing: ListedModel['pricing']): string | null {
  const prompt = dollars(pricing?.prompt);
  const completion = dollars(pricing?.completion);
  return prompt && completion ? `${prompt} / ${completion} per M tokens` : null;
}

const LIST_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 30_000;
// Tiny, as asked; 16 rather than 1, the least some providers accept for a reply.
const TEST_TOKENS = 16;

const authorization = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

/** The models the endpoint at `baseUrl` lists, or null when it cannot be read. */
export async function listModels(fetch: typeof globalThis.fetch, baseUrl: string, key: string | null): Promise<ListedModel[] | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: authorization(key), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = ((await res.json()) as { data?: unknown })?.data;
    if (!Array.isArray(data)) return null;
    return data.filter((m): m is ListedModel => typeof m?.id === 'string');
  } catch {
    return null;
  }
}

/**
 * One tiny chat call to `model`: null when it answered 2xx, else the status (or "no
 * answer"). Never reads the body, so nothing the provider says reaches a log or the page.
 */
export async function testCall(
  fetch: typeof globalThis.fetch,
  { baseUrl, key, model, zdr }: { baseUrl: string; key: string | null; model: string; zdr: boolean },
): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authorization(key) },
      body: JSON.stringify({ model, max_tokens: TEST_TOKENS, messages: [{ role: 'user', content: 'Say OK.' }], ...(zdr && { provider: { zdr: true } }) }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? null : String(res.status);
  } catch {
    return 'no answer';
  }
}
