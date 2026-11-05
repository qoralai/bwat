"""The writer closes a draft it wrote when later lines show it was not real: a draft is
bwat's own (D187). Never a live card, and never without the words that show it.
"""

from api.app import CLARIFY_MARK, Cards
from tests.acceptance.test_commitment_becomes_card import line, model_replying
from tests.test_writer_board import first_card
from writer.window import board_digest, build_parts, read_window

SAID = "Actually scrap that, legal already has the draft."


def closing(meeting, display_id, version=1, quote="scrap that, legal already has the draft", seq=30):
    lines = [line(seq, meeting["marco_name"], SAID, meeting["marco"])]
    proposal = {"op": "close", "card_id": display_id, "expected_version": version,
                "reason": "Marco took the commitment back: legal already has the draft.",
                "evidence": [{"epoch": 0, "seq": seq, "speaker": meeting["marco_name"], "quote": quote}]}
    return lines, proposal


def status_of(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute("SELECT status, archived, live_at FROM cards.cards WHERE id = %s", [card_id]).fetchone()


def test_the_writer_closes_its_own_draft_with_the_words_that_show_it(db, meeting):
    card_id, display_id = first_card(db, meeting)
    lines, proposal = closing(meeting, display_id)
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    assert (result["updated"], result["refused"]) == (1, [])
    # Closed as bwat's own won't-do: still on the board, never live, so it never counts as a
    # person's close.
    assert status_of(db, card_id) == ("wont_do", False, None)
    view = Cards(db.url("cards")).one(str(card_id))
    assert view["withdrawn"] is True and view["done"] is False
    assert any(e["quote"] == "scrap that, legal already has the draft" for e in view["evidence"])
    assert "Closed by bwat" in view["detail_html"]
    with db.connect("cards") as conn:
        event = conn.execute("SELECT action, actor_kind, actor_member_id, before, after FROM cards.card_events "
                             "WHERE card_id = %s ORDER BY at DESC LIMIT 1", [card_id]).fetchone()
    assert event == ("card.withdraw", "writer", None, {"status": "draft"}, {"status": "wont_do"})


def test_the_writer_never_closes_a_live_card(db, meeting):
    card_id, display_id = first_card(db, meeting)
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET status = 'open', live_at = now() WHERE id = %s", [card_id])
    lines, proposal = closing(meeting, display_id, version=2)
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    assert len(result["refused"]) == 1
    assert status_of(db, card_id)[0] == "open"


def test_the_writer_never_closes_a_draft_without_a_checked_quote(db, meeting):
    card_id, display_id = first_card(db, meeting)
    lines, proposal = closing(meeting, display_id, quote="words nobody said")
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    assert len(result["refused"]) == 1
    assert status_of(db, card_id)[0] == "draft"


def test_the_board_tells_the_writer_which_cards_are_drafts(db, meeting):
    first_card(db, meeting)
    with db.connect("cards") as conn:
        board = board_digest(conn)
    _, volatile = build_parts([line(40, meeting["marco_name"], "Next topic.")], board)
    assert "-- DRAFT" in volatile


ASKED = "Is the license draft with legal yet?"
ANSWERED = "Yes, legal has had it since Monday."


def asked_draft(db, meeting):
    """A draft question of this meeting, as the writer writes one."""
    question = {"bucket": "ask", "title": ASKED,
                "detail": "<p>Ada asked whether legal has the license draft.</p>",
                "evidence": [{"epoch": 0, "seq": 10, "speaker": meeting["ada_name"], "quote": ASKED}]}
    read_window(db.url("cards"), meeting["id"], [line(10, meeting["ada_name"], ASKED, meeting["ada"])],
                model_replying([question]))
    with db.connect("cards") as conn:
        return conn.execute("SELECT id, display_id FROM cards.cards WHERE meeting_id = %s AND kind = 'question'",
                            [meeting["id"]]).fetchone()


def closing_question(meeting, display_id, **extra):
    lines = [line(31, meeting["marco_name"], ANSWERED, meeting["marco"])]
    proposal = {"op": "close", "card_id": display_id, "expected_version": 1,
                "reason": "Marco said legal has had the draft since Monday.",
                "evidence": [{"epoch": 0, "seq": 31, "speaker": meeting["marco_name"], "quote": ANSWERED}], **extra}
    return lines, proposal


def test_a_question_the_room_answered_closes_with_its_answer_on_it(db, meeting):
    # QOR-5003: the answer is the card service's own mark, so the board's "Answered questions"
    # switch hides it like a question a person answered.
    card_id, display_id = asked_draft(db, meeting)
    lines, proposal = closing_question(meeting, display_id, answered=True)
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    assert (result["updated"], result["refused"]) == (1, [])
    view = Cards(db.url("cards")).one(str(card_id))
    # Still bwat's own close of a draft, never a person's.
    assert view["withdrawn"] is True and view["done"] is False and view["archived"] is False
    assert CLARIFY_MARK in view["detail_html"]
    assert "legal has had the draft since Monday" in view["detail_html"]


def test_a_question_the_room_dropped_closes_without_an_answer(db, meeting):
    card_id, display_id = asked_draft(db, meeting)
    lines, proposal = closing_question(meeting, display_id)
    read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    view = Cards(db.url("cards")).one(str(card_id))
    assert view["withdrawn"] is True
    assert "Closed by bwat" in view["detail_html"] and CLARIFY_MARK not in view["detail_html"]


def test_only_a_question_closes_as_answered(db, meeting):
    card_id, display_id = first_card(db, meeting)
    lines, proposal = closing(meeting, display_id)
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal | {"answered": True}]))
    assert len(result["refused"]) == 1
    assert status_of(db, card_id)[0] == "draft"


def test_the_writer_is_told_to_say_when_a_close_is_an_answer():
    stable, _ = build_parts([line(40, "Marco", "Next topic.")], {})
    assert '"answered": true' in stable


def test_only_answered_true_records_an_answer(db, meeting):
    card_id, display_id = asked_draft(db, meeting)
    lines, proposal = closing_question(meeting, display_id, answered="true")
    read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    assert CLARIFY_MARK not in Cards(db.url("cards")).one(str(card_id))["detail_html"]


def test_the_answer_is_written_as_text(db, meeting):
    card_id, display_id = asked_draft(db, meeting)
    lines, proposal = closing_question(meeting, display_id, answered=True)
    read_window(db.url("cards"), meeting["id"], lines,
                model_replying([proposal | {"reason": '<img src=x onerror="alert(1)"> data-clarify="x"'}]))
    detail = Cards(db.url("cards")).one(str(card_id))["detail_html"]
    assert "<img" not in detail and "&lt;img" in detail and detail.count(CLARIFY_MARK) == 1


def test_a_live_question_never_closes_as_answered(db, meeting):
    card_id, display_id = asked_draft(db, meeting)
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET status = 'open', live_at = now() WHERE id = %s", [card_id])
    lines, proposal = closing_question(meeting, display_id, answered=True)
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal | {"expected_version": 2}]))
    assert len(result["refused"]) == 1
    assert status_of(db, card_id)[0] == "open"
