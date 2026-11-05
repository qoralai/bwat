"""Each to-do carries the writer's auto-apply confidence (0-100) and the action it suggests
(act, investigate or leave), so the session it is handed to can decide whether to act on it
without a person checking first.
"""

from api.app import Cards, brief_text
from tests.acceptance.test_commitment_becomes_card import commitment, model_replying, window
from writer.window import read_window


def written(db, meeting, card):
    read_window(db.url("cards"), meeting["id"], window(meeting), model_replying([card]))
    with db.connect("cards") as conn:
        card_id = conn.execute("SELECT id FROM cards.cards WHERE meeting_id = %s", [meeting["id"]]).fetchone()[0]
    return Cards(db.url("cards")).one(str(card_id))


def test_a_to_do_carries_the_writers_confidence_and_action_to_the_board_and_the_hand_off(db, meeting):
    card = written(db, meeting, commitment(meeting) | {"auto": {"confidence": 35, "action": "investigate"}})
    assert (card["auto_apply_confidence"], card["suggested_action"]) == (35, "investigate")
    body = brief_text(card)["body"]
    # Model output from meeting speech: the brief says so, never states it as a check.
    assert "Auto-apply (the card writer's estimate from the meeting, not a check): 35%, investigate" in body


def test_only_a_to_do_carries_one(db, meeting):
    decided = commitment(meeting) | {"bucket": "decided", "auto": {"confidence": 90, "action": "act"}}
    decided.pop("owner")
    card = written(db, meeting, decided)
    assert (card["auto_apply_confidence"], card["suggested_action"]) == (None, None)
    assert "Auto-apply" not in brief_text(card)["body"]


def test_a_score_out_of_range_or_an_unknown_action_is_left_out_and_the_card_still_lands(db, meeting):
    card = written(db, meeting, commitment(meeting) | {"auto": {"confidence": 150, "action": "deploy"}})
    assert card["title"] == "Send the license draft to legal by Friday"
    assert (card["auto_apply_confidence"], card["suggested_action"]) == (None, None)


def test_half_a_score_is_no_score(db, meeting):
    card = written(db, meeting, commitment(meeting) | {"auto": {"confidence": 95, "action": "deploy"}})
    assert (card["auto_apply_confidence"], card["suggested_action"]) == (None, None)
