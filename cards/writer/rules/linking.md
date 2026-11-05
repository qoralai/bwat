# linking — cards that reference cards

The board is a record over time, not a snapshot. A meeting rarely starts a topic
from nothing; it lands on top of something already there. Linking keeps that
history legible without rewriting it.

## Reference by bare id, in bold

Inside `detail`, name another card as its bare id in bold and nothing else:
`**D85**`, `**A114**`, `**R53**`, `**Q37**`. No prefix word, no link markup, no
restating the other card's title — titles drift and a stale copy is worse than a
bare id. The board resolves ids to live cards on render.

    GOOD  Supersedes **D85**; the 30-day window it set was reversed here.
    BAD   Supersedes card D85 ("Capture logs expire at 30 days"), see the
          decided column.

Record the relationship in `card_links` with the right `kind`: `ref`,
`supersedes`, `superseded-by`, `answers`, `answered-by`, `conflicts`. Write both
directions — a supersession only the new card knows about is invisible from the
card people are actually reading. Never delete a link because its target was
archived. Archiving is a state on the card, not a deletion, so both ends of the
link still exist and both are foreign keys to `cards` -- a link naming a card
that was never on the board is refused rather than written.

## from2 — corroboration from a second meeting

`from_key` is the meeting that produced the card. `from2_key` is set when a
**different** meeting independently confirms the same thing.

Set `from2` when a later meeting restates, ratifies, or re-commits to the card's
claim. Then append the second receipt to `src` (`8/18c seq 671-711; 8/20a seq
88-96`); do NOT change the title or reason (the claim did not change, its
support did); and do NOT open a second card for the restatement — that is
exactly the duplicate the board exists to avoid.

Do not set `from2` for a passing mention, for the same meeting re-captured from
the store, or for a follow-up that *changes* the claim — that is a verdict
block or a supersession, below.

## Append a verdict, never rewrite history

When the world moves on a card — the question got answered, the risk fired, the
decision was carried out — **append a verdict block to `detail`**. Do not edit
the original claim, quote, or src. The original text is the receipt for what the
room said at the time, and it stays true even when the outcome changes.

    <p class="verdict">8/20a — answered: staying on SQLite through launch.
    "we're not touching the database before the 3rd" — Marco. See **D96**.</p>

Every verdict block carries the source key, what happened, and a receipt, plus a
`card_events` row with `action='append'` and the citation in `receipt`. Editing
the original claim in place destroys the only thing the board sells: that its
cards are quotable back to a transcript.

## conflict:true — genuinely unresolved

Set `conflict` when **two positions on the same point were both left standing**
at the end of the meeting. It is a fact about the room, not about your
confidence and not about how heated the exchange was.

Set it when two people stated incompatible positions and the topic changed with
neither withdrawn, or when a new meeting contradicts a live card and neither has
clearly won — flag both, with `kind='conflicts'` links in both directions.

Do not set it when one side conceded, the disagreement was about wording, or a
speaker simply had not heard the decision; those resolve to a single card.

State both positions in `detail`, quoting each side. A conflict card that quotes
only one side is an argument, not a record.

## Supersession is visible

A superseded card is never deleted, blanked, or silently retitled.

1. The new card states what it replaces: `Supersedes **D85**.`
2. The old card gets an appended block: `Superseded by **D97** on 8/20.`
3. Both `card_links` rows are written (`supersedes` / `superseded-by`).
4. A `card_events` row records it with `action='supersede'` and a receipt.
5. The old card leaves the live board through `archived`, per `lifecycle.md` —
   not through deletion.

The same applies when the agent overwrites a human's edit: history must show what
was replaced and why.

## Worked examples

### GOOD — a reversal, both ends visible

New card:

    bucket:  decided
    id:      D97
    title:   Capture logs expire at 90 days, up from 30
    src:     8/20a seq 402-419
    detail:  Supersedes **D85**. The 30-day window cost us the July board
             history. "make it ninety and let the janitor handle it" — Jonah
    links:   D97 --supersedes--> D85

Old card **D85**, unchanged above the fold, with one appended block:

    <p class="verdict">8/20a — superseded by **D97**: window raised to 90 days
    after the July history loss.</p>
    links:   D85 --superseded-by--> D97

A reader landing on either card gets the whole story and can quote both meetings.

### BAD — the same reversal, done by editing

    id:      D85
    title:   Capture logs expire at 90 days, up from 30
    src:     8/20a seq 402-419

**D85** now claims the 8/18 meeting decided something it did not, the 30-day
decision has vanished, and anyone who acted on the old card cannot find out it
changed. Silent rewriting is the failure mode this file exists to prevent.

### GOOD — corroboration, not a new card

**A118** already exists from 8/18c. On 8/20a, Jonah says "yep, ninety days is
in, that's done".

    id:      A118          (unchanged title, unchanged quote)
    from:    m0818c
    from2:   m0820a
    src:     8/18c seq 402-419; 8/20a seq 251-253
    detail:  ... <p class="verdict">8/20a — done. "yep, ninety days is in,
             that's done" — Jonah</p>

### BAD — corroboration as a duplicate

    id:      A140
    title:   Ninety day retention is now live
    from:    m0820a

Now two cards describe one piece of work, they will be closed at different
times, and the board's count of open work is wrong. Restatement gets `from2`
and a verdict block, never a new id.

### BAD — conflict used as a hedge

    id:      D99
    conflict: true
    detail:  Marco wants Postgres; Priya mentioned SQLite is fine for now, but
             it was not totally clear.

"Not totally clear" is the agent's uncertainty, not the room's. If Marco closed
the topic, write one card. If both positions truly stood, quote **both**
speakers verbatim and link the two cards with `kind='conflicts'` in both
directions.
