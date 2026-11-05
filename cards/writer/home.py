"""A card's home meeting (QOR-5000): the meeting it is listed, counted and carried over under.

An open card no person has acted on goes where it is being talked about: when a later
occurrence of its series revises it or gives it its owner, the writer carries it there
(cards.card_carries). Its own meeting, quotes and events stay as they were. The carry is the
writer's, so it does not restart the card's expiry clock (writer.lifecycle). A person's Move
back revokes it for good: that meeting never carries the card again. A person's merge from a
later meeting carries the card kept with its link, and an Unmerge revokes that carry.
"""

from writer.lifecycle import CURRENT, HOME, ON_BOARD, event, home_of

# Card c to the meeting `here`: only a later occurrence of the series of c's home, so the card
# still carries over to that series' next agenda.
LATER = f"""JOIN bwat.v_cards_occurrences home ON home.meeting_id = {HOME}
             WHERE here.started_at > home.started_at AND here.meeting_number = home.meeting_number"""


def carry(conn, meeting_id, target):
    """Carries `target`, a card on the writer's board the window of `meeting_id` just changed,
    to that meeting: when it is open, current and no person has acted on it, and the meeting
    started after the card's home did. Returns whether it moved; `target`'s version is the
    card's new one."""
    moved = conn.execute(
        f"""INSERT INTO cards.card_carries (card_id, meeting_id)
            SELECT c.id, here.meeting_id FROM cards.cards c
              JOIN bwat.v_cards_occurrences here ON here.meeting_id = %s {LATER}
               AND c.id = %s AND c.status = ANY(%s) AND NOT c.archived AND {CURRENT}
               AND NOT EXISTS (SELECT 1 FROM cards.card_events e WHERE e.card_id = c.id AND e.actor_kind = 'member')
            ON CONFLICT (card_id, meeting_id) WHERE link_id IS NULL DO NOTHING
            RETURNING card_id""", [meeting_id, target["id"], list(ON_BOARD)]).fetchone()
    if not moved:
        return False
    event(conn, target["id"], target["meeting_id"], "card.carry", "writer", cause={"meeting_id": str(meeting_id)})
    # The carry moved the version: a later op on the card at the old one is refused, as after
    # any of the window's own writes (QOR-4769).
    target["version"] = conn.execute("SELECT version FROM cards.cards WHERE id = %s", [target["id"]]).fetchone()[0]
    return True


def carry_by_merge(conn, kept, merged, link_id):
    """A person's merge (`link_id`) of `merged` into `kept`: `kept` goes to the meeting
    `merged` is at home in, where the person saw it, when that is a later occurrence of its
    series. Its card.merge events record it."""
    conn.execute(
        f"""INSERT INTO cards.card_carries (card_id, meeting_id, link_id)
            SELECT c.id, here.meeting_id, %s FROM cards.cards c
              JOIN bwat.v_cards_occurrences here
                ON here.meeting_id = (SELECT {home_of("m")} FROM cards.cards m WHERE m.id = %s) {LATER} AND c.id = %s""",
        [link_id, merged["id"], kept["id"]])


def uncarry_merge(conn, link_id, member_id):
    """An Unmerge of `link_id` takes back the carry it made."""
    conn.execute("UPDATE cards.card_carries SET revoked_at = now(), revoked_by = %s WHERE link_id = %s AND revoked_at IS NULL",
                 [member_id, link_id])
