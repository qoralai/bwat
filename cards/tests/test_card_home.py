"""A card's home meeting (QOR-5000). An open card no person has acted on moves to the later
meeting whose words the writer adds to it (a revision, or an owner the room gave it): it is
listed, counted and carried over there. Its own meeting, quotes and events never change.
"Move back" takes it home again, for good. The writer's carry is no person's action, so it
does not restart the card's expiry clock; Move back is one, so it does."""

import uuid

import pytest

from api.app import Cards
from tests import test_api_person as person
from tests import test_jev_hints as jev_hints
from tests.acceptance.test_commitment_becomes_card import model_replying
from tests.test_api_person import as_person
from tests.test_jev_hints import card
from tests.test_writer_board import claim, first_card
from tests.test_writer_revisions import revision
from writer.window import read_window

board = person.board
other_meeting = jev_hints.other_meeting


def own_series(db, meeting_id):
    """The meeting gets a series of its own, so other tests' occurrences are not its, and
    started on 8 Oct."""
    with db.connect("owner") as conn:
        conn.execute("UPDATE bwat.meetings SET meeting_number = %s, started_at = '2026-10-08T15:00:00Z' WHERE id = %s",
                     [str(uuid.uuid4().int)[:11], meeting_id])


def later(db, meeting_id, days=1):
    """Another occurrence of the meeting's series, `days` after it started."""
    with db.connect("runtime") as conn:
        return str(conn.execute(
            """INSERT INTO bwat.meetings (occurrence_uuid, meeting_number, started_at)
               SELECT %s, meeting_number, started_at + %s * interval '1 day' FROM bwat.meetings WHERE id = %s
               RETURNING id""", [f"occ-{uuid.uuid4().hex[:8]}", days, meeting_id]).fetchone()[0])


def revised_in(db, meeting, meeting_id, display, version=1):
    """The writer reads a window of `meeting_id` that revises card `display`."""
    frames, proposal = revision(meeting, display, version)
    assert read_window(db.url("cards"), meeting_id, frames, model_replying([proposal]))["updated"] == 1


def listed(db, meeting_id):
    return [c["id"] for c in Cards(db.url("cards")).for_occurrence(str(meeting_id))]


def acted_on(db, card_id, member_id):
    api = Cards(db.url("cards"))
    api.update(card_id, api.one(card_id)["revision"], str(member_id), "card.keep", lambda c: {}, always=True)


def events(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute("SELECT action, actor_kind FROM cards.card_events WHERE card_id = %s ORDER BY at, id",
                            [card_id]).fetchall()


@pytest.fixture
def carried(db, meeting):
    """Marco's to-do from `meeting`, revised by the writer in the next occurrence a day later."""
    own_series(db, meeting["id"])
    card_id, display = first_card(db, meeting)
    second = later(db, meeting["id"])
    revised_in(db, meeting, second, display)
    return {"card": str(card_id), "display": display, "first": str(meeting["id"]), "second": second}


def test_the_writer_adding_to_an_unacted_card_from_a_later_meeting_brings_it_there(db, carried):
    assert carried["card"] in listed(db, carried["second"])
    # The old meeting shows nothing of it.
    assert carried["card"] not in listed(db, carried["first"])
    shown = Cards(db.url("cards")).one(carried["card"])
    # Still the card it was: its own meeting, when that started, and its quotes there.
    assert (shown["meeting_id"], shown["home_meeting_id"], shown["carried_by"]) == (
        carried["first"], carried["second"], "writer")
    assert shown["meeting_started_at"] == "2026-10-08T15:00:00+00:00"
    assert {e["meeting_id"] for e in shown["evidence"]} == {carried["first"], carried["second"]}


def test_the_carry_is_the_writers_and_restarts_no_clock(db, carried):
    assert ("card.carry", "writer") in events(db, carried["card"])
    assert all(actor != "member" for _, actor in events(db, carried["card"]))


def test_an_owner_the_later_room_gives_carries_the_card_too(db, meeting):
    card_id, display = first_card(db, meeting)
    second = later(db, meeting["id"])
    lines, claimed = claim(meeting, display)
    assert read_window(db.url("cards"), second, lines, model_replying([claimed]))["updated"] == 1
    assert str(card_id) in listed(db, second)


def test_a_card_a_person_acted_on_stays_where_it_is(db, meeting):
    card_id, display = first_card(db, meeting)
    acted_on(db, str(card_id), meeting["marco"])
    second = later(db, meeting["id"])
    revised_in(db, meeting, second, display, Cards(db.url("cards")).one(str(card_id))["revision"])
    assert listed(db, meeting["id"]) == [str(card_id)]
    assert Cards(db.url("cards")).one(str(card_id))["carried_by"] is None


def test_the_writer_adding_in_the_cards_own_meeting_moves_nothing(db, meeting):
    card_id, display = first_card(db, meeting)
    revised_in(db, meeting, meeting["id"], display)
    assert listed(db, meeting["id"]) == [str(card_id)]
    assert ("card.carry", "writer") not in events(db, str(card_id))


def test_a_card_never_goes_back_to_an_earlier_meeting_than_its_home(db, meeting, carried):
    """Two meetings running on: the earlier one's words still add to the card, but it stays."""
    third = later(db, meeting["id"], days=2)
    api = Cards(db.url("cards"))
    revised_in(db, meeting, third, carried["display"], api.one(carried["card"])["revision"])
    revised_in(db, meeting, carried["second"], carried["display"], api.one(carried["card"])["revision"])
    assert api.one(carried["card"])["home_meeting_id"] == third


def test_the_counts_move_the_card_and_both_meetings_versions(db, meeting):
    _, display = first_card(db, meeting)
    card(db, meeting["id"], "Stays")
    second = later(db, meeting["id"])
    card(db, second, "Already there")
    ticks = iter(range(0, 10**9, 10**4))
    api = Cards(db.url("cards"), clock=lambda: next(ticks))
    count = lambda: {m["meeting_id"]: m for m in api.counts()["meetings"]}
    before = count()
    revised_in(db, meeting, second, display)
    after = count()
    first, then = (before[str(meeting["id"])], after[str(meeting["id"])]), (before[second], after[second])
    assert (first[1]["cards"], then[1]["cards"]) == (first[0]["cards"] - 1, then[0]["cards"] + 1)
    assert first[1]["cards_version"] != first[0]["cards_version"]
    assert then[1]["cards_version"] != then[0]["cards_version"]


def test_deleting_the_later_meeting_takes_the_card_home(db, carried):
    with db.connect("runtime") as conn:
        conn.execute("DELETE FROM bwat.meetings WHERE id = %s", [carried["second"]])
    assert listed(db, carried["first"]) == [carried["card"]]


def test_move_back_takes_the_card_home_for_good_as_the_persons_action(db, meeting, carried):
    api = Cards(db.url("cards"))
    moved = api.move_back(carried["card"], api.one(carried["card"])["revision"], str(meeting["marco"]))
    assert (moved["home_meeting_id"], moved["carried_by"]) == (carried["first"], None)
    assert listed(db, carried["first"]) == [carried["card"]]
    assert events(db, carried["card"])[-1] == ("card.move_back", "member")
    # That meeting's words never carry it again.
    revised_in(db, meeting, carried["second"], carried["display"], api.one(carried["card"])["revision"])
    assert api.one(carried["card"])["home_meeting_id"] == carried["first"]


def test_move_back_needs_a_carry_and_the_revision_the_person_saw(db, meeting, carried):
    from api.app import Refused
    api = Cards(db.url("cards"))
    with pytest.raises(Refused) as stale:
        api.move_back(carried["card"], api.one(carried["card"])["revision"] - 1, str(meeting["marco"]))
    assert stale.value.error == "stale_revision"
    api.move_back(carried["card"], api.one(carried["card"])["revision"], str(meeting["marco"]))
    with pytest.raises(Refused) as home:
        api.move_back(carried["card"], api.one(carried["card"])["revision"], str(meeting["marco"]))
    assert (home.value.status, home.value.error) == (409, "not_carried")


def test_the_board_moves_a_card_back(db, board):
    second = later(db, board["meeting"])
    with db.connect("cards") as conn:
        conn.execute("INSERT INTO cards.card_carries (card_id, meeting_id) VALUES (%s, %s)", [board["card"], second])
    rev = Cards(db.url("cards")).one(board["card"])["revision"]
    moved = board["client"].post(f"/v1/cards/{board['card']}/move-back", **as_person(json={"revision": rev}))
    assert moved.status_code == 200
    assert moved.json()["home_meeting_id"] == board["meeting"]
    assert person.events(db, board["card"])[-1] == ("card.move_back", "member", board["member"])


def test_the_next_occurrence_carries_over_the_card_from_its_new_home(db, meeting, carried):
    third = later(db, meeting["id"], days=2)
    with db.connect("cards") as conn:
        number, occurrence = conn.execute("SELECT meeting_number, occurrence_uuid FROM bwat.v_cards_occurrences "
                                          "WHERE meeting_id = %s", [third]).fetchone()
    titles = [title for _, title, _, _ in Cards(db.url("cards")).agenda(number, occurrence)]
    # A later meeting never rewrites the title (revisions.revise): the card as it was.
    assert "Send the license draft to legal by Friday" in titles


def test_the_meetings_open_questions_include_one_carried_to_it(db, meeting):
    question = card(db, meeting["id"], "Will it ship?", kind="question")
    second = later(db, meeting["id"])
    with db.connect("cards") as conn:
        conn.execute("INSERT INTO cards.card_carries (card_id, meeting_id) VALUES (%s, %s)", [question, second])
        first_occ, second_occ = (conn.execute("SELECT occurrence_uuid FROM bwat.v_cards_occurrences WHERE meeting_id = %s",
                                              [m]).fetchone()[0] for m in (meeting["id"], second))
    api = Cards(db.url("cards"))
    assert [title for _, title in api.open_questions(second_occ)] == ["Will it ship?"]
    assert api.open_questions(first_occ) == []


def merged_in(db, meeting, member_id=None):
    """Ship it, said in `meeting`, merged into from its duplicate in the next occurrence a day
    later: by `member_id`, else by the clean-up (the duplicate a draft)."""
    from writer.reconcile import apply_merge, candidates
    own_series(db, meeting["id"])
    second = later(db, meeting["id"])
    older, newer = card(db, meeting["id"], "Ship it"), card(db, second, "Ship it again")
    with db.connect("cards") as conn, conn.transaction():
        conn.execute("UPDATE cards.cards SET status = 'draft' WHERE id = %s", [newer])
        apply_merge(conn, {"older": older, "newer": newer, "context": "Raised again."}, candidates(conn, second),
                    member_id and str(member_id))
    return {"older": older, "newer": newer, "first": str(meeting["id"]), "second": second}


def test_a_persons_merge_from_a_later_meeting_brings_the_card_kept_there(db, meeting):
    pair = merged_in(db, meeting, meeting["marco"])
    shown = Cards(db.url("cards")).one(pair["older"])
    assert (shown["home_meeting_id"], shown["carried_by"]) == (pair["second"], "merge")
    assert pair["older"] in listed(db, pair["second"]) and pair["older"] not in listed(db, pair["first"])


def test_the_clean_ups_merge_moves_nothing(db, meeting):
    pair = merged_in(db, meeting)
    assert Cards(db.url("cards")).one(pair["older"])["home_meeting_id"] == pair["first"]


def test_unmerge_takes_a_card_a_merge_carried_home_and_move_back_does_not(db, meeting):
    from api.app import Refused
    from writer.reconcile import undo_merge
    pair = merged_in(db, meeting, meeting["marco"])
    api = Cards(db.url("cards"))
    with pytest.raises(Refused) as refused:
        api.move_back(pair["older"], api.one(pair["older"])["revision"], str(meeting["marco"]))
    assert refused.value.error == "not_carried"
    with db.connect("cards") as conn, conn.transaction():
        undo_merge(conn, pair["newer"], pair["older"], api.one(pair["older"])["revision"], str(meeting["marco"]))
    assert (api.one(pair["older"])["home_meeting_id"], api.one(pair["older"])["carried_by"]) == (pair["first"], None)


def test_another_series_words_never_carry_the_card(db, meeting, carried, other_meeting):
    with db.connect("owner") as conn:
        conn.execute("UPDATE bwat.meetings SET started_at = now() + interval '3 days' WHERE id = %s", [other_meeting])
    api = Cards(db.url("cards"))
    revised_in(db, meeting, other_meeting, carried["display"], api.one(carried["card"])["revision"])
    assert api.one(carried["card"])["home_meeting_id"] == carried["second"]


def test_a_merge_brings_the_card_kept_to_where_the_merged_card_is_at_home(db, meeting):
    from writer.reconcile import apply_merge, candidates
    own_series(db, meeting["id"])
    second, third = later(db, meeting["id"]), later(db, meeting["id"], days=2)
    older, newer = card(db, meeting["id"], "Ship it"), card(db, second, "Ship it again")
    with db.connect("cards") as conn, conn.transaction():
        conn.execute("INSERT INTO cards.card_carries (card_id, meeting_id) VALUES (%s, %s)", [newer, third])
        apply_merge(conn, {"older": older, "newer": newer, "context": "Raised again."}, candidates(conn, second),
                    str(meeting["marco"]))
    assert Cards(db.url("cards")).one(older)["home_meeting_id"] == third


def test_move_back_goes_back_to_the_meeting_it_was_said_in(db, meeting, carried):
    """Carried on twice by the writer: Move back goes all the way home, and stays there."""
    third = later(db, meeting["id"], days=2)
    api = Cards(db.url("cards"))
    revised_in(db, meeting, third, carried["display"], api.one(carried["card"])["revision"])
    assert api.one(carried["card"])["home_meeting_id"] == third
    api.move_back(carried["card"], api.one(carried["card"])["revision"], str(meeting["marco"]))
    assert api.one(carried["card"])["home_meeting_id"] == carried["first"]
    # Acted on now: a later occurrence's words no longer carry it.
    fourth = later(db, meeting["id"], days=3)
    revised_in(db, meeting, fourth, carried["display"], api.one(carried["card"])["revision"])
    assert api.one(carried["card"])["home_meeting_id"] == carried["first"]


def test_move_back_leaves_a_card_a_merge_carried_on_top_to_its_unmerge(db, meeting, carried):
    from api.app import Refused
    from writer.reconcile import apply_merge, candidates
    third = later(db, meeting["id"], days=2)
    duplicate = card(db, third, "Send the draft to legal")
    with db.connect("cards") as conn, conn.transaction():
        conn.execute("UPDATE cards.cards SET owner_name = 'Legal team' WHERE id = %s", [duplicate])
        apply_merge(conn, {"older": carried["card"], "newer": duplicate, "context": "Raised again."},
                    candidates(conn, third), str(meeting["marco"]))
    api = Cards(db.url("cards"))
    with pytest.raises(Refused) as refused:
        api.move_back(carried["card"], api.one(carried["card"])["revision"], str(meeting["marco"]))
    assert refused.value.error == "not_carried"
    with db.connect("cards") as conn:
        assert conn.execute("SELECT count(*) FROM cards.card_carries WHERE card_id = %s AND revoked_at IS NULL",
                            [carried["card"]]).fetchone()[0] == 2


def test_a_meetings_cards_version_moves_when_a_card_leaves_it_whatever_the_others_do(db, meeting):
    """X leaves for a later meeting while Y, still here, moves by exactly X's version: a sum of
    versions would stand still, and a board would never read the meeting again."""
    own_series(db, meeting["id"])
    x, display = first_card(db, meeting)
    y = card(db, meeting["id"], "Stays")
    second = later(db, meeting["id"])
    ticks = iter(range(0, 10**9, 10**4))
    api = Cards(db.url("cards"), clock=lambda: next(ticks))
    version = lambda: {m["meeting_id"]: m for m in api.counts()["meetings"]}[str(meeting["id"])]["cards_version"]
    before = version()
    x_version = api.one(str(x))["revision"]
    revised_in(db, meeting, second, display, x_version)
    with db.connect("cards") as conn:
        for _ in range(x_version):
            conn.execute("UPDATE cards.cards SET archived = archived WHERE id = %s", [y])
    assert version() != before
