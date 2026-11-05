# lifecycle — done, archived, pruned

The board's value is that someone can read all of it. A board of 300 cards is
read by nobody and is therefore worth less than a board of 40. Keeping it small
is not tidying — it is the product.

Target: the live board holds roughly **two active weeks** of cards.

## Done detection — from the room's own words

`done` is set from evidence in a transcript, never from elapsed time, never from
your judgement that it has probably shipped by now.

**Closing a live card is not part of the card-writing pass, and you cannot do it
from here.** The reply format has no verb for it, on purpose: deciding that a
particular utterance closes a particular obligation is a different question from
"what did the room settle", it is wrong far more often, and a card wrongly
closed is dimmed and sunk where nobody rereads it. A separate close-out pass
asks that question against a whole week and puts its findings in front of a
person. What follows is the standard it works to, and it is here so that the
meaning of RETIRED on the board is written down once.

A card marked DRAFT is different: no person has acted on it, and it is still
yours. When later lines show it was not real -- the commitment was taken back,
the question dropped, the plan abandoned -- close it with `close`, citing the
words that show it. bwat closes it; no person's card is touched. A DRAFT
question the room ANSWERED is closed the same way with `"answered": true` and
the answer as its reason, so the board shows it answered, not dropped -- unless
the answer earns a card of its own (`extraction.md`), which then carries
`answers`.

A card is done when a later meeting contains a completion statement about that
card's object:
- "that's in", "shipped it", "merged this morning", "it's live"
- "we did that last week", "that's handled"

Only a `do`. A question ends by being ANSWERED, which the card-writing pass CAN
do -- put `answers` on the card that carries the answer, or close a DRAFT
question as answered, and the board retires the question itself. A `decided`
card likewise ends by being reversed, through `supersedes`. Completion applies
to neither, so that the page can always say which of the three happened.

A card is NOT done from:
- "almost done", "should be done today", "just needs review" — not yet
- silence. A card nobody has mentioned in three weeks is stale, not done.
- the owner's original promise ("I'll have it Thursday") plus the calendar
- your own inference that a related card was completed

Every `done` gets an appended verdict block with the receipt (`linking.md`),
never a rewrite of the claim, plus a `card_events` row with `action='done'`.

An unresolved `ask` or an unowned `do` that has gone quiet is **not** done. It
is exactly the card the board exists to surface. It stays live and visible.

## Archive eligibility

`state='archived'` removes a card from the live feed. It never removes it from
the database, from history, or from links pointing at it.

Archive a card when **all** of:
1. `done=1`, or it was superseded, or it was `parked` and its window has passed
2. its receipts are older than the two-week live window
3. no live card links to it as an open dependency
4. `conflict=0` — an unresolved conflict is never archived

Set `archived_at`, write `card_events` with `action='archive'`, and leave
`card_links` intact in both directions. A supersession chain must stay walkable
from the archived end.

Never archive:
- an unresolved `ask`, however old — age is the finding
- a `do` with no owner named, however old — same reason
- a `risk` whose trigger has not passed yet
- anything a human edited in the last week without a receipt saying why

## Prune order

When the live board exceeds its target, remove in this order and stop as soon as
you are under. Do not skip ahead to make room faster.

1. **Done + superseded** — completed cards whose supersessor is live. Zero
   information lost; the live card carries the story.
2. **Done, receipts older than two weeks** — oldest receipt first.
3. **Parked whose deferral window has passed** — "punt to next month" and the
   month is gone. Archive with a note; do not silently re-activate it.
4. **Decided older than two weeks with no open work hanging off them** — the
   decision holds, it just does not need daily eyes.
5. **Risks whose trigger date has passed without firing** — archive with a
   verdict block saying it did not fire. That block is the record.

Never pruned, at any board size: unresolved `ask`; `conflict=1`; unowned `do`;
any card whose `from` meeting is inside the live window. If the board is still
over target after step 5 and only these remain, the board is correctly sized and
the meetings are producing more open work than the room is closing. Report that;
do not prune to hit a number.

Archiving is bulk-safe but never silent: one `card_events` row per card.

## Worked examples

### GOOD — done from the room's words

**A118** ("Move the capture retention default from 30 to 90 days", owner Jonah,
from 8/18c). On 8/20a, seq 251-253:
> Jonah: "yep, ninety days is in, that's done"

    done:    1
    from2:   m0820a
    src:     8/18c seq 402-419; 8/20a seq 251-253
    detail:  ... <p class="verdict">8/20a — done. "yep, ninety days is in,
             that's done" — Jonah</p>

Two weeks later, with no live card depending on it, it archives under prune
step 2. The card and its history survive; only the live feed changes.

### BAD — done from the calendar

    id:      A118
    done:    1
    reason:  Jonah said he would have it by Thursday and that was two weeks ago.

Nobody said it shipped. The card is now closed on the board while the work may
be untouched — which is the failure the board is supposed to prevent. Absent
evidence, it stays open, and its age is the signal.

### GOOD — an old card that must not be pruned

    bucket:  do
    id:      A122
    title:   Rewrite the deploy runbook; several steps no longer exist
    owner:   (none named)
    from:    m0718b        (five weeks old)

It is old, quiet, and clutters the board. Keep it. An unowned `do` that has
survived five weeks is the single most valuable card on the board: it is proof
that work everybody assumed was covered has no owner. Pruning it makes the board
smaller and the room's picture of itself wrong.

### BAD — pruning to hit the target

    Archived A122 (unowned, 5w old), Q41 (open question, 4w old),
    D99 (conflict:true, 3w old) — live board now at 38 cards.

Three protected categories deleted from view to make a number. The board is now
the right size and useless: the only cards left are the ones everyone already
knows about. The correct action was to stop after step 5 and report that open
work is outrunning closed work.
