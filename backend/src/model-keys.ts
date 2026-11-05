import type { SecretStatus, SecretStore } from './secrets/store.ts';

/**
 * The model providers the company enters a key for: the keys the bot spends on, and
 * `custom`, the card writer's key for an OpenAI-compatible address of the deployer's own
 * (QOR-4910). They are kept in the secret store (D142) as `provider.<provider>` (secret-names.ts),
 * and fall back to the backend's own env while none is stored. Platform credentials are
 * never offered here.
 */
export const PROVIDERS = ['openai', 'anthropic', 'openrouter', 'cerebras', 'deepgram', 'custom'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The keys served to bots: `custom` is the card writer's only. */
const BOT_PROVIDERS = PROVIDERS.filter((provider) => provider !== 'custom');

export const isProvider = (value: unknown): value is Provider => (PROVIDERS as readonly unknown[]).includes(value);

export const secretName = (provider: Provider) => `provider.${provider}` as const;

/** The env variable (or its *_FILE form) each key falls back to while none is stored. */
export const MODEL_KEY_ENV: Record<string, string> = {
  'provider.openai': 'OPENAI_API_KEY',
  'provider.anthropic': 'ANTHROPIC_API_KEY',
  'provider.openrouter': 'OPENROUTER_API_KEY',
  'provider.cerebras': 'CEREBRAS_API_KEY',
  'provider.deepgram': 'DEEPGRAM_API_KEY',
  'provider.custom': 'CUSTOM_MODEL_API_KEY',
};

export type ModelKeyEntry = { provider: Provider } & SecretStatus;

export async function modelKeyEntry(store: SecretStore, provider: Provider): Promise<ModelKeyEntry> {
  return { provider, ...(await store.status(secretName(provider))) };
}

/**
 * Every key that can be read, for GET /bot/settings only. One that cannot be read
 * (another BWAT_ENC_KEY, a moved row, an aws error) is left out, so the bot falls back to
 * its own env; the backend's env never stands in for it (withEnvFallback). `onUnreadable`
 * is called for it: the answer is incomplete.
 */
export async function readableModelKeys(store: SecretStore, onUnreadable: (provider: Provider) => void): Promise<Record<string, string>> {
  // Read together: on aws each is a Secrets Manager call. Kept in PROVIDERS order.
  const values = await Promise.all(
    BOT_PROVIDERS.map((provider) =>
      store.get(secretName(provider)).catch(() => {
        onUnreadable(provider);
        return null;
      }),
    ),
  );
  const keys: Record<string, string> = {};
  BOT_PROVIDERS.forEach((provider, i) => {
    if (values[i] !== null) keys[provider] = values[i]!;
  });
  return keys;
}

export type CheckResult = 'valid' | 'invalid' | 'unreachable';
export type KeyChecker = (provider: Provider, key: string) => Promise<CheckResult>;

/**
 * Each provider's read-only key check: one GET that needs a working key and changes nothing.
 * `custom` lists the models at the card writer's address (BWAT_CARDS_MODEL_URL).
 */
const ENDPOINTS: Record<Exclude<Provider, 'custom'>, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/key',
  cerebras: 'https://api.cerebras.ai/v1/models',
  // Deepgram's own key check: a transcription-only key may not read the account.
  deepgram: 'https://api.deepgram.com/v1/auth/token',
};

const CHECK_TIMEOUT_MS = 5_000;

/**
 * valid on a 2xx, invalid on 401/403 (the provider refused the key), unreachable on
 * anything else: a timeout, a network error, 429, 5xx. The provider's body is never
 * read, so nothing it says reaches the panel or a log. `cardsModelUrl` is
 * BWAT_CARDS_MODEL_URL, where the custom key is checked; an http address is
 * unreachable, and is sent nothing.
 */
export function keyChecker(cardsModelUrl: string): KeyChecker {
  // As on GET /cards/settings, a key goes only to an https address.
  const customEndpoint = new URL(cardsModelUrl).protocol === 'https:' ? `${cardsModelUrl}/models` : null;
  return async (provider, key) => {
    const headers: Record<string, string> =
      provider === 'anthropic'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : { authorization: provider === 'deepgram' ? `Token ${key}` : `Bearer ${key}` };
    const url = provider === 'custom' ? customEndpoint : ENDPOINTS[provider];
    if (url === null) return 'unreachable';
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return 'valid';
      return res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  };
}
