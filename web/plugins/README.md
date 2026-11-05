# Web plugins

The web side of a backend plugin (`backend/src/plugins/<name>/`) lives in `plugins/<name>/`:
its board-page scripts in `board/`, its own web-server routes and its sign-in, registered by one
line in `server/src/plugins/index.ts`. Core never imports a plugin's folder; a plugin may use
core. The contract is `server/src/plugins/plugin.ts`; how plugins are switched on and chosen is in
the web README, Web plugins. Each plugin documents itself in its own `README.md`.

## Its setup card on the panel

A plugin with settings or secrets to enter (`backend/src/plugins/<name>/`, `settings` and
`secrets`) gives the admin panel a setup card: a React component in `admin/`, registered by one
line in `admin/src/pluginSetup.ts`, the panel's one file that imports a plugin's folder. The
Plugins page shows it under the plugin, to an owner or admin, while the plugin is on. It reads
and saves through the backend's `/v1/console/plugins/<name>/settings` and `/v1/console/secrets`,
with the panel's `api.ts`, and uses the panel's styles.

## What a plugin may add to the board

A plugin's board script registers once, with `window.bwatBoard.register('<name>', provider)`.
One that gives `start` is a **feature plugin**: it runs on every board page, the plain board
(no `?surface=`) included, while the backend lists it. Core names no plugin. Every hook below is
asked of each plugin that gives it, so two plugins on give two tags on a tile, two rows in a card
and so on (`pages/board/ui/plugins.js`, `pages/board/ui/live.js`). All but `start` are optional.
A person can hide a plugin from their own board in Settings: it still starts, but
`bwatBoard.features()` leaves it out, so none of its hooks are asked there.

| Hook | When the board asks | What it does |
|---|---|---|
| `start({ api, refresh })` | once, after the scripts load | `api(method, path, body)` calls `/v1/plugins/<name><path>` as the signed-in person and answers `{status, ok, data}`; it sets no timeout, so a plugin bounds its own calls (a race against a timer, say). `refresh()` reads the board again, for what the plugin learns after it starts (its own setup, say) |
| `tags(cardIds)` → `Promise<[{card_id, key, text}]>` | with every board read (each poll) | a small tag on each named card's tile; `card.tags` holds them as `{plugin, key, text}`. A failed read tags nothing |
| `readerRow(card, el, board)` | each time a card's detail panel is drawn | fills its own row, under the card's owner line |
| `meetingSection(meetingId, el, board)` | when one meeting's board is shown (`?source=<meeting id>`) | fills its own section at the bottom of that board, after the cards |
| `narrow(key)` → `Promise<{label, ids}>` | with every board read, while the address has `?narrow=<name>:<key>` | the board shows only those card ids (every type, on the Open to-dos view `?source=open` every meeting's), under a bar with `label` and × to clear it |
| `facets()` → `Promise<[{key, label}]>` | when the filters column opens | a group of its items in the ☰ filters column; one picked is `?narrow=<name>:<key>` on Open to-dos, so a plugin with facets gives `narrow` too |
| `pageLabel`, `page(el, board)` | when its page is opened (`?page=<name>`) | a link in the sidebar; the page in place of the cards |
| `cardData(cardIds)` → `Promise<[{card_id, ...}]>` | with every board read (each poll) | its own data on each named card, onto `card.pluginData[<name>]` (the whole row), for its other hooks to draw from; drawn nowhere by itself. A failed read gives no card any data |
| `cardAction(card)` → `{label, busy?, run(card, board)}` \| `{text, href}` \| `null` | each time a card's tile is drawn with its actions | a button in the card's action row, before Send: a press runs `run` once, the button `aria-disabled` (and labelled `busy`, if given) until it settles, however often the tile is drawn again; `run` bounds its own calls, as a run that never settles leaves it busy; or a link to `href` (https only) in a new tab. A plugin that throws adds nothing |

`board.refresh()` reads the board again, after the plugin changed something a tag shows;
`board.toast(text)` shows it briefly in the board's header line. A
plugin ships scripts only, so it styles its own insides from its script; `ui/plugins.css` draws
the parts core places (tags, rows, sections, the narrow bar, the page links) in the soft look.
