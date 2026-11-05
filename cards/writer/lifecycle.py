"""A card's life after the writer makes it (D187, D194).

The writer's cards start as drafts. A draft is on the board like any other card and takes
every action; it goes live (open) when a person first acts on it, or once its meeting has
ended and its clean-up has run, given up, or cannot run for want of the writer's key,
whichever comes first. The owner member acting on a card accepts it; so does a person
setting themself as its owner. Every person's action passes through person_change or
acted, and every owner change through owner_set.

A live card nobody acts on for EXPIRE_DAYS closes as no_response, never as done. Its clock
is the later of when it went live and its last event with a person as actor: the writer's
own changes never reset it. From WARN_DAYS the card says how many days are left. A card a
person has kept (card.keep) never expires: it stays until a person closes it.
"""

import math

from psycopg.types.json import Jsonb

from writer.limits import RECONCILE_LOCK, RECONCILIATION_ATTEMPTS

EXPIRE_DAYS = 10
WARN_DAYS = 5
# An ended meeting's drafts go live this long after it ended, or after its clean-up was
# queued, whatever became of the clean-up: its longest wait between failed attempts (an
# outage, a key out of credit) is an hour.
CLEAN_UP_HOURS = 1
# The statuses of a card on the board, not closed: SQL takes it as `status = ANY(%s)`.
ON_BOARD = ("open", "draft")

def not_merged(alias):
    """Not merged into another card: a merged card is shown only through the card it went into."""
    return f"""NOT EXISTS (SELECT 1 FROM cards.card_links l WHERE l.from_card_id = {alias}.id AND l.kind = 'merges'
                              AND l.revoked_at IS NULL)"""


def current(alias):
    """Still current work, the card `alias` names: not merged away, and not retired by a card
    that answers or replaces it. The board, its hints, the writer's digest and the clean-up
    all read it so; only such a card can expire."""
    return f"""{not_merged(alias)}
               AND NOT EXISTS (SELECT 1 FROM cards.card_links l WHERE l.to_card_id = {alias}.id
                              AND l.kind IN ('answers', 'supersedes') AND l.revoked_at IS NULL)"""

# The meeting card c is listed, counted and carried over under (QOR-5000): that of its newest
# carry still standing (writer.home), else its own.
def home_of(card):
    """The home of the card aliased `card` in a query."""
    return f"""COALESCE((SELECT x.meeting_id FROM cards.card_carries x WHERE x.card_id = {card}.id AND x.revoked_at IS NULL
                    ORDER BY x.created_at DESC, x.id DESC LIMIT 1), {card}.meeting_id)"""


HOME = home_of("c")
# Card c is at home in the meeting given as a parameter three times: read from its own cards
# and those carried to it, never from every card's home. The carried ones are read first, as
# an array, so the planner can still use cards_meeting for the rest.
AT_HOME = f"""(c.meeting_id = %s OR c.id = ANY(ARRAY(SELECT x.card_id FROM cards.card_carries x WHERE x.meeting_id = %s
                                                       AND x.revoked_at IS NULL))) AND {HOME} = %s::uuid"""


def not_kept(alias):
    """Never kept, the card `alias` names. Read from its events, so a keep needs no column of its own."""
    return f"""NOT EXISTS (SELECT 1 FROM cards.card_events k WHERE k.card_id = {alias}.id AND k.action = 'card.keep')"""


NOT_MERGED, CURRENT, NOT_KEPT = not_merged("c"), current("c"), not_kept("c")


def expirable(days):
    """Card c can expire, live on the board for more than `days` days: SQL as is (a number)
    or a parameter ('%s'). The API warns from WARN_DAYS on what expire() closes at EXPIRE_DAYS."""
    return f"""c.status = 'open' AND NOT c.archived AND c.live_at < now() - {days} * interval '1 day'
               AND {CURRENT} AND {NOT_KEPT}"""


def owner_set(owner, member_id=None):
    """The SET for accepted_at as the card's owner member becomes `owner`, given by
    `member_id` (None: the writer): kept while the owner member stays the same, accepted when
    a person takes the card themself, else waiting for the new owner. (sql, params)"""
    sql = """accepted_at = CASE WHEN owner_member_id IS NOT DISTINCT FROM %s::uuid THEN accepted_at
                                WHEN %s::uuid = %s::uuid THEN now() END"""
    return sql, [owner, owner, member_id]


def person_change(fields, member_id):
    """The SET list for a person's change of `fields` ({column: value}) on a card, with what
    the action does to its life: a draft goes live (as `fields` close it, if they do), and
    the owner acting, or taking the card, accepts it. (sql, params)"""
    sets, params = [f"{k} = %s" for k in fields], list(fields.values())
    if "status" not in fields:
        sets.append("status = CASE WHEN status = 'draft' THEN 'open' ELSE status END")
    sets.append("live_at = COALESCE(live_at, now())")
    if "owner_member_id" in fields:
        accept, accept_params = owner_set(fields["owner_member_id"], member_id)
    else:
        accept = "accepted_at = CASE WHEN owner_member_id = %s::uuid THEN COALESCE(accepted_at, now()) ELSE accepted_at END"
        accept_params = [member_id]
    return ", ".join([*sets, accept]), params + accept_params


def event(conn, card_id, meeting_id, action, actor_kind, member_id=None, before=None, after=None, cause=None):
    """One line of a card's history (cards.card_events). `before`, `after` and `cause` are JSON,
    or None for none."""
    conn.execute(
        """INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, actor_member_id, before, after, cause)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
        [card_id, meeting_id, action, actor_kind, member_id,
         *(None if v is None else Jsonb(v) for v in (before, after, cause))])


def acted(conn, card_ids, member_id):
    """A person's action on cards that sets none of their fields (a hand-off, a plugin's note,
    an unmerge, a hint), in the action's transaction. A card with nothing to change is left
    as it is, its version included."""
    sets, params = person_change({}, member_id)
    conn.execute(f"""UPDATE cards.cards SET {sets} WHERE id = ANY(%s::uuid[])
                        AND (status = 'draft' OR (owner_member_id = %s::uuid AND accepted_at IS NULL))""",
                 [*params, [str(card_id) for card_id in card_ids], member_id])


def go_live(conn, keyless):
    """The drafts of every ended meeting whose clean-up is over: it completed, used up its
    attempts, or cannot run because the writer has no key (`keyless`), or the clean-up was
    queued, or the meeting ended, CLEAN_UP_HOURS ago (a meeting may have no end recorded, or
    no job when its last lines were never read). A draft merged into another card stays as
    it is. A meeting whose clean-up is running now (its last attempt counts as used from the
    start) is left until it ends: its lock, the clean-up's own (loop._reconcile_jobs), is
    taken here for the transaction, and a held one is skipped. The lock is tried only on the
    meetings already found ready (materialized first), never on a live meeting or one whose
    clean-up is still due, so a pass never stalls their clean-up or a Merge now."""
    conn.execute(f"""WITH ready AS MATERIALIZED (
                       SELECT DISTINCT c.meeting_id FROM cards.cards c
                         JOIN bwat.v_cards_occurrences o ON o.meeting_id = c.meeting_id
                        WHERE c.status = 'draft' AND {NOT_MERGED} AND o.occurrence_state <> 'live'
                          AND (%s OR o.ended_at < now() - %s * interval '1 hour'
                               OR EXISTS (SELECT 1 FROM cards.reconciliation_jobs j WHERE j.meeting_id = c.meeting_id
                                            AND (j.completed_at IS NOT NULL OR j.attempts >= %s
                                                 OR j.queued_at < now() - %s * interval '1 hour')))),
                     locked AS MATERIALIZED (
                       SELECT meeting_id FROM ready
                        WHERE pg_try_advisory_xact_lock(hashtextextended('{RECONCILE_LOCK}' || meeting_id::text, 0)))
                     UPDATE cards.cards c SET status = 'open', live_at = now()
                       FROM locked WHERE c.meeting_id = locked.meeting_id AND c.status = 'draft' AND {NOT_MERGED}""",
                 [keyless, CLEAN_UP_HOURS, RECONCILIATION_ATTEMPTS, CLEAN_UP_HOURS])


def expire(conn):
    """Closes every live card on the board no person has acted on for EXPIRE_DAYS, and no
    person has kept, as no_response, each with an event that names no member. Returns how many.

    The candidates are locked first: only cards no person has acted on for EXPIRE_DAYS as
    far as that statement sees, skipping any a person holds now (the next pass sees them).
    The person-event check then runs again as its own statement, so it reads every event
    committed before the lock was taken. Checked in the locking statement alone, it would
    read an older snapshot and close a card a person acted on while the check waited."""
    with conn.transaction():
        idle = [row[0] for row in conn.execute(
            f"""SELECT c.id FROM cards.cards c
                 WHERE {expirable('%s')}
                   AND NOT EXISTS (SELECT 1 FROM cards.card_events e WHERE e.card_id = c.id AND e.actor_kind = 'member'
                                     AND e.at >= now() - %s * interval '1 day')
                   FOR UPDATE SKIP LOCKED""", [EXPIRE_DAYS, EXPIRE_DAYS])]
        if not idle:
            return 0
        return len(conn.execute(
            """WITH idle AS (
                 UPDATE cards.cards c SET status = 'no_response'
                  WHERE c.id = ANY(%s)
                    AND NOT EXISTS (SELECT 1 FROM cards.card_events e WHERE e.card_id = c.id AND e.actor_kind = 'member'
                                      AND e.at >= now() - %s * interval '1 day')
                 RETURNING c.id, c.meeting_id)
               INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, before, after)
               SELECT id, meeting_id, 'card.expire', 'system', '{"status": "open"}', '{"status": "no_response"}' FROM idle
               RETURNING card_id""", [idle, EXPIRE_DAYS]).fetchall())


def expires_in(status, archived, idle_days):
    """The days a live card has left from WARN_DAYS on, else None. `idle_days`: days since
    it went live or a person last acted on it, whichever is later."""
    if status != "open" or archived or idle_days is None or idle_days < WARN_DAYS:
        return None
    # At least 1: the check that closes it runs every 30 s.
    return max(1, math.ceil(EXPIRE_DAYS - idle_days))
