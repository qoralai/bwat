import type { FastifyReply, FastifyRequest } from 'fastify';

/** A request for a page inside a frame, as the browser itself says (Sec-Fetch-Dest). */
export const inFrame = (req: FastifyRequest): boolean => {
  const dest = req.headers['sec-fetch-dest'];
  return dest === 'iframe' || dest === 'frame';
};

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// One sentence on a page of its own: a fixed text, never anything from the request.
export const messagePage = (text: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>bwat</title></head>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:340px;margin:15vh auto;padding:0 16px;text-align:center">
<p role="status" style="margin:0">${escapeHtml(text)}</p>
</body></html>`;

// That page as the whole answer, never cached.
export const sendMessagePage = (reply: FastifyReply, status: number, text: string): FastifyReply =>
  reply.code(status).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(messagePage(text));

// The board, or a plugin's part of it, asked for while the backend's plugin list cannot be read.
export const PLUGIN_UNAVAILABLE = 'bwat could not open the board just now. Open the board again.';

// A board page inside a frame that is not Zoom's, signed out (Google refuses to be framed), or
// whose plugin sign-in ended: only the product framing it can open it again. A plugin that shows
// its own ended screen says the same.
export const SESSION_ENDED = 'Your board session ended. Close the board and open it again.';
