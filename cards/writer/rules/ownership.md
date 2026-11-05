# ownership — who owns it, and by when

This file exists because of one defect that fired in **both** directions.

A card was assigned to the person who raised the topic. They had never taken the
work — they had only pointed at it. So: the proposer was chased for weeks about
something they never agreed to do, and the person who actually said "I'll take
it" was never told the board had a card for them. One inference, two failures.

## The rule

**NEVER infer an owner from who raised a topic.**

An owner is set only when the transcript contains an explicit acceptance, or a
group ask (below). The words are in the record or there is no owner.

Set `owner` when someone says, in substance:
- "I'll take it" / "I'll do it" / "leave it with me" / "mine"
- "I'll have it by Thursday"
- a named person accepts a direct assignment: `"Jonah, can you own this?"` ->
  `"yeah, I've got it"` — **both halves required**

For a first-person commitment, **the speaker is the owner**. Copy their full
transcript speaker label into `owner`; the speaker does not need to say their
own name. Marco Reyes saying "I'll send the notes to Priya by Friday" means
`owner: Marco Reyes`, not Priya and not an empty owner. Priya is the recipient.
Include the first-person acceptance in the evidence, not just "by Friday".

This does not make every first-person sentence an acceptance: "I think Priya
should send the notes", "if I had time I'd send them", and "I won't send them"
do not assign the work to the speaker. A reported quote ("Marco said 'I'll send
it'") is not a commitment by the person reporting it.

A speaker who asks the whole room or a group ("you guys", "everyone", "all of
you", "the team") to each do something themselves (try the build, fill in the
survey), the speaker not among them, owns it: the card is their follow-up, not
the room's work, so this is not raising a topic. Title it as theirs ("Ask the
team to try the new build daily") and name the group in detail as it was said,
never a guessed list of names. Acceptance wins over the ask: if someone takes it
("I'll do it"), they own it; if the room refuses, there is no card. It does not
apply to one task for one person to pick up ("can you guys fix the login?",
"someone should...", "one of you...", "we should all...": unowned until someone
accepts), to one named person asked (`"Jonah, can you..."` needs Jonah's yes),
or to "I'll..." (the speaker's own commitment, above).

Do NOT set `owner` from:
- who raised, proposed, or complained about the topic
- who talked most about it
- who is the obvious expert, owns that repo, or "always does this"
- an assignment nobody answered: `"Jonah should probably own that"` with
  silence after it — that is unowned
- a third party volunteering an absent person: `"Theo can do it"` when Theo is not
  in the room and has not accepted
- the meeting organiser, by default
- yourself, or the board's configured `me`

When the room assigns to someone absent and nobody objects, that is not
ownership — it is an `ask`: *who confirms Theo owns this?*
## "No owner named" is a state, and it is visible

`owner` is nullable and rendering it empty is correct behaviour, not a gap to be
filled. Do not backfill it later from context, from a previous card, or from the
same person's name appearing elsewhere in the transcript.

An unowned `do` card is the board's most useful output: it is the only way the
room finds out that work everyone assumed was covered is not. Hiding that behind
a guess destroys the signal.

If several people accepted parts of one thing, split it into one card per owner.
Never write `owner: Jonah/Theo` — a shared owner is no owner. Use the canonical spelling of the name
(`transcript-traps.md`): `Pria` in the transcript is `Priya` on the card.

## Commitment horizon

`horizon` records **when the room said it lands**, drawn from the room's words,
never from your sense of priority.

| value | means | evidence in the transcript |
|---|---|---|
| `now` | in flight or immediately next | "I'm on it", "doing it after this call", "today" |
| `this-week` | before the next cycle | "by Thursday", "end of week", "before the release" |
| `later` | acknowledged, no date | "at some point", "after the launch", "next quarter" |
| `parked` | **the room explicitly deferred it** | "let's not do this now", "punt to next month", "shelve it" |

`horizon` may be left unset. An unset horizon means the room did not say. That
is different from `later`, which means the room said "not now" without a date.

### `parked` is a decision, not a shrug

Reserve `parked` for an explicit, in-the-room deferral: someone proposed
stopping and the room did not object. It records that the topic was considered
and set down deliberately, so nobody re-litigates it next week.

A soft "later" is `later`. Your own judgement that something is low priority is
never `parked`. If a `parked` card has no line you can quote where the room set
it down, it is not `parked`.

## Worked examples

### GOOD — explicit acceptance

Transcript (8/18c, seq 220-244):
> Priya: "somebody needs to fix the drop handling in capture, it's eating frames"
> Jonah: "yeah I'll take that, should be done Thursday"

    bucket:  do
    id:      A121
    title:   Fix capture drop handling so frames are not silently eaten
    owner:   Jonah
    horizon: this-week
    src:     8/18c seq 220-244
    quote:   "yeah I'll take that, should be done Thursday" — Jonah
    reason:  Jonah accepted the fix outright and gave a day.

Priya raised it; Jonah owns it. The quote is the acceptance, not the ask.

### BAD — the original defect

    bucket:  do
    id:      A121
    title:   Fix capture drop handling so frames are not silently eaten
    owner:   Priya
    horizon: now
    src:     8/18c seq 220

Priya is on the card because she spoke first. She gets chased for work she never
took, Jonah never learns a card exists, and the frames stay eaten. `horizon:
now` is invented too — the room said Thursday.

### GOOD — nobody accepted

Transcript (8/18c, seq 511-528):
> Theo: "the runbook is out of date, half those steps are dead"
> Priya: "someone should rewrite it"
> (topic changes)

    bucket:  do
    id:      A122
    title:   Rewrite the deploy runbook; several steps no longer exist
    owner:   (none named)
    horizon: (unset)
    src:     8/18c seq 511-528
    quote:   "the runbook is out of date, half those steps are dead" — Theo
    reason:  The room agreed the runbook is broken and nobody picked it up.

The empty owner IS the finding. Assigning Theo because he noticed, or Priya
because she said "someone should", would erase the only useful thing here.

### GOOD — parked

Transcript (8/18c, seq 780-796):
> Marco: "I don't want to open the Postgres migration this month, we've got the
> launch. Park it."
> Priya: "fine by me."

    bucket:  decided
    id:      D94
    title:   Postgres migration deferred until after launch
    owner:   (none named)
    horizon: parked
    src:     8/18c seq 780-796
    quote:   "I don't want to open the Postgres migration this month, we've got
              the launch. Park it." — Marco
    reason:  Marco deferred it explicitly against the launch and nobody objected.

### BAD — `parked` used as a shrug

    horizon: parked
    reason:  This did not seem urgent compared to the launch work.

Nobody in the room parked anything; the agent decided it was unimportant.
Without a quotable deferral, the correct value is `later` or unset.
