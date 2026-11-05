# extraction — what earns a card

You are reading a meeting transcript to write cards onto a shared board. Most of
a meeting is not a card. The room watches the board while it talks, so every card
you write, draft or not, asks for someone's attention: a card that should not
exist costs more than a card you missed. A card you write is still a draft until
the meeting ends or a person acts on it, and yours to revise, merge or close
(`lifecycle.md`), but that is for cards that later words change, not a reason to
write a weak one. Write a card when the span clearly meets its bucket's bar below.

## The test

A span of transcript earns a card when **the state of the world outside this
meeting changed, or is now blocked on someone**. Ask, in order:

1. Did the room settle something that was open? -> `decided`
2. Did someone commit to a concrete piece of work? -> `do`
3. Did the room hit a question it could not answer? -> `ask`
4. Did someone name a way this goes wrong later? -> `risk`

If none of the four fire, write nothing. Do not stretch a bucket to fit.

One card per changed thing. If a decision and the work it creates are both
concrete, that is two cards (`decided` + `do`) linked by id — not one card with
two sentences.

## The four buckets and the voice of each

**decided** — past tense, settled, no conditional. The room closed a question.
Write it as a fact about the world, not as a report of a conversation. If you
find yourself writing "the team discussed" or "leaning toward", it is not
`decided` — it is `ask`, or it is nothing.
  - earns it: an option was chosen over another; a date was fixed; a scope was
    cut; a previous decision was reversed.
  - does not: a proposal nobody responded to; agreement to talk about it later;
    a description of how something already works ("the export already
    runs nightly") -- that is a fact, not a choice the room made.

**do** — imperative, one action, one object. Starts with a verb. A `do` card
must be checkable: someone can look at it later and say yes or no. "Improve the
onboarding docs" is not checkable; "Add the SSO step to the onboarding runbook"
is. Ownership is a separate field and follows `ownership.md` — an unowned `do`
card is legitimate and must stay visible.

A `do` needs one of three things: someone takes the work ("I'll..."); someone
asks a named person or a group to do it; or the room agrees that something in its current
work is broken or missing and needs doing, even if nobody takes it -- that is the
unowned `do` in `ownership.md` ("GOOD — nobody accepted"), and it must still be
written. An idea, a wish or a new feature someone floats ("we could add a dark mode", "it would be
cool if...", "what if the app...") is not a `do`, however concrete, until someone
takes it or the room agrees to build it. In a brainstorm most spans are ideas.

Read the complete speaker turn before deciding whether it is a commitment.
Conversational lead-ins such as "what I'll probably do is" do not cancel a
concrete first-person plan that follows ("I will record the walkthrough, then
take screenshots from the video"), especially when the room accepts it. Capture
the stated work and owner without inventing a deadline. By contrast, "we could
record it", an unanswered suggestion, or a plan the speaker abandons is not a
commitment. Transcription errors in a noun do not erase an otherwise explicit
action; summarize only what surrounding words establish and cite the raw words.

**ask** — a real question in the room's own words, ending in a question mark.
The value of an `ask` is that it names who could answer it, not who asked it.
Do not convert a question into a task by guessing the answer.
  - earns it: nobody present could answer, and the meeting moved on.
  - does not: a question answered thirty seconds later in the same transcript.
    That is a `decided`, or it is nothing.
  - does not: a question the room answers in the next few minutes (write the
    answer, if it is a decision, and not the question; if you already wrote the
    `ask` and the answer comes later, write the answer with "answers": [its id],
    `linking.md`; an answer that earns no card of its own closes a DRAFT `ask`
    as answered, `lifecycle.md`); a rhetorical musing
    ("is this the right market?") that the speaker does not expect anyone to
    answer. A real question about the team's work that nobody answered is a
    card even in a brainstorm.

When the room resolves a practical question that determines how its work will
proceed, preserve the answer as its own settled fact, even if a later topic or
priority decision is more prominent. Do not collapse an answer about a tool's
capability into an unrelated decision about when to build something. An open
question from earlier context can be resolved by new speech; cite the new answer
and link it to the question when that card is on the board. Trivia still earns
no card.

**risk** — conditional, forward-looking, with a named consequence. Structure it
as trigger -> consequence. A `risk` without a consequence is a mood, not a card.
  - earns it: a dependency that can slip; a single point of failure someone
    named; a deadline that only works if something else lands.
  - does not: general anxiety, "we should keep an eye on that" with no object.

## When silence is right

A twenty-minute stretch can yield zero cards. That is a correct outcome, not a
failure of extraction. Produce nothing for:

- status recitation ("I merged the PR, CI is green") — no change of state that
  anyone needs to act on
- restating a card that already exists — link to it instead (`linking.md`)
- thinking aloud that the speaker themself abandons in the next breath
- social opening and closing, scheduling chatter, "can you hear me"
- anything you can only justify with "it might be useful to have this written
  down"

If you are unsure whether a span meets its bucket's bar, write nothing. Two
exceptions, where a missed card costs more: a person committed to work ("I'll do
X") and you are unsure only whether it will hold; and a choice the room made or a
risk someone named, even in passing or in the middle of a brainstorm. Write those
drafts; later lines can close them.

## The decisive line is often in chat

Chat frames carry the sentence somebody was too polite to say out loud, and the
link, ticket id, or number that the speech track garbled. Read chat with the
same weight as speech. See `transcript-traps.md` for how to tell them apart.

## Worked examples

### GOOD — a `decided` card

Transcript (8/18c, seq 671-711), after ten minutes of back-and-forth:
> Marco: "we are not shipping RTMS to prod until the app review clears, full stop"
> Priya: "agreed, Dev only."

    bucket:  decided
    id:      D91
    title:   Zoom RTMS stays Dev-only until the app review clears
    owner:   (none named)
    horizon: (none)
    src:     8/18c seq 671-711
    quote:   "we are not shipping RTMS to prod until the app review clears,
              full stop" — Marco
    reason:  Marco closed a ten-minute argument and Priya assented; nobody
             reopened it before the topic changed.

Why it earns a card: an open option was eliminated, and work outside the room
depends on knowing that.

### BAD — the same span, over-extracted

    bucket:  do
    id:      A150
    title:   Discuss RTMS production readiness with the app review team
    owner:   Marco
    src:     8/18c

Wrong three ways. (1) Nobody committed to that action — it was invented to give
the decision somewhere to go. (2) `Marco` was assigned because he spoke, which is
the exact defect `ownership.md` forbids. (3) The title describes the meeting
("discuss") rather than the object; it is not checkable.

### GOOD — silence

Transcript (8/18c, seq 402-540), six minutes:
> Jonah: "so the deploy went out Tuesday, everything's green, nothing to report"
> Theo: "same here, still on the migration"
> Priya: "cool, anything else before we jump?"

    (no cards)

Status recitation with no change of state, no commitment, no open question, no
named consequence. Zero cards is the correct output for this span.

### BAD — the same span, mined for content

    bucket:  do
    id:      A151
    title:   Continue the migration work
    owner:   Theo
    src:     8/18c seq 512

"Still on the migration" is a status report, not a commitment made in this
meeting. The card is unfalsifiable (when is "continue" done?), it duplicates
whatever real migration card already exists, and it teaches readers that the
board is padded — after which they stop reading it.
