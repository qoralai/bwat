import { settingAt, type SettingsRead } from './settingsRead';

/**
 * Every reason code the backend and the bot set (a claim's refused_reason and
 * last_placement_failure, a bot's reported error), as a sentence and, where a person can do
 * something, the fix. The admin never shows a code raw. reasons.test.ts reads the codes from
 * the code that sets them. A wait an install sets is read from its settings; one it cannot
 * set is said without its number.
 */
export type Reason = {
  say: string;
  fix?: string;
  /** For the Overview's "Needs you: …" line, when a bot reports it. */
  need?: string;
  /** The fix as buttons, the first the main one. */
  actions?: readonly { label: string; href: string }[];
};

/** Where the provider keys are. */
const MODELS = '#/settings?place=models';

/** A setting's minutes, as the reader of a reason needs them. */
type Minutes = (key: string) => number;
const plural = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;
/** " within 15 minutes", or nothing for no limit (0). */
const within = (n: number) => (n > 0 ? ` within ${plural(n)}` : '');

export const REASONS: Readonly<Record<string, Reason | ((minutes: Minutes) => Reason)>> = {
  waiting_room_timeout: (minutes) => ({
    say: `The host didn't let bwat in from the waiting room${within(minutes('waiting_room_min'))}.`,
    fix: 'Ask the host to admit bwat. For meetings in your Zoom account, keep Skip the waiting room on (Settings → Meeting bot).',
  }),
  waiting_for_host_timeout: (minutes) => {
    const n = minutes('wait_for_start_min');
    return {
      say: n > 0 ? `The meeting didn't start within ${plural(n)} of bwat arriving.` : "The meeting didn't start while bwat waited.",
      fix: 'Send bwat again once the host has started the meeting.',
    };
  },
  unable_to_connect: {
    say: "bwat couldn't reach Zoom.",
    fix: "Usually brief. Send bwat again; if it keeps happening, check this server's internet access.",
  },
  sdk_auth_failed: {
    say: "Zoom didn't accept the main app's credentials, so bwat couldn't sign in to join.",
    fix: "Replace the Main app's client ID and secret in Settings → Connections.",
  },
  zoom_join_failed: { say: 'Zoom refused to let bwat join.', fix: 'Check the meeting link and passcode, then send bwat again.' },
  obf_user_not_in_meeting: {
    say: 'Zoom wants the person who invited bwat to be in the meeting first.',
    fix: 'Join the meeting yourself, then send bwat again.',
  },
  app_cannot_join_external: {
    say: "This meeting is hosted outside your Zoom account, and the main app isn't allowed to join those.",
    fix: 'Publish the main Zoom app, or ask the host to send bwat from their own account.',
  },
  app_cannot_join_anonymously: {
    say: 'The meeting only lets signed-in Zoom users join.',
    fix: "Ask the host to allow bwat, or turn off 'Only authenticated users can join' for this meeting.",
  },
  allocations_exhausted: { say: "bwat tried more than once and couldn't get in." },
  no_bot_available: { say: 'No bwat bot was free in time.', fix: 'Wait for a meeting to end, or add a bot, then send bwat again.' },
  lease_expired: { say: 'The bot in this meeting stopped answering, so bwat let the meeting go.', fix: 'Send bwat again; another bot takes it.' },
  drain_expired: { say: 'The meeting had ended; bwat finished writing up and left.' },
  meeting_deleted: { say: 'The meeting was deleted in Zoom before bwat got in.' },
  meeting_already_ended: { say: 'The meeting had already ended when bwat got in.' },
  bridge_failed: { say: "The bot's connection to Zoom broke.", fix: 'Send bwat again. If it repeats, restart the bot.' },
  removed_by_host: { say: 'The host removed bwat from the meeting.' },
  occurrence_conflict: { say: 'Zoom put bwat in a different sitting of the meeting from the one it was sent to, so it left.' },
  authorized_user_left: { say: 'The person bwat joined for left the meeting, so Zoom took bwat out too.' },
  zoom_end_unknown: { say: 'Zoom took bwat out of the meeting without saying the meeting had ended.', fix: 'Send bwat again if the meeting is still going.' },
  recalled: { say: 'Someone recalled bwat from the meeting.' },
  meeting_ended: { say: 'The meeting ended.' },
  left_alone: { say: 'Everyone else left, so bwat left too.' },
  idle: (minutes) => ({ say: `Nobody spoke for ${plural(minutes('idle_leave_min'))}, so bwat left.` }),
  bridge_down: {
    say: "This bot can't start its Zoom connection.",
    fix: 'Restart the bot. If it repeats, check the Zoom Meeting SDK is installed.',
    need: "a bot can't start its Zoom connection",
  },
  transcription_unavailable: {
    say: "This bot can't reach the transcriber.",
    fix: 'Check the Deepgram key in Settings → Models.',
    need: "a bot can't reach the transcriber",
    actions: [{ label: 'Check the key', href: MODELS }],
  },
  model_out_of_credit: {
    say: 'OpenRouter is out of credit, so bwat stopped writing the transcript. It stays in the meeting.',
    fix: 'Add credit on OpenRouter. bwat picks up again on its own.',
    need: 'OpenRouter is out of credit',
    actions: [
      { label: 'Add credit on OpenRouter', href: 'https://openrouter.ai/settings/credits' },
      { label: 'Check the key', href: MODELS },
    ],
  },
};

const UNKNOWN: Reason = { say: 'Something went wrong.', fix: 'Send bwat again. If it keeps happening, check the bot is running.' };

/** A code in words, its waits as `read` sets them (the defaults without one). */
export function reasonOf(code: string, read?: SettingsRead): Reason {
  const reason = REASONS[code];
  if (!reason) return UNKNOWN;
  return typeof reason === 'function' ? reason((key) => Number(settingAt(read, key))) : reason;
}
