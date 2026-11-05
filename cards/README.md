# bwat-cards

Follows every bot in a live meeting, turns the conversation into cited cards, and serves
them over an API. It renders no HTML: the web app is the only UI.

Python 3.12, Postgres.

```bash
pip install -r requirements-dev.txt
pytest -q
```

The service is one process (`python .`, the image's command): it reads every live
meeting's transcript from the backend, writes cards, and serves the card API on
port 8000. Its environment is listed at the top of `service.py`.

```bash
docker build -t bwat-cards .
```

The first thing written here is the truncation guard: any finish reason other
than a normal stop is an error and the writer's position does not advance.
Without it a truncated model reply parses as "no cards" and the writer silently
skips that stretch of the meeting.

The card writer also publishes how far it has processed the transcript, because
the end-of-meeting write-up waits for it rather than reading a half-written
board.

## Card updates and merging

The writer reads 60 preceding transcript frames as context and groups consecutive
speech while keeping every frame's citation marker. Only new frames can supply evidence.
Later speech can revise a card's title or add context. A human-edited title is protected;
human notes, ownership and task status are not overwritten by a context revision.
Cross-meeting revisions add context without rewriting the original title, so deleting
the source meeting removes its contribution everywhere.

After the final transcript read, a separate worker compares up to 200 recent cards,
within a bounded prompt; a busy board may leave some eligible duplicates unexamined.
Both cards must have been created within the preceding 120 hours. Same-type duplicates
keep the older title and ID and gain new context and evidence. Different types may be
linked as related. Cards with different owners are not merged automatically.
Duplicate discovery sees candidate context; a separate summary call sees only the
newer card's base content. Each proposed merge therefore needs an additional model
call, preventing another meeting's context from being copied into its summary.
Undo merge revokes the link and its added context without rewinding later edits, and
the same pair is not automatically merged again. Evidence stays attached to its source.

Reconciliation jobs persist across restarts and retry failures with exponential backoff.
Cards changed during the model call are reconsidered with fresh context on a retry.
After five failed attempts (including worker crashes) a job is parked, not marked complete; new transcript
progress resets it. Settings, credit and provider outages back off without spending this
allowance, so reconciliation resumes when service returns.
On upgrade or restart, ended meetings from the last five days with saved transcript
positions and unfinished reconciliation are read and queued once. This uses the
configured model and its budget; it does not rewind extraction or regenerate old cards.
Apply backend migrations before starting the updated card service. The gateway must
route `POST /v1/cards/{id}/unmerge` to cards; the board sends its displayed revision and
the ID of the card from which Undo was clicked (`via`). Member authentication is required.

## Duplicate hints during the meeting

With Jev available, each card's newest create or revise (by the writer, a person or the
clean-up) queues one check in `cards.card_checks`; a batch of up to 10 cards of a meeting
is one Jev Decisions call with two `choice` questions per card. Each names one card of the
SAME meeting, or none: a card of the same kind about the same thing (`dup_card_id`), and a
card of another kind that belongs with it (`rel_card_id`), each with its confidence. Jev
picks only from the meeting's open cards (not archived, closed, merged away, answered or
superseded; never the card itself), live or not; duplicates across meetings are left to the
clean-up after the meeting. A pick at the link threshold (`jev_link_threshold_pct`) puts a `hint` on the card in the board
payload, `{"duplicate": {"card_id", "display_id", "title"} | null, "related": ... | null}`;
a side hides once its card is off the board, the pair is dismissed, or (related) a related
link joins the two.

A person dismisses that pair for good (`POST /v1/cards/{id}/hint/dismiss {kind}`: a
`not_duplicate` or `not_related` link to the named card, which the clean-up then never
merges or links) or acts on it (`POST /v1/cards/{id}/hint/act {kind}`): Merge now merges
the pair into the older card, with the writer's model and key for the summary as the
clean-up uses them; Link now links it, with no model call. Both run under the clean-up's
lock and try once more if a card changed meanwhile; if the named card has gone, the answer
is `gone` and that side clears. The gateway must route `/v1/cards/*/hint/*` to cards.

## Keeping a card

A live card nobody acts on for 10 days closes as no response; from day 5 it carries
`expires_in_days`. Any action of a person's starts those 10 days again. `POST
/v1/cards/{id}/keep {"revision"}` is Keep: a person's action like any other, recorded as their
`card.keep` event, and it keeps the card on the board until a person closes it. A card kept
once never expires and never carries `expires_in_days` again (the owner keeping it accepts it,
as any action of theirs does). A stale revision is `409 {"error": "stale_revision"}`; a card
that is not live on the board (a draft, closed or archived) is `409 {"error": "not_open"}`.
The gateway must route it to cards: `setup/Caddyfile` does; a load balancer built from
`docs/hosting.md` needs `/v1/cards/*/keep` in its card-service rule.

## A card's home meeting

A meeting's list (`GET /v1/occurrences/{id}/cards`), its count (`GET /v1/cards/counts`), the
agenda carried over to its next occurrence and its open questions hold the cards at home in it:
its own, and the older cards carried to it (QOR-5000). The writer carries an open card no person
has acted on to a later occurrence of its series (same meeting number) whose words revise it or
give it its owner; its old meeting then shows nothing of it. Another series' words only add to
it, as before, so it still carries over to its own series' next agenda. Its own meeting, quotes and events never change: each card names its own
meeting (`meeting_id`, `meeting_started_at`), where it is listed (`home_meeting_id`) and what
carried it there (`carried_by`: `writer`, `merge` or null), and each quote the meeting it was said
in. The carry is the writer's (`card.carry`), so it does not restart the expiry clock.
`POST /v1/cards/{id}/move-back {"revision"}` is Move back: the card goes back to the meeting it
was said in, for good (a card a person has acted on is never carried again), recorded as the person's `card.move_back`, so its clock starts
again. A stale revision is `409 stale_revision`; a card the writer has not carried, or one a
merge carried on top, is `409 not_carried`. A person's merge from a later occurrence carries the card kept to where the merged card is at home
too (`carried_by: merge`), and its Unmerge, not Move back, takes it home; the clean-up's merges carry
nothing. Deleting the later meeting takes the card home too. The gateway must route it
to cards: `setup/Caddyfile` does; a load balancer built from `docs/hosting.md` needs
`/v1/cards/*/move-back` in its card-service rule.

## Open to-dos: every meeting's open cards

`GET /v1/cards?status=open` lists the open cards of every meeting the person may read, by
the rule a meeting's cards follow (`GET /v1/occurrences/{id}/cards`: any member reads any
meeting, D148), with no time window. Open is on the board (a draft or a live card, not
archived), not merged into another card, not answered or replaced by a later card, and not
a question answered on the card (a person's clarify answer, or bwat's when it closed a draft
the room answered: the `<p data-clarify="…">` paragraph the card service writes; a note naming
`data-clarify=` is not one). `owner=me` keeps only the cards whose owner member is the
person (never a name the room said). Newest first, ties by id; `limit` 1-200 (default
100) and `cursor`, the `next` of the page before (at most 256 characters). The answer is `{"cards", "next",
"total"}`: each card is the object a meeting's list holds plus `"meeting": {"id", "title",
"starts_at"}`, `next` is null on the last page, and `total`, on the first page only (no `cursor`), counts
every match, up to 1000; a later page has no `total` (keep the first page's), so paging never
recounts. A plugin's product may read only `cards` and `next`.
Any other parameter or value is `400 {"error": "bad_request"}`.

`GET /v1/cards/counts` counts each meeting's cards for the board's week picker, so a board
reads the cards of only the weeks it shows: `{"meetings": [{"meeting_id", "cards",
"cards_version"}]}`, where `cards` is the meeting's list (`GET /v1/occurrences/{id}/cards`)
less its archived cards, `cards_version` an opaque digest of which cards it holds at which
version, archived ones too (every committed change to one of them, or a card carried in or out,
moves it, whatever order transactions commit in: what a board reads a week's cards again on), and a meeting with none is not listed. What never changes
a card row (Jev's hints, "expires in" days, owner names, a meeting's title in a card's sources)
does not move it: a board reads each shown week again every three minutes for those. Counted
once every ten seconds for every board. Any member reads it, as any member reads any meeting (D148).

`GET /v1/cards/{id}` reads one card with its meeting, a closed or archived one too (with its
flags); one the person may not read, or none, is `404 {"error": "not_found"}`, never 403.

`POST /v1/cards/facts` `{"card_ids"?, "meeting_numbers"?}` is the backend's alone (its token
and `X-Bwat-Member-Id`): the cards named, and every card said in the named meeting series, open
or not, as `{"cards": [{"id", "meeting_id", "meeting_number", "kind", "open", "created_at",
"closed_at", "merged_from"}]}`. No title, note or quote: what a backend plugin works out from cards (which
card a merged one's record now belongs to). `open` is the open list's rule; `closed_at` is a closed card's
newest `card.archive` or `card.expire`, else null; `merged_from` the cards merged into it,
oldest first (a plugin's record of one of them is now this card's).

`GET /v1/cards/{id}/content` and `POST /v1/cards/{id}/note` are the backend's alone too, for a
plugin that files a card in its product (QOR-4985). `content` answers `{"title", "note",
"quotes": [{"speaker", "quote"}]}`, the note as plain text. `note` `{"lead", "text",
"by_member_id", "request_id"?}` (one line each, at most 60 and 300 characters; `by_member_id` the header's
member, else `400 invalid_body`) adds `<b>lead</b> text by <member> at <time>` to the card's
detail, records `card.note`, counts as that person's act on the card (a draft goes live; one
merged since its content was read is restored first, as for a hand-off) and answers
`{"revision"}`. With a `request_id` (the plugin's own, at most 100 of `A-Za-z0-9._:-`), a
retry after a lost answer adds no second line and answers the card's revision.

The gateway must route these to cards, for `GET` only and only the card itself (a uuid) or `counts`:
`GET /v1/cards/{id}/brief` and `/content` are the backend's alone (D169), and
`GET /v1/cards/settings` is the backend's. `setup/Caddyfile` does (`@cardRead`). A load
balancer without regular expressions (`docs/hosting.md`) sends `GET` of `/v1/cards/settings` and
`/v1/cards/*/*` to the backend first, then `GET` of `/v1/cards` and `/v1/cards/*` to cards, both
before the `/v1/*` backend rule; that covers `/v1/cards/counts` too. Without those rules these
reads reach the backend and answer 404.

## When the writer reads a window

The writer's settings come from the backend's `GET /v1/cards/settings`, polled every 30 s
with its ETag; a failed read keeps the last good settings. Every chat call to OpenRouter
asks for zero-data-retention endpoints only (`provider.zdr`).

The rules (the rule files, the card size and the output format) are the same text for every
window, until an admin changes the card size or the rule files change. On OpenRouter the
writer's call to an `anthropic/` or `openai/` model sends them as one block marked
`cache_control: {"type": "ephemeral"}`. An Anthropic model then writes them to its cache on the
first window, at 1.25x the input price, and each window within 5 minutes of the last use reads
them back at about 0.05x on Opus 5.5; after a longer gap they are written again at 1.25x. The
board and the transcript come after the mark, and an Anthropic model never caches them. An
OpenAI model caches the longest prefix it has seen on its own, at a discount that varies by
model, so an unchanged board can be cached between windows too; on GPT-5.6 and later the mark
also fixes where that prefix ends. Any other host, model or call (clean-up, agenda summary) is
sent as before. Each answered window logs `window usage meeting=... in=... out=...
cache_read=... cache_write=... cost=...`, numbers only, on every host; off OpenRouter the cache
and cost fields are usually None.

The admin's card size (`cards_granularity`) adds one paragraph to the writer's rules:
`fewer` folds related points into one card's detail, `more` splits them into a card each.
`balanced`, the default and what a backend that does not serve it yet means, adds nothing,
so the prompt is the one the writer always had. It does not move Jev's thresholds.

Without Jev, a live meeting is read when 30 lines wait or 60 s after its last read. With
Jev (Use Jev on, every endpoint of its model on OpenRouter's zero-data-retention list, and
a key), a meeting is read on its first window, at its end, when more than 200 lines wait,
when its oldest unread line has waited the deadline, or when Jev scores the new lines at
the threshold or above. Jev is asked at most every 5 s per meeting, only after new lines,
with the new lines, the 60 before them and the board (at most 96 KB). Any Jev failure puts
the meeting back on the 30-line / 60 s cadence for 30 s.

A card that changed between the board read and the write aborts the whole window: nothing
from it is written, the position stays, and the window is read again on the next run.
