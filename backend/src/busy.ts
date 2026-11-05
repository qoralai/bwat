import type { FastifyBaseLogger } from 'fastify';

/**
 * Busy protection (the QOR-4550 lesson): the seam is told when a bot is given a claim, so
 * that a deploy or scale-in can leave a bot in a meeting alone. A freed bot's protection is
 * cleared by the fleet pass (fleet.ts), which knows whether a stop is in flight. Protecting the task itself
 * (ECS task protection) is infra's implementation. Whether a bot is busy is never stored
 * here: GET /fleet derives it from the bot's live claim, so a lost call cannot drift it.
 */
export interface BusyProtection {
  markBusy(botId: string): Promise<void>;
}

/** The default, with no infra hook: nothing to protect. */
export const noBusyProtection: BusyProtection = {
  markBusy: async () => {},
};

/**
 * Tells the seam which bots became busy, after the claim change has committed. Best effort: a failure is logged with its code only and never fails the
 * request, since the claim change it follows has already happened.
 */
export async function settleBusy(
  busy: BusyProtection,
  log: FastifyBaseLogger,
  marked: string[],
): Promise<void> {
  for (const result of await Promise.allSettled(marked.map((id) => busy.markBusy(id)))) {
    if (result.status === 'rejected') {
      log.error({ event: 'busy.failed', code: (result.reason as { code?: unknown } | undefined)?.code }, 'busy protection failed');
    }
  }
}
