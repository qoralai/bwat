# bwat-web

One image (D169): the board and admin pages, Google sign-in, `/whoami`, the board's
transcript download, `/version` and `/health`, on port 8080. Node 22, Fastify.

The pages are static files: `pages/board/` at `/` and the admin build (`dist/admin`) at `/admin/`, outside the board's root so only the signed-in gate reaches it. They call the backend and the card
service with relative `/v1/...` paths; the edge (the load balancer, or Caddy on a
single host) routes those, so this server proxies nothing and a `/v1` path that
reaches it is a 404.

## The board page (D173, D181)

`pages/board/board.html` (the meeting desk, served at `/`) is the prototype's page, ported as
it was. It still speaks the prototype's data paths (`board_feed.json`, `/assign`,
`/route`, ...); `pages/board/bwat-api.js`, loaded before the desk's own scripts, wraps
`window.fetch` and answers those paths from the backend and the card service,
with the person's id_token from `/whoami` as the bearer. It is the one file to
read for what the page calls. It also cleans the card writer's HTML before the
page sees it (a short allowlist, https links only).

Every feature of the prototype's page is on. What bwat does not hold answers
honestly: merged cards offer Undo merge, and a hand-off's
status stays "Queued" (bwat never claims it was read).

**Open to-dos** (`?source=open`, the desk header's last switch beside This meeting, Today,
This week and All meetings) lists every meeting's open to-dos with no time window: each
page of the card service's `GET /v1/cards?status=open` (`/open-todos` in `bwat-api.js`).
Mine reads `owner=me`, the viewer's own cards by member, never a name the room said;
Everything and Unassigned read everyone's. A closed, archived, merged or answered card is
never in it. The meeting views are unchanged.

## The admin panel (D173)

`admin/` is the prototype's React panel (Vite), built into `dist/admin` and served from
there at `/admin/` to signed-in people only. Pages are hash routes (`#/members`), so the server needs no fallback. It
calls the backend under `/v1` with the id_token from `/whoami` as the bearer: members
and roles, settings, model keys, the Zoom credentials and the plugins' own (status only, never a
value), the bots and send/recall. `admin/src/catalogue.ts` is a copy of the backend's
settings catalogue: keep the two in step.

Four tabs: Overview, Members, Settings and Plugins. The Overview opens first: one sentence
on whether bwat is working (or what needs you, with the fix), the setup steps still open,
automatic joining's four checks with Recheck setup, one line per bot, Send bwat, and Recent
meetings, each opening its board at `/?meeting=<id>`, with failed sends among them. Reason
codes read as sentences from one map, `admin/src/reasons.ts`. Old links (`#/status`,
`#/history`, `#/dictionary`) land on their new homes.

Settings is five places, one at a time: Meeting bot, Cards, Models, Data and Connections;
a member sees Meeting bot, Cards and Data as sentences. Models holds every model setting:
the card writer's model (behind Change model), the Jev model and the provider keys. The
join timings and the Jev tuning thresholds are not offered: their stored values and
defaults still apply. Changes to catalogue settings wait in one page-level draft behind one
save bar, which saves every changed key in one `PUT /v1/console/settings` with the
revisions it read, so a stale save is refused as a whole. The card writer's model, each
provider key and the Dictionary save on their own buttons.

Meeting bot has the **picture** (owners and admins, D196): a 16:9 tile of what the bot
shows as its video, with its name, an upload (PNG or JPEG, 16:9, up to 2 MB,
checked in the page from the file's header and again by the backend) and "Use the
default". The default logo is `admin/public/presence-default.png`, a copy of the bot's
`bot/presence/default.png` that a test keeps byte for byte the same.

## Sign-in (D141, D180)

Google's code flow with PKCE and offline access. The sealed session cookie holds the
person's id_token and refresh token; nothing else of theirs is stored. `GET /whoami`
refreshes the id_token server-side when it is within 5 minutes of expiry and answers
`{ member, id_token }`, the member read from the backend's `GET /v1/me`. The page
sends that id_token as its bearer on every `/v1` call and asks `/whoami` again on a
401. `/admin` sends a signed-out visitor straight to Google. That is a sign-in gate
only: the backend checks membership and role on every `/v1` call, so the admin pages
hold nothing a signed-in non-member may not read.

| Route | What |
|---|---|
| `GET /health` | 200, no session |
| `GET /` | the board page |
| `GET /admin/` | the admin panel, signed in only |
| `GET /auth/login`, `/auth/callback`, `/auth/logout` | Google sign-in; `/auth/login?back=` lands on that path of this site afterwards (another site, or none, lands on `/`) |
| `GET /whoami` | the member, a fresh id_token, and `occurrence_id`: the Zoom meeting the board was opened from (null outside Zoom); 401 when signed out. A request that selects a plugin's sign-in (`X-Bwat-Surface`, below) answers that plugin's bearer only, with `embedded: true`, or 401, never another sign-in; `400 bad_surface` for a header that is not exactly a plugin's token, `404 surface_unavailable` while that plugin is off, `503 plugins_unavailable` while the backend's plugin list cannot be read |
| `GET /board-plugins` | the web plugins that are on (`{name, token, scripts}`) and every token a plugin claims (`reserved`), for the board page before it asks who anyone is; no sign-in, `no-store`; `503 plugins_unavailable` while the backend's plugin list cannot be read |
| `GET /plugins/<name>/<script>` | a web plugin's board script or asset, only one it lists and only while it is on (404 otherwise; 503 while the list cannot be read); no sign-in, as the board's own scripts |
| a plugin's own paths | each web plugin's routes, at the exact paths it declares; 404 while it is off, a `502` page while the backend's plugin list cannot be read (each plugin's README) |
| `GET /transcript?source={meeting id}` | that meeting's transcript as a `.txt` download, every page read from the backend as the person (a request selecting a plugin's sign-in: that plugin's bearer only, refused as at `/whoami`; otherwise their session, else their board token inside Zoom); 401 signed out, 404 for a meeting they may not read |
| `GET /version` | `{ version }` from `BWAT_VERSION`; 404 when it is unset |

## Web plugins (QOR-4890)

A backend plugin (the backend README, Plugins) may have a web side: `plugins/<name>/`, one line
in the registry `server/src/plugins/index.ts` (the only core file that imports a plugin's
folder; eslint and a guard enforce it). The contract is `server/src/plugins/plugin.ts`. A web
plugin may bring:

- board-page scripts (`plugins/<name>/board/`), served at `/plugins/<name>/<file>`, only the
  files it lists; and assets, other scripts in that folder served the same way but never loaded
  into the board (the script of a page of its own: no page runs an inline script);
- its own routes, at the exact paths it declares (start fails on any other, or on a core path);
  a plugin with no sign-in of its own serves them to the ordinary signed-in person: they pass the
  board's sign-in gate first, as the board's pages do;
- its own sign-in, chosen by its selector token (below).
- links the board draws in its slots (`links`), each to one of its own paths: `nav` in the app
  header, `meeting` in one meeting's line beside its transcript, with the meeting's id put in for
  `{meeting_id}`. The board reads them from `GET /board-links` (the plugins on, names and paths
  only); core never names a plugin, as hosts with plugin menus do (Calibre's actions, VS Code's
  menus): the slots are core's, what goes in them is the plugin's. Only the web board draws them:
  not the board inside Zoom (a link would replace it in its panel), a page a plugin signs in (a
  link would leave its sign-in);
- on a page that selects it, its own send targets: its board script's provider gives
  `sendLabel`, `listTargets()` and `route(card, row, { request_id })`, and the board's send action
  then lists its rows and hands a pick to it, never to the person's sessions (no default, no note);
  otherwise Send to Claude is unchanged (`pages/board/bwat-api.js`, sendTargets);
- on every board page, its board features: tags on cards, a row in a card, a section on a
  meeting's board, a narrowed board and a page of its own (`plugins/README.md`, What a plugin may
  add to the board). Every board page reads `/board-plugins` for them, the plain board included;

**Which plugins run is the backend's to say.** The backend's `GET /v1/plugins` (the
admin panel's Plugins page switches them) is the one list; the web server has none of its own, only the code it ships. A
plugin is on while the backend lists it and its entry meets what the web code requires (a plugin
that embeds the board needs `embeds: true`); a disagreement either way (the backend lists a
plugin that embeds the board with no web code here, or code that does not fit what the backend
says) is logged as an error and the plugin stays off. The list is read only by a request that
needs a plugin (its sign-in, routes or scripts, `/board-plugins`), and is used for 30 s; a failed
read is never kept, and then every plugin surface is refused (fail closed), never answered without
the plugin. So for up to 30 s after the backend switches a plugin off, the web server may still
admit a page asking for it; the backend refuses that plugin's board tokens at once (the card
service may honour one for up to 60 s more), so the page's calls are signed out.

**Which sign-in a request uses is chosen before any credential is read**, never by which cookies
ride along. A page navigation says it with `?surface=`, a request the page makes with the
`X-Bwat-Surface` header (a navigation carries none):

- No selector (or, on a page, `?surface=zoom` or `?surface=web`, the board's own views): the
  ordinary sign-in, Google or Zoom, which never reads a plugin's credential.
- On a page, any other `surface` value, empty included, that no plugin here claims (its web code
  missing, an old link): a `404` page, never the ordinary sign-in; the page stops the same way.
- A plugin's token: that plugin's sign-in answers alone. Signed out: 401 (or the plugin's page);
  the plugin off: 404; the backend's plugin list unreadable: 503. Never Google or Zoom.
- More than one `surface` on a page: a `400` page. A header that is not exactly one plugin's
  token (an unknown value, a view, two headers): `400 bad_surface`, before anything is read.

Sign-in never lands back on a page selecting a plugin (`/auth/callback` drops the `surface`).

**The board page waits for the plugins.** `bwat-api.js` first reads `/board-plugins` and loads
the scripts of the plugins that are on, each registering itself (`window.bwatBoard.register`),
before any identity or data request. A page asking for a plugin's sign-in marks every request it
makes to this site with that plugin's token, and a 401 there is the plugin's to show, never a
Google sign-in or a retry. If that plugin is off, its script does not load or registers nothing,
or the list cannot be read, the page stops on "This board is not available here. Close it and open
it again." and asks nothing more. Once loaded, the page stops only when `/whoami` refuses the
plugin (400 or 404); a 503 (the list unreadable for a moment) is retried with the next request,
and the server answers nobody meanwhile. A page asking for no plugin (no `?surface=` at all)
does not read the list or load any plugin's script, and carries on without them. Each plugin
documents its own web side in `plugins/<name>/README.md`.

## Invite the meeting bot inside Zoom

The Zoom meeting board shows whether its bot is absent, queued, joining, waiting for
admission, or no longer reporting; the banner disappears once it joins.
Any linked, active member can select
**Invite bot**. The backend verifies a fresh Zoom app context against that member,
looks up the occurrence with the installation's Server-to-Server OAuth app, and
passes the join details to the allocator. No invitation link needs to be pasted;
passcodes are never returned to the board. Duplicate requests share one claim.
An explicit invitation can retry a departed bot but cannot reopen an ended or deleted meeting.

In **Settings**, a bwat admin/owner or the current Zoom meeting host can ask the bot
to leave after confirming. This stops transcription and preserves existing records.

The board app needs the `getAppContext` capability (the generated manifest includes it);
to check or add it, see [Create the board app](../docs/onboarding.md#create-the-board-app). The S2S app needs `meeting:read:meeting:admin` access to the
meeting host's account. Unreadable meetings show a lookup error, not a false success.
Breakout rooms are unsupported. `/?surface=zoom` previews the narrow panel in a
browser, but actual presence and invitations require opening it inside Zoom.

## Dictionary

The **Dictionary**, at the foot of the admin's Settings, Cards (`/admin/#/settings?place=cards`), manages preferred spellings and
explicit heard-as corrections through `/v1/console/corrections`. Any signed-in member
can edit it. Saves check the loaded revision so another person's changes are not
overwritten. People and other dictionary fields are preserved when editing words.

Bots pick up saved corrections on their next settings check (about 30 seconds).
Corrections match complete words or phrases, longest first, without fuzzy matching.
“Only when capitalized” restricts an alias to a capitalized occurrence. Typed chat
and existing transcripts are unchanged. Original ASR text and speaker labels are
retained beside corrected segments, with the dictionary version, in transcript reads.
An absent or cleared custom dictionary means no corrections; this install ships no
company-specific vocabulary. Invalid dictionaries leave the bot's last good settings
in use and report a settings-read failure.

## Environment

| Name | What |
|---|---|
| `BWAT_PUBLIC_URL` | The install's public address; the OAuth redirect is `<url>/auth/callback`. Cookies are `Secure` when it is https. |
| `BWAT_GOOGLE_CLIENT_ID`, `BWAT_GOOGLE_CLIENT_SECRET` | The web OAuth client. Its id must also be in the backend's `BWAT_GOOGLE_CLIENT_IDS`, or `/v1/me` refuses the page's token. |
| `BWAT_SESSION_SECRET` | 32 random bytes, base64 (`openssl rand -base64 32`): seals the cookies. |
| `BWAT_TIER` | Optional (D202). `local`: an install on one computer with no Google, where `/auth/login` is a form for the install's code and an email, sent to the backend's `POST /v1/code-signin`; the session holds the backend's board token, for the same 12 hours. The two Google settings are then not needed (of the first five, four are), and `/auth/zoom-link` and `/auth/pair` are `404`. Any other value, or unset: Google, as above. |
| `BWAT_BACKEND_URL` | The backend's internal address, for `/whoami`'s `GET /v1/me` (`http://backend:3000` on compose). |
| `BWAT_VERSION` | Optional; the build shown in the board's footer (`/version`). |
| `BWAT_FRAME_ANCESTORS` | Optional; who may frame the board besides Zoom (the board inside a plugin's product), added to the CSP's `frame-ancestors`: space-separated, each `https://host`, `https://host:port`, `https://host:*` or a bare scheme such as `qv:` (never `https:`, `http:`, `data:` or `blob:`). Anything else stops the server starting. Set the backend's to the same. |
| `BWAT_TRUST_PROXY` | Optional, read as the backend reads it: whether `X-Forwarded-For` and `-Proto` name the client. Off when unset, empty, `false` or `0`; `true` trusts every hop; anything else is a comma-separated list of proxy addresses or CIDRs. A hop count stops the server starting. A plugin's route may limit failed tries per client address (the board inside a plugin's product does), so behind the edge or a load balancer set it to their addresses (the load balancer's subnet CIDRs, never `true`), or every client shares one address and one client's bad links hold up everyone's. |
| `BWAT_WEB_ADMIN_DIR`, `BWAT_WEB_PLUGINS_DIR` | Optional; the admin build (default `dist/admin`) and the web plugins (default `plugins/`). |

With any of the first five unset, sign-in is off: `/health` and the pages still serve,
and `/auth/*`, `/admin`, `/whoami`, `/transcript` and every plugin's own paths answer 503
`sign_in_not_configured`. With no backend address there is no plugin list either: `/board-plugins`
and plugin scripts answer 503.

```bash
npm ci
npm test
npm run build      # the server and the admin bundle
npm run dev        # the server
```
