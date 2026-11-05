# wording — how a card reads

A card is read in a list of forty other cards, by someone who was not in the
meeting, three days later. Every rule here follows from that.

## Lead with the object, never the meeting

The first word of a title is about the thing that changed. It is never about the
conversation, the room, or the process of talking.

Banned openers: `Discussion of`, `Discussed`, `Team agreed to`, `Follow up on`,
`Alignment on`, `Sync about`, `Update on`, `Talked about`, `Revisit`.
Only a group ask (`ownership.md`) may have a title about the room: the asker's
follow-up, `Ask the team to ...`.

    BAD   Discussion of the capture retention window
    GOOD  Capture logs expire at 90 days; cards are kept forever

The meeting is already recorded in `from`/`src`. Spending title characters on it
is spending the only characters you have.

## Length budgets

| field | budget | rules |
|---|---|---|
| title | <= 60 chars | about 8-10 words; no trailing period; no id prefix; sentence case |
| reason | <= 200 chars | exactly ONE sentence; why this is on the board |
| quote | <= 300 chars | verbatim; may join 2-3 contiguous lines |

Over budget is a defect, not a style preference — the board truncates and the
reader loses the end of your sentence. If the title will not fit, keep the
headline and put the rest in detail.

    BAD   Should we keep supporting the legacy CSV export for the two pilot schools that still rely on it for their weekly attendance reports?
    GOOD  Keep the legacy CSV export for pilot schools?

Titles carry no trailing period because they are labels, not sentences. Reason
and quote are sentences and keep their punctuation.

## Quote verbatim, and quote generously

The quote is the receipt. It is the single feature that makes the board
trustworthy, and it is cheap. Prefer quoting three lines of real dialogue to
writing one line of your own summary.

- Copy the words exactly, including hesitation and bad grammar. Do not clean up
  "we're just gonna eat the cost on that one" into "the team will absorb the
  cost".
- Attribute with `— Name` using the canonical spelling (`transcript-traps.md`).
- Elide only in the middle, with `...`, and only to cut an interruption. Never
  elide to make a quote say something it did not.
- If the decisive line came from chat, quote it and mark it: `— Jonah (chat)`.
- If the ASR clearly mangled a word, quote it as captured and put the correction
  in brackets: `"put it behind the cash [cache] first"`.
- Never fabricate a quote. If no single line carries the point, quote the
  closest real line and let the reason sentence do the work.

## No hedging in the claim

The title and reason state what is true. They do not state how confident you
are. Hedges to strike: `possibly`, `might`, `seems to`, `appears`, `it sounds
like`, `I think`, `probably`, `likely`, `roughly`, `TBD-ish`.

Uncertainty has structured homes, and only these:
- the room was genuinely unresolved -> `conflict: true` (`linking.md`)
- nobody was named -> `owner: (none named)` (`ownership.md`)
- the question is open -> bucket `ask`
- you are unsure it earns a card at all -> write no card (`extraction.md`)

A hedged claim smuggles your uncertainty into the record as if it were the
room's. Either the room said it or it did not.

Conditionals inside a `risk` are not hedges: "If the vendor slips past the 3rd,
the launch moves" is a structured trigger -> consequence, and is correct.

## Numbers, ids, and names

Carry exact figures from the transcript: dates, counts, versions, ticket ids.
`by the 3rd` beats `soon`; `90 days` beats `a few months`. If the room said a
number, the card says that number. If the room did not, do not invent one.

## Worked examples

### GOOD

    bucket:  do
    id:      A118
    title:   Move the capture retention default from 30 to 90 days
    owner:   Jonah
    horizon: this-week
    src:     8/18c seq 402-419
    quote:   "thirty days is too short, we lost the July board history that way
              — make it ninety and let the janitor handle it" — Jonah
    reason:  Jonah took the change after the July history loss came up again.

Title leads with the object (`capture retention`), states the change with both
numbers, 62 chars, no trailing period. Quote is verbatim including the dash and
the informal tone. One reason sentence, no hedge.

### BAD — the same span

    bucket:  do
    id:      A118
    title:   Discussion around possibly extending the retention window for
             captures, which the team seems to feel is currently too short.
    owner:   Jonah
    src:     8/18c
    quote:   Jonah suggested that retention should be longer.
    reason:  There was some concern about data loss, and it might be worth
             looking at whether 30 days is the right number, though this may
             need more discussion before anything is decided.

Every rule broken: opens with `Discussion around`; 128 chars with a trailing
period; hedges (`possibly`, `seems to`, `might`, `may`); the quote is a
paraphrase, not a quote, so there is no receipt; the reason is three sentences
and ends by undermining the card's own existence. The exact numbers (30, 90) are
gone, so a reader cannot act without replaying the transcript.

### GOOD — a `risk` with a real consequence

    bucket:  risk
    id:      R58
    title:   Vendor cert renews after the 3rd; launch slips if it misses
    owner:   (none named)
    horizon: now
    src:     8/18c seq 903-914
    quote:   "their renewal window is the 5th at the earliest ... if that's real
              then we can't launch on the 3rd, it's that simple" — Theo
    reason:  Theo named a dated dependency the launch plan currently assumes away.

Trigger and consequence are both in the title, with the date. No owner is
named and that is shown rather than guessed.

### BAD — the same risk, hedged into uselessness

    bucket:  risk
    title:   Potential timing concerns around vendor dependencies
    reason:  It seems there may be some risk to the timeline.

No object, no date, no consequence, no receipt. A reader cannot tell which
vendor, which date, or what happens. This is a mood with an id.
