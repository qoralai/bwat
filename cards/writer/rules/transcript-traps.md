# transcript-traps — how the capture lies to you

Read this before extracting anything. Every rule below cost somebody a wrong card
and none are visible from the text alone.

## 1. Sort by (epoch, seq) — NEVER by seq alone

The bot's `seq` counter is per bot **process**. A mid-meeting redeploy restarts the
numbering near zero, so a naive sort interleaves the second half of the meeting
into the first and produces a transcript in which people answer questions that
have not been asked yet.

    GOOD  frames.sort(key=lambda f: (f.get("epoch") or 0, f["seq"]))
    BAD   frames.sort(key=lambda f: f["seq"])

Consequence for extraction: if a card's reasoning depends on order ("X was
raised, then Y decided it"), confirm both frames share an `epoch` — across an
epoch boundary, seq says nothing about which came first. Cite ranges within one
epoch; `seq 671-711` is meaningless if the range spans a restart.

## 2. Chat and speech are split by timestamp magnitude

- **speech** frames carry epoch-milliseconds: `ts >= 1e12`
- **chat** frames carry a small counter: `ts < 1e12`

That is the only reliable discriminator — not the speaker name, not the text.

**Never discard chat.** Chat routinely holds the decisive line of a meeting:
the link, the ticket id, the number nobody read aloud, and the objection someone
was too polite to voice. A pipeline that filters on `ts > 1e12` — the same test
used to find real timestamps — silently drops every chat line.

Chat has no useful ordering against speech, since its ts is a different clock.
Cite chat as chat: `8/18c chat seq 44` and attribute quotes as `— Jonah (chat)`.

## 3. A gap in seq is not automatically lost data

Two gaps look identical in the numbers and mean opposite things.

**Wake-word gap — NOT lost data.** A gap immediately after a line addressing
the bot by name (`"hey bwat"`) is the bot's own reply being consumed out of the stream. Nothing
was lost; the missing seqs never carried meeting content. Do not flag it, do not
mention it on a card, do not lower confidence because of it.

**Real drop — IS lost data.** A gap adjacent to a `_meta: "drop"` row is genuine
loss: the capture reconnected and frames in between are gone. Never guess what
was said across it; if a card's claim straddles the drop, say so in `detail` and
cite the drop; if the support is on one side and the outcome on the other,
prefer an `ask` over a `decided`.

## 4. The ASR hallucinates foreign tokens into silence

Long silences produce short, confident, out-of-language tokens. Real examples
from this board's captures:

    Não        Děkuju        好        Merci.        Продолжение следует...

Treat a short non-English token with no surrounding context as **silence**, not
speech. Never quote one, never treat one as assent to a question ("Não" is not
somebody saying no), and never let one break up a speaker's contiguous quote —
elide it with `...` and quote across it.

The tell: a one- or two-word line, a language nobody in the room speaks, and no
semantic relation to the lines either side.

## 5. Speaker names are mangled — normalise before writing

The ASR mishears names consistently. Normalise every one before it reaches a
card, an `owner` field, or a quote attribution:

| captured | canonical |
|---|---|
| Pria, Prya, Preya | Priya |
| Jonna, Joner, Jonahs | Jonah |
| Theyo, Thio | Theo |

Inside a quote, keep what was captured and bracket the correction:
`"send it to Pria [Priya] first"`. Outside a quote — titles, reasons,
`owner` — use the canonical spelling only.

Two mangled spellings of one person are one person. Do not create two owners, or
a card whose owner is `Pria` while `Priya` owns three others.

## 6. Transcription runs on the FINAL MIX — crosstalk is lost

This is the trap that survives all the others. The ASR does not see per-speaker
audio tracks; it sees one mixed-down stream. When two people talk at once:

- one speaker is dropped entirely, with no marker that anything is missing
- or both are merged into a single frame under **one** speaker's name
- or the attribution flips mid-sentence

Interruptions, objections, and quick agreements are exactly the moments people
overlap, so crosstalk loss is biased toward the most decisive seconds of the
meeting. What to do:
- a one-word `"yeah"` or `"no"` attributed to the person who was mid-sentence is
  suspect; it is often the interrupter's, misattributed
- never build an `owner` acceptance on a short overlapping utterance alone; an
  ownership claim needs a clean, contiguous line (`ownership.md`)
- if a `decided` rests on assent captured during overlap, downgrade it to `ask`
  or mark `conflict:true` — an objection you cannot see is indistinguishable
  from agreement
- when the chat line and the speech line disagree, the chat line is not subject
  to mixing and generally wins

## Worked examples

### BAD — a card built on a hallucination and a wake-word gap

    bucket:  decided
    id:      D88
    title:   Team declined the Postgres migration
    src:     8/18c seq 640-644
    quote:   "should we move to Postgres now?" — Marco / "Não" — Priya
    reason:  Priya said no and the topic ended, with frames missing after.

Two failures. `"Não"` is ASR hallucination into silence, not a Portuguese no
from a speaker who does not speak Portuguese — nobody answered. The gap after
seq 644 follows `"hey bwat, note that"`, so it is the bot's own reply being
consumed, not evidence of a lost answer. The room decided nothing; the correct
output is either an `ask` or no card.

### GOOD — the same span, read correctly

    bucket:  ask
    id:      Q41
    title:   Do we move the board store to Postgres before launch?
    owner:   (none named)
    src:     8/18c seq 640-644
    quote:   "should we move to Postgres now?" — Marco
    reason:  Marco asked and the transcript shows no answer before the topic moved.

### BAD — crosstalk read as an acceptance

    bucket:  do
    id:      A130
    title:   Rewrite the deploy runbook
    owner:   Theo
    src:     8/18c seq 388
    quote:   "yeah I'll take it" — Theo

Frame 388 is a merged crosstalk frame: Priya was mid-sentence and the mix put
a fragment of someone else's reply under her name, then the attribution flipped.
Nothing establishes that **Theo** said it. Correct handling: `owner: (none
named)`, and if the ownership matters, an `ask` — *who owns the runbook rewrite?*
