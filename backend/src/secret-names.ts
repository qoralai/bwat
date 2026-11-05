/** The Zoom tier-2 secrets by what they are: the one place each name is spelled. */
export const SECRET = {
  /** The install's own Zoom app: the Meeting SDK's key and secret, and its webhook secret token. */
  zoomClientId: 'zoom.client_id',
  zoomClientSecret: 'zoom.client_secret',
  zoomWebhookSecret: 'zoom.webhook_secret',
  /** The board app's client secret, which Zoom seals the app context with. */
  zoomBoardClientSecret: 'zoom.board_client_secret',
  /** The recording-token app: a Server-to-Server OAuth app on the install's Zoom account. */
  zoomS2sAccountId: 'zoom.s2s_account_id',
  zoomS2sClientId: 'zoom.s2s_client_id',
  zoomS2sClientSecret: 'zoom.s2s_client_secret',
} as const;

/**
 * The tier-2 secrets (backend/README.md, Secrets): the only core names the store keeps, beside the plugins'
 * own. Anything else is refused, a startup (tier-1, BWAT_*) secret above all: those come from
 * the env only.
 */
export const TIER2_NAMES = [
  'provider.openrouter',
  'provider.anthropic',
  'provider.openai',
  'provider.cerebras',
  'provider.deepgram',
  'provider.custom',
  ...Object.values(SECRET),
] as const;
export type Tier2Name = (typeof TIER2_NAMES)[number];
export const isTier2Name = (name: unknown): name is Tier2Name => (TIER2_NAMES as readonly unknown[]).includes(name);
