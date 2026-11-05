"""The card writer reads the board as the prototype's did (QOR-4722): the cards already on
it go into the prompt, a later window can give an open to-do its owner when the room says
who takes it, and a new card can answer a question or supersede a decision. Each window
comes with the lines just before it, to read but never to cite.
"""

import json
import re

import httpx

from tests.acceptance.test_commitment_becomes_card import commitment, line, model_replying, window
from writer.model import ModelClient
from writer.window import build_parts, read_window


def prompted(cards):
    """A model that replies with `cards` and keeps the prompt it was sent."""
    seen = []

    def handle(request):
        seen.append(json.loads(request.content)["messages"][1]["content"])
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(cards)}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 1, "completion_tokens": 1}})

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="https://models.example.com/v1")
    return ModelClient(http=http, model="test-model", api_key="k-test"), seen


def first_card(db, meeting, owner="Legal team"):
    read_window(db.url("cards"), meeting["id"], window(meeting), model_replying([commitment(meeting, owner=owner)]))
    with db.connect("cards") as conn:
        return conn.execute(
            "SELECT id, display_id FROM cards.cards WHERE meeting_id = %s ORDER BY created_at", [meeting["id"]]
        ).fetchone()


def card(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute(
            "SELECT owner_member_id, owner_name, detail_html, version FROM cards.cards WHERE id = %s", [card_id]
        ).fetchone()


def claim(meeting, display_id, said="I'll take the license draft myself.", quote="I'll take the license draft",
          speaker="marco", owner=None, version=1):
    lines = [line(20, meeting[f"{speaker}_name"], said, meeting[speaker])]
    proposal = {"op": "update", "card_id": display_id, "expected_version": version,
                "owner": owner or meeting["marco_name"],
                "evidence": [{"epoch": 0, "seq": 20, "speaker": meeting[f"{speaker}_name"], "quote": quote}]}
    return lines, proposal


def test_the_spoken_owner_is_kept_on_the_card(db, meeting):
    card_id, _ = first_card(db, meeting)
    assert card(db, card_id)[:2] == (None, "Legal team")


def test_the_cards_already_on_the_board_are_in_the_prompt(db, meeting):
    _, display_id = first_card(db, meeting)
    model, seen = prompted([])
    read_window(db.url("cards"), meeting["id"], [line(20, meeting["ada_name"], "ok", meeting["ada"])], model)
    assert f"{display_id} [do] Send the license draft to legal by Friday  -- DRAFT (version 1)" in seen[0]


def test_the_room_gives_an_open_to_do_its_owner(db, meeting):
    card_id, display_id = first_card(db, meeting)
    lines, proposal = claim(meeting, display_id)
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))

    owner, owner_name, detail, version = card(db, card_id)
    assert (owner, owner_name, version, result["updated"]) == (meeting["marco"], meeting["marco_name"], 2, 1)
    assert re.search(rf"<b>Assigned to {meeting['marco_name']}</b> by the room, \d{{4}}-\d\d-\d\dT\d\d:\d\d:\d\dZ "
                     r"\(was Legal team\)\.</p>$", detail)
    with db.connect("cards") as conn:
        actor, after = conn.execute(
            "SELECT actor_kind, after FROM cards.card_events WHERE card_id = %s AND action = 'card.owner'", [card_id]
        ).fetchone()
        quotes = [r[0] for r in conn.execute("SELECT text FROM cards.evidence WHERE card_id = %s ORDER BY seq", [card_id])]
    assert (actor, after["owner_name"]) == ("writer", meeting["marco_name"])
    assert quotes[-1] == "I'll take the license draft"


def test_an_owner_a_person_set_is_not_taken_by_the_room(db, meeting):
    card_id, display_id = first_card(db, meeting)
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET owner_member_id = %s, owner_name = NULL WHERE id = %s", [meeting["ada"], card_id])
        conn.execute("""INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, actor_member_id)
                        VALUES (%s, %s, 'card.owner', 'member', %s)""", [card_id, meeting["id"], meeting["ada"]])
    lines, proposal = claim(meeting, display_id, version=2)
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    assert card(db, card_id)[0] == meeting["ada"]
    assert result["updated"] == 0 and len(result["refused"]) == 1


def test_an_owner_nobody_named_in_the_quote_is_refused(db, meeting):
    card_id, display_id = first_card(db, meeting)
    lines, proposal = claim(meeting, display_id, said="Sounds good to me.", quote="Sounds good", speaker="ada")
    result = read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    assert card(db, card_id)[:2] == (None, "Legal team")
    assert len(result["refused"]) == 1


def test_a_later_meeting_gives_an_earlier_meetings_to_do_its_owner(db, meeting):
    card_id, display_id = first_card(db, meeting)
    with db.connect("runtime") as backend:
        later = backend.execute(
            "INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (%s, '123456789') RETURNING id",
            [f"occ-later-{meeting['id']}"],
        ).fetchone()[0]
    lines, proposal = claim(meeting, display_id)
    asked = {"bucket": "ask", "title": "Who books the room?", "detail": "<p>Open.</p>",
             "evidence": [{"epoch": 0, "seq": 20, "speaker": meeting["marco_name"], "quote": "I'll take the license draft"}]}
    result = read_window(db.url("cards"), later, lines, model_replying([proposal, asked]))

    assert card(db, card_id)[:2] == (meeting["marco"], meeting["marco_name"])
    assert (result["updated"], result["cards"]) == (1, 1)
    with db.connect("cards") as conn:
        event_meeting, cause = conn.execute(
            "SELECT meeting_id, cause FROM cards.card_events WHERE card_id = %s AND action = 'card.owner'", [card_id]
        ).fetchone()
        position = conn.execute("SELECT last_seq FROM cards.capture_positions WHERE meeting_id = %s", [later]).fetchone()
    assert (event_meeting, cause) == (meeting["id"], {"meeting_id": str(later), "lines": [{"epoch": 0, "seq": 20}]})
    assert position == (20,)


def test_a_new_card_answers_a_question_on_the_board(db, meeting):
    asked = {"bucket": "ask", "title": "Who sends the license draft?", "detail": "<p>Open.</p>",
             "evidence": [{"epoch": 0, "seq": 7, "speaker": meeting["ada_name"], "quote": "Who can take the license draft?"}]}
    read_window(db.url("cards"), meeting["id"], window(meeting), model_replying([asked]))
    with db.connect("cards") as conn:
        question_id, question = conn.execute(
            "SELECT id, display_id FROM cards.cards WHERE meeting_id = %s AND kind = 'question'", [meeting["id"]]
        ).fetchone()
    decided = {"bucket": "decided", "title": "Marco sends the license draft", "detail": "<p>Settled.</p>",
               "answers": [question], "supersedes": ["D999999"],
               "evidence": [{"epoch": 0, "seq": 20, "speaker": meeting["marco_name"], "quote": "I'll send it"}]}
    result = read_window(db.url("cards"), meeting["id"], [line(20, meeting["marco_name"], "I'll send it.", meeting["marco"])],
                         model_replying([decided]))
    with db.connect("cards") as conn:
        links = conn.execute("SELECT kind, to_card_id FROM cards.card_links WHERE meeting_id = %s", [meeting["id"]]).fetchall()
    assert links == [("answers", question_id)]
    assert result["cards"] == 1 and len(result["refused"]) == 1  # the unknown D999999


def test_a_new_card_cannot_supersede_a_to_do(db, meeting):
    todo_id, todo = first_card(db, meeting)
    decided = {"bucket": "decided", "title": "Marco sends the license draft", "detail": "<p>Settled.</p>",
               "supersedes": [todo],
               "evidence": [{"epoch": 0, "seq": 20, "speaker": meeting["marco_name"], "quote": "I'll send it"}]}
    result = read_window(db.url("cards"), meeting["id"], [line(20, meeting["marco_name"], "I'll send it.", meeting["marco"])],
                         model_replying([decided]))
    with db.connect("cards") as conn:
        links = conn.execute("SELECT 1 FROM cards.card_links WHERE to_card_id = %s", [todo_id]).fetchall()
    assert links == []
    assert result["cards"] == 1 and len(result["refused"]) == 1


EARLIER = "## Earlier in the meeting (context only: already read; never cite these lines or write a card from them alone)"
WINDOW = "## Transcript window (the new lines; cite only these)"


def test_the_prompt_shows_the_earlier_lines_before_the_window_only_when_there_are_some():
    earlier = [line(5, "Marco", "To do for me is to make sure that"), line(6, "Ada", "Go on.", source="chat")]
    new = [line(7, "Marco", "the sign in doesn't throw any errors on the Zoom app.")]

    _, volatile = build_parts(new, {}, earlier)
    assert volatile.endswith(
        f"{EARLIER}\n[Marco @e0 seq 5] To do for me is to make sure that\n[Ada [chat] @e0 seq 6] Go on.\n\n"
        f"{WINDOW}\n[Marco @e0 seq 7] the sign in doesn't throw any errors on the Zoom app."
    )
    _, volatile = build_parts(new, {})
    assert EARLIER not in volatile
    assert volatile.endswith(f"{WINDOW}\n[Marco @e0 seq 7] the sign in doesn't throw any errors on the Zoom app.")


def test_a_card_citing_an_earlier_line_is_refused_and_one_citing_the_window_lands(db, meeting):
    earlier = [line(5, meeting["marco_name"], "To do for me is to make sure that", meeting["marco"])]
    new = [line(6, meeting["marco_name"], "the sign in doesn't throw any errors on the Zoom app.", meeting["marco"])]
    cited = lambda seq, quote: {"bucket": "do", "title": f"Sign-in has no errors {seq}", "detail": "<p>Marco checks it.</p>",
                                "evidence": [{"epoch": 0, "seq": seq, "speaker": meeting["marco_name"], "quote": quote}]}
    model, seen = prompted([cited(5, "make sure that"), cited(6, "the sign in doesn't throw any errors")])

    result = read_window(db.url("cards"), meeting["id"], new, model, earlier)
    assert EARLIER in seen[0]
    assert (result["cards"], len(result["refused"])) == (1, 1)
    with db.connect("cards") as conn:
        assert conn.execute("SELECT title FROM cards.cards WHERE meeting_id = %s", [meeting["id"]]).fetchall() == [
            ("Sign-in has no errors 6",)]
        assert conn.execute("SELECT last_seq FROM cards.capture_positions WHERE meeting_id = %s", [meeting["id"]]).fetchone() == (6,)
