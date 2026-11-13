"""Who owns a merged card. For every merge (Merge now, Bring here, the clean-up):
two cards owned by different people never merge; when one of them is unowned, the merge goes
ahead and the card kept takes the other card's owner."""

import json
from types import SimpleNamespace

import pytest

from api.app import Cards
from tests.test_jev_hints import card, links_of
from writer.reconcile import PROMPT, apply_merge, candidates, reconcile


def own(db, card_id, member=None, name=None):
    """Gives the card an owner as the writer wrote it at creation (no event)."""
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET owner_member_id = %s, owner_name = %s WHERE id = %s",
                     [member, name, card_id])


def owner_of(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute("SELECT owner_member_id::text, owner_name, accepted_at IS NOT NULL FROM cards.cards WHERE id = %s",
                            [card_id]).fetchone()


def owner_events(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute("SELECT actor_kind, actor_member_id::text, after, cause FROM cards.card_events "
                            "WHERE card_id = %s AND action = 'card.owner' ORDER BY at, id", [card_id]).fetchall()


def merge(db, meeting_id, older, newer, member_id=None):
    with db.connect("cards") as conn, conn.transaction():
        return apply_merge(conn, {"older": older, "newer": newer, "context": "The same work."},
                           candidates(conn, meeting_id), member_id)


def model(*proposals):
    """The clean-up's model: the pairs it proposes, then a summary for each merge."""
    def complete(prompt, *_):
        return json.dumps(list(proposals)) if prompt == PROMPT else json.dumps({"context": "The same work."})
    return SimpleNamespace(complete=complete)


def test_the_card_kept_takes_the_owner_of_the_card_merged_into_it(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, meeting["ada"], meeting["ada_name"])
    link = merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    assert owner_of(db, older) == (str(meeting["ada"]), meeting["ada_name"], False)
    ((actor, by, after, cause),) = owner_events(db, older)
    # Nobody chose it: bwat's own change, which the room may still change (claim_owner).
    assert (actor, by) == ("system", None)
    assert after == {"owner_member_id": str(meeting["ada"]), "owner_name": meeting["ada_name"]}
    # It cites the merge, and names no other meeting: both cards are this one's.
    assert cause == {"link_id": str(link), "accepted": False}
    assert Cards(db.url("cards")).one(older)["owner_by"] == "agent"


def test_the_owner_merging_their_own_card_in_takes_the_card_kept(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, meeting["marco"], meeting["marco_name"])
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    assert owner_of(db, older) == (str(meeting["marco"]), meeting["marco_name"], True)


def test_an_owned_card_kept_keeps_its_owner(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, older, None, "Legal team")
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    assert owner_of(db, older) == (None, "Legal team", False)
    assert owner_events(db, older) == []


def test_the_same_member_under_two_spoken_names_is_one_owner(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, older, meeting["marco"], "Marco")
    own(db, newer, meeting["marco"], meeting["marco_name"])
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    assert owner_of(db, older)[:2] == (str(meeting["marco"]), "Marco")


@pytest.mark.parametrize("owners", [
    ((("marco", "marco_name")), (("ada", "ada_name"))),
    ((None, "Legal team"), (None, "Finance")),
    ((("marco", "marco_name")), (None, "Legal team")),
])
def test_two_cards_owned_by_different_people_never_merge(db, meeting, owners):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    for card_id, (member, name) in zip((older, newer), owners, strict=True):
        own(db, card_id, member and meeting[member], meeting.get(name, name))
    with pytest.raises(ValueError, match="different ownership"):
        merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    assert links_of(db, newer) == []


def test_the_clean_up_gives_the_card_kept_the_drafts_owner_as_the_writer(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET status = 'draft' WHERE id = %s", [newer])
    own(db, newer, meeting["ada"], meeting["ada_name"])
    assert reconcile(db.url("cards"), meeting["id"], model({"older": older, "newer": newer})) == 1
    assert owner_of(db, older) == (str(meeting["ada"]), meeting["ada_name"], False)
    ((actor, by, _, _),) = owner_events(db, older)
    assert (actor, by) == ("system", None)


def test_the_clean_up_never_gives_an_owner_to_a_card_a_person_left_unowned(db, meeting):
    """bwat never takes an owner a person set or cleared (window.claim_owner): neither does its merge."""
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET status = 'draft' WHERE id = %s", [newer])
        conn.execute("""INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, actor_member_id, after)
                        VALUES (%s, %s, 'card.owner', 'member', %s, '{"owner_member_id": null, "owner_name": null}')""",
                     [older, meeting["id"], meeting["marco"]])
    own(db, newer, meeting["ada"], meeting["ada_name"])
    assert reconcile(db.url("cards"), meeting["id"], model({"older": older, "newer": newer})) == 0
    assert links_of(db, newer) == [] and owner_of(db, older)[:2] == (None, None)


def test_the_clean_up_still_refuses_two_owners(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET status = 'draft' WHERE id = %s", [newer])
    own(db, older, None, "Legal team")
    own(db, newer, meeting["ada"], meeting["ada_name"])
    assert reconcile(db.url("cards"), meeting["id"], model({"older": older, "newer": newer})) == 0
    assert links_of(db, newer) == []


def undo(db, newer, older, member_id):
    from writer.reconcile import undo_merge
    with db.connect("cards") as conn, conn.transaction():
        undo_merge(conn, newer, older, Cards(db.url("cards")).one(older)["revision"], member_id)


def test_undoing_the_merge_takes_back_the_owner_it_gave(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, meeting["ada"], meeting["ada_name"])
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    undo(db, newer, older, str(meeting["marco"]))
    assert owner_of(db, older) == (None, None, False)
    assert owner_of(db, newer)[:2] == (str(meeting["ada"]), meeting["ada_name"])
    # Not a person's choice of no owner: the room may still give the card one.
    assert owner_events(db, older)[-1][:2] == ("system", None)
    assert Cards(db.url("cards")).one(older)["owner_by"] == "agent"


def test_undoing_the_merge_keeps_an_owner_a_person_set_since(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, meeting["ada"], meeting["ada_name"])
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    api = Cards(db.url("cards"))
    api.update(older, api.one(older)["revision"], str(meeting["marco"]), "card.owner",
               lambda c: {"owner_member_id": str(meeting["marco"]), "owner_name": None})
    undo(db, newer, older, str(meeting["marco"]))
    assert owner_of(db, older)[:2] == (str(meeting["marco"]), None)


def test_an_owner_from_another_meeting_names_that_meeting(db, meeting):
    with db.connect("runtime") as conn:
        later = str(conn.execute("INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (gen_random_uuid()::text, "
                                 "'123456789') RETURNING id").fetchone()[0])
    older, newer = card(db, meeting["id"], "Ship it"), card(db, later, "Ship it soon")
    own(db, newer, meeting["ada"], meeting["ada_name"])
    link = merge(db, later, older, newer, str(meeting["marco"]))
    assert owner_events(db, older)[0][3] == {"link_id": str(link), "meeting_id": later, "accepted": False}


def test_the_room_may_give_a_card_that_took_an_owner_by_merge_another(db, meeting):
    from tests.acceptance.test_commitment_becomes_card import model_replying
    from tests.test_writer_board import claim
    from writer.window import read_window
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, None, "Legal team")
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    display = Cards(db.url("cards")).one(older)["display_id"]
    lines, claimed = claim(meeting, display, version=Cards(db.url("cards")).one(older)["revision"])
    assert read_window(db.url("cards"), meeting["id"], lines, model_replying([claimed]))["updated"] == 1
    assert owner_of(db, older)[:2] == (str(meeting["marco"]), meeting["marco_name"])


def test_one_clean_up_never_gives_the_card_kept_two_owners(db, meeting):
    """Two drafts merged into one card in one run: the second sees the owner the first gave."""
    kept = card(db, meeting["id"], "Ship it")
    ann, bob = card(db, meeting["id"], "Ship it soon"), card(db, meeting["id"], "Ship it today")
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET status = 'draft' WHERE id = ANY(%s::uuid[])", [[ann, bob]])
    own(db, ann, meeting["ada"], meeting["ada_name"])
    own(db, bob, meeting["marco"], meeting["marco_name"])
    assert reconcile(db.url("cards"), meeting["id"], model({"older": kept, "newer": ann}, {"older": kept, "newer": bob})) == 1
    assert owner_of(db, kept)[:2] == (str(meeting["ada"]), meeting["ada_name"])
    assert links_of(db, bob) == [] and len(owner_events(db, kept)) == 1


def test_undoing_the_merge_leaves_an_owner_who_has_taken_the_card_on_since(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, meeting["ada"], meeting["ada_name"])
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    with db.connect("cards") as conn:
        # Committed after the merge, however early its transaction began.
        conn.execute("UPDATE cards.cards SET accepted_at = now() - interval '1 hour' WHERE id = %s", [older])
    undo(db, newer, older, str(meeting["marco"]))
    assert owner_of(db, older) == (str(meeting["ada"]), meeting["ada_name"], True)


def test_undoing_their_own_merge_takes_back_the_card_the_owner_took_with_it(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, meeting["marco"], meeting["marco_name"])
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    assert owner_of(db, older)[2] is True
    undo(db, newer, older, str(meeting["marco"]))
    assert owner_of(db, older) == (None, None, False)


def test_an_owner_a_person_chose_stays_theirs_on_the_card_kept(db, meeting):
    """Ada was given the duplicate by Marco: after the merge the room cannot take it from her."""
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    api = Cards(db.url("cards"))
    api.update(newer, api.one(newer)["revision"], str(meeting["marco"]), "card.owner",
               lambda c: {"owner_member_id": str(meeting["ada"]), "owner_name": None})
    merge(db, meeting["id"], older, newer, str(meeting["ada"]))
    assert owner_events(db, older)[-1][:2] == ("member", str(meeting["marco"]))
    assert Cards(db.url("cards")).one(older)["owner_by"] == str(meeting["marco"])


def test_an_owner_the_room_gave_stays_bwats_on_the_card_kept(db, meeting):
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, meeting["ada"], meeting["ada_name"])
    with db.connect("cards") as conn:
        conn.execute("""INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, after)
                        VALUES (%s, %s, 'card.owner', 'writer', '{}')""", [newer, meeting["id"]])
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    assert owner_events(db, older)[-1][:2] == ("system", None)


def test_undoing_the_merge_keeps_an_owner_a_person_set_in_a_transaction_that_began_first(db, meeting):
    """That change's event is timed before the merge's, though it landed after it."""
    older, newer = card(db, meeting["id"], "Ship it"), card(db, meeting["id"], "Ship it soon")
    own(db, newer, meeting["ada"], meeting["ada_name"])
    merge(db, meeting["id"], older, newer, str(meeting["marco"]))
    api = Cards(db.url("cards"))
    api.update(older, api.one(older)["revision"], str(meeting["marco"]), "card.owner",
               lambda c: {"owner_member_id": None, "owner_name": "Legal team"})
    # The card login never rewrites history: the owner sets up the crossing.
    with db.connect("owner") as conn:
        conn.execute("""UPDATE cards.card_events SET at = at - interval '1 minute'
                         WHERE card_id = %s AND action = 'card.owner' AND actor_kind = 'member'""", [older])
    undo(db, newer, older, str(meeting["marco"]))
    assert owner_of(db, older)[:2] == (None, "Legal team")
