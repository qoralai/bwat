// A write the board makes on a card marks that card's week to read again at once (bwat-api.js
// WRITES); the card service's counts can lag it by up to ten seconds. A new card-service write
// route must be listed here as one of those, or as one that never needs it, with the reason.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

// Card-service write route (method and path pattern, as cards/api/app.py lists it) -> the
// board's route that makes it.
const READ_AGAIN: Record<string, string> = {
  'PUT ^/v1/cards/([^/]+)/owner$': '/assign',
  'POST ^/v1/cards/([^/]+)/archive$': '/archive',
  'POST ^/v1/cards/([^/]+)/unarchive$': '/unarchive',
  'POST ^/v1/cards/([^/]+)/keep$': '/keep',
  'POST ^/v1/cards/([^/]+)/unmerge$': '/unmerge',
  'PATCH ^/v1/cards/([^/]+)$': '/edit',
  'POST ^/v1/cards/([^/]+)/clarify$': '/clarify',
  'POST ^/v1/cards/([^/]+)/hint/dismiss$': '/hint-dismiss',
  'POST ^/v1/cards/([^/]+)/hint/act$': '/hint-act',
  // The backend's hand-off, which writes "Queued" on the card through the card service.
  'POST /v1/handoffs': '/route',
};
const NEVER: Record<string, string> = {
  'POST ^/v1/editing$': 'a heartbeat every 8 s while a card is open; it changes no card',
  'PUT ^/v1/orders$': 'a drag order, read on its own (/order); it changes no card',
  'POST ^/v1/cards/([^/]+)/move-back$': 'the board has no Move back button yet; the one that adds it marks both weeks',
};

it('marks the week of every card write a person makes, or says why it need not', () => {
  const app = readFileSync(join(ROOT, 'cards', 'api', 'app.py'), 'utf8');
  const routes = [...app.matchAll(/\("(POST|PUT|PATCH|DELETE)", re\.compile\(r"([^"]+)"\), "person"/g)].map((m) => `${m[1]} ${m[2]}`);
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) expect(READ_AGAIN[route] ?? NEVER[route], route).toBeDefined();

  const api = readFileSync(join(ROOT, 'web', 'pages', 'board', 'bwat-api.js'), 'utf8');
  const writes = JSON.parse(/const WRITES = new Set\((\[[^\]]*\])\)/.exec(api)![1]!.replace(/'/g, '"')) as string[];
  expect(new Set(writes)).toEqual(new Set(Object.values(READ_AGAIN)));
});
