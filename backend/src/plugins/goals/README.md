# The goals plugin (`goals`)

Switched on by an owner or admin on the admin panel's Plugins page; how plugins work: the backend README, Plugins.

A company's goals for a period, shown on the board and linked to the cards that serve them
(QOR-4921). It rebuilds QOR-4891's goals (taken out of core by QOR-4906 and QOR-4924) as a
plugin, generic for any team: one goal list per install whose rhythm is a setting (a week by
default; also 2 weeks, a month or a quarter). Every goal carries its list, so named lists can
come later without touching the goals. Its data is the `goals` schema
(`backend/migrations/plugins/goals/`): `goals.lists`, `goals.goals`, `goals.card_links`.
Core never references it.

**Periods.** "Today" is the day in the list's timezone, by the server's clock. A week starts on
Monday; 2 weeks on a Monday counted from the list's `anchor`; a month on the 1st; a quarter on
1 January, April, July or October. A period's goals are those whose `period_start` falls in it,
so goals set under an earlier rhythm still show in the period now holding their date. Labels
(`G1`, `G2`, …) number a period's goals (state `goal`) in board order (the day each was set
for, its position, then when added); a draft or a dismissed goal has none.

**Goals.** `state` is `draft`, `goal` or `dismissed` (never deleted). `outcome` (`met`,
`missed`, `carried`, or null) is decided by an owner or admin; `carried` makes one copy in the
next period (`carried_from`), and moving away from `carried` dismisses that copy unless a person
touched it. `revision` goes up on every change; a write at another revision is
`409 stale_revision` with the goal as it is now. Caps: title 80 characters (trimmed, not blank),
summary 280, details 10 000.

Every route needs a signed-in person on an onboarded install (`401`, `403 not_onboarded`);
an unknown or malformed id is `404 not_found`.

| Route | Who | What |
|---|---|---|
| `GET /plugins/goals/current` | member | `{"list", "period": {"start", "end"}, "goals", "next": {"period", "goals"}, "can_decide"}`: this period's goals and the next one's, without dismissed ones; `can_decide` is true for an owner or admin |
| `GET /plugins/goals/goals?date=&include=dismissed` | member | `{"period", "goals"}` for the period holding `date` (default today) |
| `GET /plugins/goals/goals/:id` | member | One goal, labelled |
| `GET /plugins/goals/goals/:id/cards` | member | `{"goal": {"id", "label", "title"}, "card_ids"}`: every card serving the goal, for the board narrowed to it |
| `POST /plugins/goals/goals` | member | `{"title", "summary"?, "details"?, "date"?}` → `201` a draft in the period holding `date` (default today); `400 past_period` before this period |
| `PATCH /plugins/goals/goals/:id` | member | `{"revision", "title"?, "summary"?, "details"?, "position"?}` (at least one) → the goal; `409 dismissed` |
| `POST /plugins/goals/goals/:id/promote` | owner, admin | `{"revision"}`: a draft becomes a goal; `409 not_a_draft`; audit `goal.promoted` |
| `POST /plugins/goals/goals/:id/dismiss` | owner, admin | `{"revision"}`: a draft is dismissed; `409 not_a_draft`; audit `goal.dismissed` |
| `POST /plugins/goals/goals/:id/outcome` | owner, admin | `{"revision", "outcome": "met"\|"missed"\|"carried"\|null}`; `409 not_a_goal`, `409 carried_copy_edited`; audit `goal.outcome_set` |
| `GET /plugins/goals/links?cards=<id>,<id>` | member | `{"links": [{"card_id", "goal": {"id", "label", "title", "state"}}]}` for those of the cards (at most 200) that serve a goal; the board's tags read it in one request |
| `PUT /plugins/goals/cards/:cardId/goal` | member | `{"goal_id"}` → `{"card_id", "goal"}`: the card serves that goal (one per card); `404` for an unknown card or goal, `409 dismissed` |
| `DELETE /plugins/goals/cards/:cardId/goal` | member | The card serves no goal; `204` |
| `GET /plugins/goals/settings` | member | The list: `{"id", "name", "cadence", "timezone", "anchor", "revision"}` |
| `PUT /plugins/goals/settings` | owner, admin | `{"revision", "name"?, "cadence"?, "timezone"?, "anchor"?}` (`cadence` one of `week`, `2weeks`, `month`, `quarter`; `anchor` a Monday) → the list; audit `goals.settings_set` |

A card's delete takes its link with it. Every member reads every card (one company per
install, D140), so every link.

On the board (`web/plugins/goals/README.md`): tags, a Goal row in an opened card, the board
narrowed to a goal's cards and a Goals page. Not yet (QOR-4921's later phases): a one-line goals
strip above the cards; the goal filter in the board's filter column (QOR-4918); goals drafted from review meetings,
proposed outcomes, automatic links and carrying undecided goals over at a period's change,
which need a seam in the card writer.
