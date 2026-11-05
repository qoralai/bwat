"""The board's card actions (QOR-4719): Done and Won't do with their Undo, edit, a question's
answer, who is editing, and the drag order. Same server and fake backend as
test_api_person; every change names the revision the person saw."""

import re
import uuid

from tests import test_api_person as person
from tests.test_api_person import as_person, events

board = person.board


def post(board, path, body):
    return board["client"].post(path, **as_person(json=body))


def card_path(board, tail=""):
    return f"/v1/cards/{board['card']}{tail}"


def question(db, board):
    with db.connect("cards") as conn:
        return str(conn.execute(
            """INSERT INTO cards.cards (meeting_id, kind, display_number, title, detail_html)
               VALUES (%s, 'question', nextval('cards.question_numbers'), 'Who owns it?', '<p>Asked.</p>') RETURNING id""",
            [board["meeting"]],
        ).fetchone()[0])


def test_undo_merge_requires_member_and_current_revision(db, board):
    from writer.reconcile import apply_merge, candidates
    with db.connect('cards') as conn, conn.transaction():
        # A draft, as the writer makes it: the clean-up merges away only a draft.
        newer = str(conn.execute("""INSERT INTO cards.cards (meeting_id, kind, display_number, title, status, live_at)
                      VALUES (%s, 'todo', nextval('cards.todo_numbers'), 'Ship with docs', 'draft', NULL) RETURNING id""",
                                 [board['meeting']]).fetchone()[0])
        apply_merge(conn, {'older': board['card'], 'newer': newer, 'context': 'Include docs'},
                    candidates(conn, board['meeting']))
    path = f'/v1/cards/{newer}/unmerge'
    assert board['client'].post(path, json={'revision': 2}).status_code == 401
    stale = post(board, path, {'revision': 1})
    assert stale.status_code == 409 and stale.json()['error'] == 'stale_revision'
    assert post(board, path, {'revision': 2}).status_code == 200
    again = post(board, path, {'revision': 2})
    assert again.status_code == 409 and again.json()['error'] == 'not_merged'


def test_done_closes_the_card_and_takes_it_off_the_board(db, board):
    done = post(board, card_path(board, "/archive"), {"revision": 1, "outcome": "done"})
    assert done.status_code == 200
    assert (done.json()["status"], done.json()["archived"], done.json()["done"]) == ("done", True, True)
    with db.connect("cards") as conn:
        change = conn.execute("SELECT before, after FROM cards.card_events WHERE card_id = %s", [board["card"]]).fetchone()
    assert change == ({"archived": False, "status": "open"}, {"archived": True, "status": "done"})


def test_wont_do_closes_it_too_and_any_other_outcome_is_refused(board):
    assert post(board, card_path(board, "/archive"), {"revision": 1, "outcome": "maybe"}).status_code == 400
    wont = post(board, card_path(board, "/archive"), {"revision": 1, "outcome": "wont_do"})
    assert (wont.json()["status"], wont.json()["done"]) == ("wont_do", False)


def test_undo_puts_a_closed_card_back_open_on_the_board(db, board):
    closed = post(board, card_path(board, "/archive"), {"revision": 1, "outcome": "done"}).json()
    assert post(board, card_path(board, "/unarchive"), {"revision": 1}).status_code == 409  # stale
    back = post(board, card_path(board, "/unarchive"), {"revision": closed["revision"]})
    assert back.status_code == 200
    assert (back.json()["status"], back.json()["archived"]) == ("open", False)
    assert [e[0] for e in events(db, board["card"])] == ["card.archive", "card.unarchive"]


def test_an_edit_sets_the_title_and_adds_an_escaped_note_with_its_author(db, board):
    edited = board["client"].patch(
        card_path(board), **as_person(json={"revision": 1, "title": "Ship it Monday", "note": "moved <b>after</b> QA"}))
    assert edited.status_code == 200
    body = edited.json()
    assert body["title"] == "Ship it Monday"
    assert body["detail_html"].startswith("<p>Ship it on Friday.</p>")
    assert "moved &lt;b&gt;after&lt;/b&gt; QA" in body["detail_html"] and "<b>Note</b> from M " in body["detail_html"]
    with db.connect("cards") as conn:
        after = conn.execute("SELECT after FROM cards.card_events WHERE card_id = %s", [board["card"]]).fetchone()[0]
    assert after == {"title": "Ship it Monday", "detail_html": "note"}  # the note's text is not repeated


def test_an_edit_with_nothing_to_save_or_an_empty_title_is_refused(board):
    for body in ({"revision": 1}, {"revision": 1, "title": "  "}, {"revision": 1, "note": "x" * 2001}):
        assert board["client"].patch(card_path(board), **as_person(json=body)).status_code == 400, body


def test_a_question_is_answered_once_per_request(db, board):
    qid = question(db, board)
    rid = str(uuid.uuid4())
    first = post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, "answer": "Ada", "todo": "she files it", "request_id": rid})
    assert first.status_code == 200
    detail = first.json()["detail_html"]
    assert "<b>Answered</b> by M " in detail and "<b>To-do:</b> A" in detail
    again = post(board, f"/v1/cards/{qid}/clarify", {"revision": first.json()["revision"], "answer": "Ada", "request_id": rid})
    assert again.json()["detail_html"] == detail and again.json()["revision"] == first.json()["revision"]


def test_saving_an_answer_closes_the_question_as_done_does(db, board):
    qid = question(db, board)
    saved = post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, "answer": "Ada"}).json()
    assert (saved["status"], saved["archived"], saved["done"]) == ("done", True, True)


def test_a_todo_with_the_answer_makes_a_live_todo_that_names_the_question(db, board):
    qid = question(db, board)
    saved = post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, "answer": "Ada", "todo": "Ada files the ticket"}).json()
    (todo,) = [c for c in person.cards(board) if c["title"] == "Ada files the ticket"]
    assert (todo["status"], todo["archived"], todo["owner_member_id"]) == ("open", False, None)
    assert saved["display_id"] in todo["detail_html"] and "Ada" in todo["detail_html"]
    assert f"<b>To-do:</b> {todo['display_id']}</p>" in saved["detail_html"]
    assert [r["id"] for r in todo["related"]] == [qid]


def test_a_retried_save_answers_closes_and_makes_its_todo_once(db, board):
    qid = question(db, board)
    body = {"answer": "Ada", "todo": "Ada files the ticket", "request_id": str(uuid.uuid4())}
    first = post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, **body}).json()
    again = post(board, f"/v1/cards/{qid}/clarify", {"revision": first["revision"], **body}).json()
    assert again == first | {"repeated": True}
    # The retry after a lost reply carries the revision the person saw, which the save moved on.
    lost = post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, **body}).json()
    assert lost == first | {"repeated": True}
    assert len([c for c in person.cards(board) if c["title"] == "Ada files the ticket"]) == 1
    assert [e[0] for e in events(db, qid)] == ["card.clarify"]


def test_a_closed_question_takes_no_answer_and_makes_no_todo(db, board):
    qid = question(db, board)
    done = post(board, f"/v1/cards/{qid}/archive", {"revision": 1, "outcome": "done"}).json()
    refused = post(board, f"/v1/cards/{qid}/clarify", {"revision": done["revision"], "answer": "Ada", "todo": "Ada files it"})
    assert (refused.status_code, refused.json()["error"]) == (409, "archived")
    assert [c["title"] for c in person.cards(board) if c["title"] == "Ada files it"] == []


def test_a_question_bwat_closed_takes_no_answer(db, board):
    # QOR-5003: the writer closed it, answered or dropped; the board offers no Answer on it.
    qid = question(db, board)
    with db.connect("cards") as conn:
        revision = conn.execute("UPDATE cards.cards SET status = 'wont_do' WHERE id = %s RETURNING version",
                                [qid]).fetchone()[0]
    refused = post(board, f"/v1/cards/{qid}/clarify", {"revision": revision, "answer": "Ada"})
    assert (refused.status_code, refused.json()["error"]) == (409, "not_open")


def test_an_answer_without_a_todo_makes_none(db, board):
    qid = question(db, board)
    saved = post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, "answer": "Ada", "todo": "  "}).json()
    assert "To-do" not in saved["detail_html"]
    assert sorted(c["id"] for c in person.cards(board)) == sorted([board["card"], qid])


def test_the_saver_who_picks_themself_owns_and_accepts_the_new_todo(db, board):
    qid = question(db, board)
    post(board, f"/v1/cards/{qid}/clarify",
         {"revision": 1, "answer": "Ada", "todo": "Ada files it", "todo_owner_member_id": board["member"]})
    (todo,) = [c for c in person.cards(board) if c["title"] == "Ada files it"]
    assert (todo["owner_member_id"], todo["owner_by"], todo["accepted"]) == (board["member"], board["member"], True)
    # The line Change owner adds, so the new to-do says who gave it to whom.
    name, _ = member_label(db, board)
    assert re.search(rf"<b>Assigned to {re.escape(name)}</b> by {re.escape(name)}, {STAMP}\.</p>$", todo["detail_html"])


def test_a_new_todos_owner_is_checked_as_set_owner_checks_it(db, board):
    qid = question(db, board)
    for owner in ("nobody", 7, str(uuid.uuid4())):
        refused = post(board, f"/v1/cards/{qid}/clarify",
                       {"revision": 1, "answer": "Ada", "todo": "Ada files it", "todo_owner_member_id": owner})
        assert (refused.status_code, refused.json()["error"]) == (400, "invalid_body"), owner
    assert [c for c in person.cards(board) if c["title"] == "Ada files it"] == []


def test_a_long_todo_is_titled_by_the_title_rule_and_kept_whole_in_its_detail(db, board):
    qid = question(db, board)
    text = "Ada files the ticket " * 6
    post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, "answer": "Ada", "todo": text})
    (todo,) = [c for c in person.cards(board) if c["kind"] == "task" and c["related"]]
    assert len(todo["title"]) <= 60 and text.startswith(todo["title"].removesuffix("…"))
    assert text.strip() in todo["detail_html"]


def test_only_a_question_takes_an_answer(board):
    refused = post(board, card_path(board, "/clarify"), {"revision": 1, "answer": "yes"})
    assert (refused.status_code, refused.json()["error"]) == (409, "not_a_question")


def test_who_is_editing_shows_until_they_stop_or_their_beat_lapses(board):
    assert post(board, "/v1/editing", {"card_id": board["card"], "on": True}).status_code == 204
    now = board["client"].get("/v1/editing", **as_person()).json()["editing"]
    assert list(now) == [board["card"]] and now[board["card"]][0].startswith("M ")
    board["clock"].now += 31
    assert board["client"].get("/v1/editing", **as_person()).json()["editing"] == {}
    post(board, "/v1/editing", {"card_id": board["card"], "on": True})
    post(board, "/v1/editing", {"card_id": board["card"], "on": False})
    assert board["client"].get("/v1/editing", **as_person()).json()["editing"] == {}


def test_a_meetings_order_is_saved_against_the_version_drawn(board):
    put = lambda body: board["client"].put("/v1/orders", **as_person(json=body))
    saved = put({"meeting_id": board["meeting"], "order": [board["card"]], "version": 0})
    assert saved.status_code == 200 and saved.json() == {"order": [board["card"]], "version": 1}
    stale = put({"meeting_id": board["meeting"], "order": [], "version": 0})
    assert stale.status_code == 409
    assert (stale.json()["stale"], stale.json()["order"], stale.json()["version"]) == (True, [board["card"]], 1)
    listed = board["client"].get("/v1/orders", **as_person()).json()
    assert listed == {"meetings": {board["meeting"]: {"order": [board["card"]], "version": 1}}, "mine": None}


def test_a_personal_order_is_the_members_own(board):
    put = lambda body: board["client"].put("/v1/orders", **as_person(json=body))
    assert put({"mine": True, "order": [board["card"]], "version": 0}).status_code == 200
    assert board["client"].get("/v1/orders", **as_person()).json()["mine"] == {"order": [board["card"]], "version": 1}
    assert put({"meeting_id": str(uuid.uuid4()), "order": [], "version": 0}).status_code == 404
    assert put({"order": [], "version": 1}).status_code == 400
    assert put({"mine": True, "order": ["not-a-card"], "version": 1}).status_code == 400


def test_the_activity_word_is_the_writers_last_pass_or_idle(board):
    get = lambda: board["client"].get(f"/v1/occurrences/{board['meeting']}/activity", **as_person()).json()
    assert get() == {"phase": "stale"}
    board["activity"][board["meeting"]] = {"phase": "complete", "expires_at": 2000.0}
    assert get() == {"phase": "complete", "expires_at": 2000.0}
    assert board["client"].get("/v1/occurrences/not-a-meeting/activity", **as_person()).status_code == 404


STAMP = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"


def member_label(db, board):
    with db.connect("cards") as conn:
        return conn.execute(
            "SELECT display_name, email FROM bwat.v_cards_members WHERE member_id = %s", [board["member"]]
        ).fetchone()


def test_a_spoken_owner_shows_until_a_person_assigns_and_the_card_says_who_did(db, board):
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET owner_name = 'Jonah' WHERE id = %s", [board["card"]])
    (card,) = person.cards(board)
    assert (card["owner_member_id"], card["owner_label"], card["owner_name"], card["owner_by"]) == (None, "Jonah", "Jonah", "agent")

    name, _ = member_label(db, board)
    put = lambda body: board["client"].put(card_path(board, "/owner"), **as_person(json=body))
    assigned = put({"owner_member_id": board["member"], "revision": card["revision"]}).json()
    assert (assigned["owner_label"], assigned["owner_name"], assigned["owner_by"]) == (name, None, board["member"])
    assert re.search(rf"<b>Assigned to {re.escape(name)}</b> by {re.escape(name)}, {STAMP} \(was Jonah\)\.</p>$",
                     assigned["detail_html"])

    cleared = put({"owner_member_id": None, "revision": assigned["revision"]}).json()
    assert (cleared["owner_label"], cleared["owner_by"]) == (None, board["member"])
    assert re.search(rf"<b>Unassigned</b> by {re.escape(name)}, {STAMP} \(was {re.escape(name)}\)\.</p>$",
                     cleared["detail_html"])


def test_a_card_nobody_owns_has_no_owner_by(board):
    (card,) = person.cards(board)
    assert (card["owner_label"], card["owner_name"], card["owner_by"]) == (None, None, None)


def test_notes_and_answers_say_when(db, board):
    note = board["client"].patch(card_path(board), **as_person(json={"revision": 1, "note": "after QA"})).json()
    assert re.search(rf"<b>Note</b> from M \w+ at {STAMP}: after QA</p>$", note["detail_html"])
    qid = question(db, board)
    answer = post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, "answer": "Ada"}).json()
    assert re.search(rf"<b>Answered</b> by M \w+ at {STAMP}: Ada</p>$", answer["detail_html"])


def test_an_answer_sent_again_says_it_was_already_saved(db, board):
    qid = question(db, board)
    rid = str(uuid.uuid4())
    first = post(board, f"/v1/cards/{qid}/clarify", {"revision": 1, "answer": "Ada", "request_id": rid}).json()
    assert "repeated" not in first
    again = post(board, f"/v1/cards/{qid}/clarify", {"revision": first["revision"], "answer": "Ada", "request_id": rid})
    assert again.json()["repeated"] is True


def test_names_follow_the_boards_rule_a_shared_name_carries_the_email(db, board):
    name, email = member_label(db, board)
    with db.connect("runtime") as backend:
        backend.execute("INSERT INTO bwat.members (email, display_name) VALUES (%s, %s)", [f"x-{email}", name])
    post(board, "/v1/editing", {"card_id": board["card"], "on": True})
    assert board["client"].get("/v1/editing", **as_person()).json()["editing"][board["card"]] == [f"{name} ({email})"]


def test_a_member_with_no_display_name_is_named_by_email(db, board):
    _, email = member_label(db, board)
    with db.connect("runtime") as backend:
        backend.execute("UPDATE bwat.members SET display_name = NULL WHERE id = %s", [board["member"]])
    note = board["client"].patch(card_path(board), **as_person(json={"revision": 1, "note": "x"})).json()
    assert f"<b>Note</b> from {email} at " in note["detail_html"]


def test_a_card_says_what_answered_or_replaced_it(db, board):
    qid = question(db, board)
    with db.connect("cards") as conn:
        answer, later = (conn.execute(
            """INSERT INTO cards.cards (meeting_id, kind, display_number, title)
               VALUES (%s, 'decision', nextval('cards.decision_numbers'), %s) RETURNING id::text, display_id""",
            [board["meeting"], title]).fetchone() for title in ("Ada owns it", "Marco owns it after all"))
        conn.execute("""INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind)
                        VALUES (%s, %s, %s, 'answers'), (%s, %s, %s, 'supersedes')""",
                     [board["meeting"], answer[0], qid, board["meeting"], later[0], answer[0]])
    by_id = {c["id"]: c for c in person.cards(board)}
    assert by_id[qid]["answered_by"] == [{"id": answer[0], "display_id": answer[1]}]
    assert by_id[answer[0]]["superseded_by"] == {"id": later[0], "display_id": later[1]}
    assert (by_id[later[0]]["superseded_by"], by_id[later[0]]["answered_by"]) == (None, [])
