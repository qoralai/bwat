# The jira plugin, web side (`jira`)

Its board script (`board/board.js`), a feature plugin (`../README.md`, What a plugin may add to
the board), and its setup card on the admin panel's Plugins page (`admin/Setup.tsx`). The
backend side and its routes: `backend/src/plugins/jira/README.md`. On while the backend runs the
`jira` plugin.

| Hook | What it shows |
|---|---|
| `start` | asks `GET /status` once; while the install has Jira set up, the board offers the button |
| `cardData` | the issue each card was sent to (`GET /issues?cards=`, 50 cards a read) |
| `cardAction` | the card's issue key, linking to it; else Route to Jira on an open to-do or risk, which files it (`POST /cards/{id}`, a minute at most) and says "In Jira as ABC-1." |

The setup card connects Jira: the site, the project key and the account email (the plugin's
settings) and the account's API token (its secret, `jira.api_token`), then asks Jira whether the
account reaches the project (`POST /check`), and says why when Jira refuses it.
