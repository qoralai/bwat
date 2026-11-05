"""Jev's duplicate hints during the meeting (QOR-4770). Jev flags; people act.

A card's content events (written by the writer, by people and by the clean-up) queue a
check in cards.card_checks, one row per card for its newest content event: a newer event
replaces the row, so an older pending check is never answered and an older hint clears.
Each batch is one Jev Decisions call for up to BATCH cards of one meeting. Per card, two
choice questions name the card of the SAME meeting it may duplicate (same kind) and the one
it may relate to (another kind), from that meeting's open cards (reconcile.candidates with
meeting_only); cards across meetings are left to the clean-up after the meeting. A claimed
check carries a 10-minute lease, so a crash resumes it after a restart, as the clean-up's
jobs do; a failure backs off as they do, and the ATTEMPTS-th fails it.

A person acts on a hint, naming the card the board showed it naming; a hint that has
changed since is refused. dismiss() records that pair for good (a not_duplicate or
not_related link to the named card, which the clean-up then respects), and act() merges or
links that pair under the clean-up's own lock (Merge now, Link now), never held across a
model call.
"""

import json
import logging

import psycopg

from writer.jev import STATE_CAP, title_line
from writer.lifecycle import ON_BOARD, acted, event
from writer.limits import BACKOFF, LEASE, RECENT_HOURS, RECONCILE_LOCK, TRY_LOCK, UNLOCK
from writer.model import ModelError
from writer.reconcile import (
    StalePair,
    age,
    apply_merge,
    apply_related,
    bounded,
    candidates,
    links_between,
    merge_summary,
    survivor,
)
from writer.window import plain

log = logging.getLogger("cards.writer")

CONTENT_EVENTS = ["card.create", "card.revise", "card.edit", "card.clarify", "card.merge"]
BATCH = 10  # cards a call
CONTENT_MAX = 2000
ATTEMPTS = 5
TIMEOUT_S = 30  # one batch's whole answer; the writer's 3 s is for its inline check
DUPLICATE = ("Which card of the SAME kind as card {id} is about the same obligation, question, decision or "
             "risk? none if no card is.")
RELATED = ("Which card of a DIFFERENT kind from card {id} clearly belongs with it (a question and its decision, "
           "a risk and its to-do)? none if no card does.")
NONE = {"dup": "No card is about the same thing", "rel": "No card belongs with it"}
# A hint's kind: its questions' and columns' prefix, and the links that hide a pair from it
# (Jev is not offered it, the board does not show it), a person's dismissal first.
KINDS = {"duplicate": ("dup", ("not_duplicate",)), "related": ("rel", ("not_related", "related"))}
# Which of a pair is older, as apply_merge and apply_related each order it.
OLDER_FIRST = {"duplicate": age,
               "related": lambda c: (c["created_at"], c["id"])}


class Busy(Exception):
    """The clean-up holds the meeting's lock."""


class Declined(Exception):
    """The named pair may not merge or link (different owners, merged before, dismissed)."""


class HintChanged(Exception):
    """The card's hint no longer names the card the board showed."""


def still_named(conn, card_id, kind, target):
    """Raises HintChanged unless the card's check for its latest content still names
    `target` at its threshold, as the board showed it (QOR-4770)."""
    key, _ = KINDS[kind]
    named = conn.execute(
        f"""SELECT 1 FROM cards.card_checks k
             WHERE k.card_id = %s AND k.state = 'done' AND k.{key}_card_id = %s
               AND k.{key}_confidence >= k.threshold_pct / 100.0
               AND k.event_id = (SELECT e.id FROM cards.card_events e WHERE e.card_id = k.card_id AND e.action = ANY(%s)
                                  ORDER BY e.at DESC, e.id DESC LIMIT 1)""", [card_id, target, CONTENT_EVENTS]).fetchone()
    if not named:
        raise HintChanged(card_id)


def enqueue(conn):
    """A pending check for each open card of a meeting started within RECENT_HOURS whose
    newest content event has none yet. The meetings come by their start (meetings_history)
    and their cards by cards_meeting, so a tick grows with recent meetings, not with every
    open card ever written; each card's newest event is one lookup on card_events
    (card_id, at), so it never reads the window's events either (QOR-4770)."""
    conn.execute(
        """INSERT INTO cards.card_checks (card_id, meeting_id, event_id, event_at)
           SELECT c.id, c.meeting_id, e.id, e.at
             FROM bwat.v_cards_occurrences o JOIN cards.cards c ON c.meeting_id = o.meeting_id
             CROSS JOIN LATERAL (
                    SELECT e.id, e.at FROM cards.card_events e
                     WHERE e.card_id = c.id AND e.action = ANY(%s) AND e.at >= now() - %s * interval '1 hour'
                     ORDER BY e.at DESC, e.id DESC LIMIT 1) e
            WHERE o.started_at >= now() - %s * interval '1 hour' AND c.status = ANY(%s) AND NOT c.archived
              AND NOT EXISTS (SELECT 1 FROM cards.card_checks k WHERE k.card_id = c.id AND k.event_id = e.id)
           ON CONFLICT (card_id) DO UPDATE SET event_id = EXCLUDED.event_id, event_at = EXCLUDED.event_at,
             state = 'pending', dup_card_id = NULL, dup_confidence = NULL, rel_card_id = NULL, rel_confidence = NULL,
             threshold_pct = NULL, attempts = 0, retry_at = now()
           WHERE cards.card_checks.event_id <> EXCLUDED.event_id AND cards.card_checks.event_at <= EXCLUDED.event_at""",
        [CONTENT_EVENTS, RECENT_HOURS, RECENT_HOURS, list(ON_BOARD)])


def claim(conn):
    """Up to BATCH due checks of one meeting, each with an attempt spent and a lease."""
    return conn.execute(
        f"""WITH due AS (
             SELECT card_id FROM cards.card_checks
              WHERE state = 'pending' AND retry_at <= now() AND meeting_id = (
                SELECT meeting_id FROM cards.card_checks WHERE state = 'pending' AND retry_at <= now()
                 ORDER BY retry_at LIMIT 1)
              ORDER BY retry_at, card_id LIMIT %s FOR UPDATE SKIP LOCKED)
           UPDATE cards.card_checks k SET attempts = k.attempts + 1, retry_at = now() + {LEASE}
             FROM due WHERE k.card_id = due.card_id
           RETURNING k.card_id::text, k.meeting_id::text, k.event_id""", [BATCH]).fetchall()


def content(card):
    return plain(card["detail_html"])[:CONTENT_MAX]


def state(pending, pool):
    """The meeting's open cards by display id, the batch's first."""
    batch = {c["id"] for c in pending}
    cards = [{"id": c["display_id"], "kind": c["kind"], "title": c["title"], "content": content(c)}
             for c in pending + [c for c in pool.values() if c["id"] not in batch]]
    # bounded() counts each card's own JSON; the ", " between two cards is counted here.
    return {"cards": bounded(cards, max(0, STATE_CAP - len(json.dumps({"cards": []})) - 2 * len(cards)), title_line)}


def questions(pending, pool, hidden):
    """Each batch card's two choice questions, numbered by its place in the batch; each
    offers only the cards it may name, and none: never a card a link of that question's
    KINDS already joins to it. A question with no card to offer is not asked."""
    asked = {}
    for n, card in enumerate(pending):
        for (key, hiding), statement, same in ((KINDS["duplicate"], DUPLICATE, True),
                                               (KINDS["related"], RELATED, False)):
            options = {c["display_id"]: c["title"] for c in pool.values()
                       if c["id"] != card["id"] and (c["kind"] == card["kind"]) == same
                       and not any((k, frozenset((card["id"], c["id"]))) in hidden for k in hiding)}
            if options:
                asked[f"{key}_{n}"] = {"instructions": statement.format(id=card["display_id"]),
                                       "criteria": options | {"none": NONE[key]}}
    return asked


def check(dsn, jev, threshold_pct):
    """One batch: the cards Jev named for each due check, with its confidence, written while
    the check is still the card's latest. Returns how many checks it finished."""
    with psycopg.connect(dsn) as conn:
        claimed = claim(conn)
    if not claimed:
        return 0
    meeting_id = claimed[0][1]
    with psycopg.connect(dsn) as conn:
        pool = candidates(conn, meeting_id, meeting_only=True)
        hidden = links_between(conn, list(pool), [k for _, kinds in KINDS.values() for k in kinds])
    pending = [pool[card_id] for card_id, _, _ in claimed if card_id in pool]
    asked = questions(pending, pool, hidden)
    answers = {}
    if asked:
        try:
            answers = jev.decide(state(pending, pool), asked, TIMEOUT_S)
        except ModelError as err:
            with psycopg.connect(dsn) as conn:
                for card_id, _, event_id in claimed:
                    conn.execute(
                        f"""UPDATE cards.card_checks SET
                             state = CASE WHEN attempts >= %s THEN 'failed' ELSE 'pending' END,
                             retry_at = now() + {BACKOFF}
                           WHERE card_id = %s AND event_id = %s AND state = 'pending'""",
                        [ATTEMPTS, card_id, event_id])
            log.warning("jev hints unavailable meeting=%s cards=%d: %s", meeting_id, len(claimed), err)
            return 0
    ids = {c["display_id"]: c["id"] for c in pool.values()}

    def named(key):
        answer = answers.get(key)
        if not answer or answer["choice"] == "none":
            return [None, None]
        return [ids[answer["choice"]], answer["confidence"]]

    picks = {c["id"]: named(f"dup_{n}") + named(f"rel_{n}") for n, c in enumerate(pending)}
    with psycopg.connect(dsn) as conn:
        for card_id, _, event_id in claimed:
            conn.execute(
                """UPDATE cards.card_checks SET state = 'done', dup_card_id = %s, dup_confidence = %s,
                     rel_card_id = %s, rel_confidence = %s, threshold_pct = %s
                   WHERE card_id = %s AND event_id = %s AND state = 'pending'""",
                [*picks.get(card_id, [None] * 4), threshold_pct, card_id, event_id])
    return len(claimed)


def dismiss(conn, card_id, meeting_id, kind, target, member_id):
    """A person's permanent "Not a duplicate" or "Dismiss" ('duplicate' or 'related') of
    `target`, the card the board showed Jev naming: that pair alone. Raises HintChanged."""
    _, (dismissal, *_) = KINDS[kind]
    still_named(conn, card_id, kind, target)
    link = conn.execute(
        """INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES (%s, %s, %s, %s)
           ON CONFLICT DO NOTHING RETURNING id""", [meeting_id, card_id, target, dismissal]).fetchone()
    if link:
        event(conn, card_id, meeting_id, "card.dismiss", "member", member_id, after={"kind": kind, "card_id": target})


def act(connect, card_id, meeting_id, kind, target, model, member_id):
    """Merge now / Link now on `target`, the card the board showed Jev naming; tried once
    more if a card changed meanwhile. A merge keeps the live card, or the older of two
    drafts or two live cards (reconcile.survivor), with the other one's summary from
    `model` (the writer's), as the clean-up does. The summary is asked for with no
    connection held (`connect()` lends one, QOR-4986), so neither a connection nor the
    clean-up's lock is held across a model call; the cards' versions, checked under the lock,
    reject a change made meanwhile. A link calls no model. 'merged' or 'linked'; 'gone',
    clearing that side of the hint, when `target` is no longer an open card of the meeting.
    Recorded as `member_id`'s, the person who clicked.
    Raises HintChanged, Busy, Declined, or StalePair the second time."""
    key, _ = KINDS[kind]
    lock = RECONCILE_LOCK + str(meeting_id)
    for attempt in range(2):
        with connect() as conn:
            still_named(conn, card_id, kind, target)
            pool = candidates(conn, meeting_id, meeting_only=True)
            if card_id not in pool or target not in pool:
                conn.execute(f"UPDATE cards.card_checks SET {key}_card_id = NULL, {key}_confidence = NULL "
                             "WHERE card_id = %s", [card_id])
                return "gone"
        older, newer = sorted((pool[card_id], pool[target]), key=OLDER_FIRST[kind])
        if kind == "duplicate":
            # Keep the live card, as the clean-up does: the draft goes into it.
            older, newer = survivor(older, newer)
        pair = {"older": older["id"], "newer": newer["id"]}
        if kind == "duplicate":
            pair["context"] = merge_summary(model, newer)
        with connect() as conn:
            if not conn.execute(TRY_LOCK, [lock]).fetchone()[0]:
                raise Busy(lock)
            try:
                with conn.transaction():
                    if kind == "duplicate":
                        apply_merge(conn, pair, pool, member_id)
                    else:
                        apply_related(conn, pair, pool, member_id)
                    # A person's action on both cards of the pair.
                    acted(conn, [older["id"], newer["id"]], member_id)
                    return "merged" if kind == "duplicate" else "linked"
            except StalePair:
                if attempt:
                    raise
            except ValueError as err:
                raise Declined(str(err)) from err
            finally:
                # The merge is committed before the lock is let go, as the clean-up's are. The
                # lock is the session's and the pool keeps the connection, so it is let go even
                # when the commit fails; on a connection the database closed, both fail with its
                # OperationalError (503) and the database lets the lock go.
                try:
                    conn.commit()
                finally:
                    conn.execute(UNLOCK, [lock])
