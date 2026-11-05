// What every reply of the onboarding server carries, and the small helpers its routes use.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    + "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

export type Request = { req: IncomingMessage; res: ServerResponse; url: URL };
export type Handler = (request: Request) => Promise<void> | void;

export function send(res: ServerResponse, status: number, body: string, type = TYPES['.json']!) {
  res.writeHead(status, { ...HEADERS, 'content-type': type });
  res.end(body);
}

export function json(res: ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value));
}

/** The request body parsed as JSON, at most 64 KiB. */
export async function body(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 65_536) throw new Error('body too large');
  }
  return text ? JSON.parse(text) : {};
}

/** A parsed body as an object to read fields from; anything else reads as empty. */
export const object = (value: unknown) => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

/** A 400 the route can throw: its message goes back to the page. */
export class Refused extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
