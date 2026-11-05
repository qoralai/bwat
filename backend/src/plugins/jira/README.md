# The jira plugin (`jira`)

Switched on by an owner or admin on the admin panel's Plugins page; how plugins work: the
backend README, Plugins. Its web side (the board button and the setup card):
`web/plugins/jira/README.md`.

Route to Jira: bwat files a card in Jira Cloud itself, as one Jira account, once the install has
Jira set up. Only Jira Cloud is supported: a site on a custom domain, and Jira Server or Data
Center, are not. It is set up once all four are set on its setup card: its settings
`jira_site_url` (the site's address, `https://<name>.atlassian.net` and nothing else: no other
host, path, credentials or query; stored without a trailing slash), `jira_project_key` (a
project key such as `ABC`) and `jira_account_email` (the Jira account the issues are filed as),
plain settings any signed-in member may read (an audit row shows the email only as `set`), and
its secret `jira.api_token` (a Jira API token for that account, set on the panel with the
others: `GET /console/secrets`). Until then the board offers no Route to Jira button.

The backend sends the Jira account's credentials to that site only, and refuses any redirect
from Jira. A site stored before this rule on any other address counts as not set up: the board
offers no Route to Jira button, the setup card shows Jira as not connected, and the backend logs
a warning naming the host (`jira.site_refused`, once per host each time it starts).

Its data is the `jira` schema (`backend/migrations/plugins/jira/`): `jira.card_issues`, the issue
each card was sent to, one per card, with who sent it and when; a card's delete takes it. Core
kept the issue on the card before (`cards.cards.jira_key`, `jira_url`): `0001` copies those,
`0002` drops them, in that order on every upgrade, the plugin on or off.

**Its start step.** The Jira account's email was once the secret `jira.email` (a retired secret
now). At each start the plugin moves a stored `jira.email` (one from before, or one
`npm run seed-secrets` stored since) into `jira_account_email` and deletes the secret. A setting
already saved, a reset included, is never overwritten: then the secret is only deleted; if the
move fails it logs `jira.email_not_moved` (the error's name only) and tries again at the next
start.

Every route needs a signed-in person on an onboarded install (`401`, `403 not_onboarded`).

| Route | Who | What |
|---|---|---|
| `GET /plugins/jira/status` | person | `{"enabled": true \| false}`: whether all four are set. Nothing else about them |
| `POST /plugins/jira/check` | owner, admin | Asks Jira for the project as the stored account (`GET {jira_site_url}/rest/api/3/project/{key}`, basic auth): `200 {"result"}`, one of `connected`, `refused` (401, 403: Jira refused the token), `no_project` (404) or `unreachable` (anything else, or no answer). The setup card's Connect. `409 jira_not_configured` until all four are set. Logs the result and Jira's status, never the token |
| `GET /plugins/jira/issues?cards=<id>,<id>` | person | `{"issues": [{"card_id", "key", "url"}]}` for those of the cards (at most 200) the card service has (`POST {BWAT_CARDS_URL}/v1/cards/facts`) that were sent, or that a card merged into them was: the issue stays on the card it was filed for, and a merge carries it to the survivor. For the board's link |
| `POST /plugins/jira/cards/{id}` | person | Files the card as a `Task` in the project (`POST {jira_site_url}/rest/api/3/issue`, basic auth `jira_account_email:jira.api_token`): the card's title as the summary; its note, each quote with its speaker and `Sent from bwat by <name>` as the description, read from the card service (`GET {BWAT_CARDS_URL}/v1/cards/{id}/content`). Keeps the issue, then adds `Sent to Jira as <KEY> by <name> at <time>` to the card (`POST .../v1/cards/{id}/note`). `200 {"key", "url", "revision"}` (`revision` is the card's new one). A card already sent, or one a sent card was merged into, answers its issue (`{"key", "url"}`) and creates no other; a press that lost a race to another answers the first issue, and its own stays in Jira unlinked. A line the card service could not take is written by the next press. `409 jira_not_configured` until set up; `502 jira_failed` with `status` (Jira's) when Jira refuses or cannot be reached (`0`); `502 cards_unavailable` when the card service does not answer |

Switched off, the board shows no button and no issue links; the issues stay, and the card's
`Sent to Jira` line is the card's own text. Turning it off asks first: "Its links to N Jira
issues disappear from the board".

The token is used only in the call to Jira: no answer and no log line carries it. Logs carry
`jira.created` (member and card ids, the issue key) and `jira.failed` (card id, Jira's status).
