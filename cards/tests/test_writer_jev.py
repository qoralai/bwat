"""Jev paces the writer (QOR-4769): while Jev is available for a meeting, its window is read
when Jev scores the new lines at the threshold, when the oldest unread line has waited the
deadline, when more than 200 lines wait, on the first window and at the end; any Jev
failure puts the meeting on the cadence for 30 s.

The backend, the model and Jev are fakes (Fakes in test_writer_loop), the database is real.
"""

import json
from datetime import UTC, datetime

import httpx
import pytest

from tests.acceptance.test_commitment_becomes_card import commitment, line, position, window
from tests.test_writer_loop import Fakes, writer
from writer import jev as jev_state
from writer.reconcile import bounded

LOST = "00000000-0000-4000-8000-000000000000"


def jev_writer(db, meeting, deadline=120, cards=()):
    """A writer with Jev on, past the meeting's first window (seq 7 to 9)."""
    fakes = Fakes(list(cards))
    fakes.jev_key = "k-jev"
    fakes.jev["jev_deadline_s"] = deadline
    loop, buffer, clock = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)})
    loop.tick()
    assert (len(fakes.model_calls), fakes.jev_calls) == (1, [])
    fakes.cards = []
    return fakes, loop, buffer, clock


def say(buffer, meeting, *seqs, **fields):
    for seq in seqs:
        buffer.lines[str(meeting["id"])][(0, seq)] = line(seq, meeting["ada_name"], f"line {seq}", meeting["ada"]) | fields


def iso(seconds):
    return datetime.fromtimestamp(seconds, UTC).isoformat()


def test_a_window_waits_below_the_threshold_and_is_read_at_it(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    say(buffer, meeting, 10)
    fakes.jev_answers = [0.64]
    clock.now += 5
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (1, 1)
    assert loop.activity[str(meeting["id"])]["jev"] == "waiting"

    # The cadence would read it at 60 s; Jev is not asked again without new lines.
    clock.now += 56
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (1, 1)

    say(buffer, meeting, 11)
    fakes.jev_answers = [0.65]
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (2, 2)
    assert fakes.windows[-1] == ["line 10", "line 11"]
    assert position(db, meeting["id"]) == 11


def test_jev_is_asked_with_the_new_lines_the_lines_before_and_the_board(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting, cards=[commitment(meeting)])
    say(buffer, meeting, 10)
    fakes.jev_answers = [0.1]
    clock.now += 5
    loop.tick()
    asked = fakes.jev_calls[0]
    assert asked["model"] == "typesafe/jev-1.13"
    assert asked["questions"] == {"due": {"type": "noul", "instructions": jev_state.STATEMENT}}
    assert "line 10" in asked["state"]["new_lines"] and "license draft" not in asked["state"]["new_lines"]
    assert "I'll send the license draft to legal by Friday." in asked["state"]["earlier_lines"]
    card = asked["state"]["board"][0]  # newest first; the shared test database holds other cards
    assert card["title"] == "Send the license draft to legal by Friday"
    assert "Marco takes the license draft to legal." in card["content"]


def test_jev_is_asked_at_most_every_five_seconds_and_only_after_new_lines(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    fakes.jev_answers = [0.1, 0.1, 0.1]
    say(buffer, meeting, 10)
    clock.now += 5
    loop.tick()
    say(buffer, meeting, 11)
    clock.now += 4
    loop.tick()
    assert len(fakes.jev_calls) == 1
    clock.now += 1
    loop.tick()
    loop.tick()
    assert len(fakes.jev_calls) == 2


def test_no_two_reads_of_a_meeting_are_less_than_five_seconds_apart(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    fakes.jev_answers = [0.9]
    say(buffer, meeting, 10)
    clock.now += 4
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (1, 0)
    clock.now += 1
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (2, 1)


def test_a_line_that_has_waited_the_deadline_by_its_created_at_is_read_without_jev(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting, deadline=120)
    say(buffer, meeting, 10, created_at=iso(clock.now - 120))
    clock.now += 5
    loop.tick()
    assert (len(fakes.model_calls), fakes.jev_calls) == (2, [])


def test_a_line_with_no_created_at_waits_the_deadline_from_its_arrival(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting, deadline=120)
    fakes.jev_answers = [0.1]
    say(buffer, meeting, 10)
    clock.now += 5
    loop.tick()
    clock.now += 119  # line 10 arrived at the tick 5 s after the first window
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (1, 1)
    say(buffer, meeting, 11)
    clock.now += 1
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (2, 1)


def test_more_than_two_hundred_waiting_lines_are_read_without_jev(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    say(buffer, meeting, *range(10, 211))
    clock.now += 5
    loop.tick()
    assert (len(fakes.model_calls), fakes.jev_calls) == (2, [])
    assert len(fakes.windows[-1]) == 200


def test_a_finished_meeting_is_read_without_jev(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    say(buffer, meeting, 10)
    buffer.finished.add(str(meeting["id"]))
    clock.now += 5
    loop.tick()
    assert (len(fakes.model_calls), fakes.jev_calls) == (2, [])


def test_a_failed_windows_minute_wins_over_jev(db, meeting):
    fakes = Fakes([])
    fakes.jev_key = "k-jev"
    fakes.finish = "length"
    loop, buffer, clock = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)})
    loop.tick()
    fakes.finish = "stop"
    fakes.jev_answers = [0.9]
    say(buffer, meeting, 10)
    clock.now += 59
    loop.tick()
    assert (len(fakes.model_calls), fakes.jev_calls) == (1, [])
    clock.now += 1
    loop.tick()
    assert (len(fakes.model_calls), fakes.jev_calls) == (2, [])


def slow(request):
    raise httpx.ReadTimeout("slow", request=request)


@pytest.mark.parametrize("failure", [
    httpx.Response(400, json={"error": {"message": "bad state"}}),
    httpx.Response(200, json={"answers": {"due": {"noul": 1.5}}}),
    "timeout",
])
def test_a_jev_failure_puts_the_meeting_on_the_cadence_for_thirty_seconds(db, meeting, failure):
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    if failure == "timeout":
        model = fakes.model
        loop._model_transport = httpx.MockTransport(
            lambda r: slow(r) if r.url.path == "/api/alpha/decisions" else model(r))
        fakes.jev_answers = []
    else:
        fakes.jev_answers = [failure]
    say(buffer, meeting, 10)
    clock.now += 5
    loop.tick()
    assert len(fakes.model_calls) == 1
    assert loop.activity[str(meeting["id"])]["jev"] == "unavailable"

    # On the cadence: no Jev, and 30 waiting lines are read at once.
    say(buffer, meeting, *range(11, 40))
    clock.now += 1
    loop.tick()
    assert len(fakes.model_calls) == 2
    asked = len(fakes.jev_calls)

    loop._model_transport = httpx.MockTransport(fakes.model)
    fakes.jev_answers = [0.1]
    say(buffer, meeting, 40)
    clock.now += 28
    loop.tick()
    assert len(fakes.jev_calls) == asked
    clock.now += 1
    loop.tick()
    assert len(fakes.jev_calls) == asked + 1


def test_lines_jev_failed_on_are_scored_again_when_the_hold_ends(db, meeting):
    # QOR-4769: a failed call is not an answer, so the same lines go to Jev after the hold.
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    say(buffer, meeting, 10)
    fakes.jev_answers = [httpx.Response(400, json={"error": {"message": "bad state"}})]
    clock.now += 5
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (1, 1)

    fakes.jev_answers = [0.9]
    clock.now += 30
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (2, 2)


@pytest.mark.parametrize("off", ["disabled", "no_key", "not_zdr"])
def test_without_jev_the_meeting_is_read_on_the_cadence(db, meeting, off):
    fakes = Fakes([])
    fakes.jev_key = "k-jev"
    if off == "disabled":
        fakes.jev["jev_enabled"] = False
    elif off == "no_key":
        fakes.jev_key = None
    original = fakes.settings
    if off == "not_zdr":
        fakes.settings = lambda: original() | {"zdr": {"writer": True, "jev": False}}
    loop, buffer, clock = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)})
    loop.tick()
    say(buffer, meeting, *range(10, 40))
    clock.now += 5
    loop.tick()
    assert (len(fakes.model_calls), fakes.jev_calls) == (2, [])


def test_the_board_is_built_once_a_tick_for_every_meeting_and_again_only_when_a_card_changes(
        db, meeting, monkeypatch):
    import writer.loop

    built = []
    digest = writer.loop.board_digest
    monkeypatch.setattr(writer.loop, "board_digest", lambda conn: built.append(1) or digest(conn))
    fakes, loop, buffer, clock = jev_writer(db, meeting, cards=[commitment(meeting)])
    # A second meeting, already read once: it has no row, and needs none to ask Jev.
    buffer.lines[LOST] = {}
    loop._last_pass[LOST] = clock.now

    def both(seq):
        say(buffer, meeting, seq)
        buffer.lines[LOST][(0, seq)] = line(seq, "Lost", f"lost {seq}")
        fakes.jev_answers += [0.1, 0.1]
        clock.now += 5
        loop.tick()

    both(10)
    assert (len(fakes.jev_calls), len(built)) == (2, 1)
    both(11)
    assert (len(fakes.jev_calls), len(built)) == (4, 1)
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET title = 'Send the draft' WHERE meeting_id = %s", [meeting["id"]])
    both(12)
    assert (len(fakes.jev_calls), len(built)) == (6, 2)
    assert fakes.jev_calls[-1]["state"]["board"][0]["title"] == "Send the draft"


def test_a_board_over_the_cap_goes_in_as_title_lines_then_is_cut():
    cards = [{"id": f"A{i}", "kind": "do", "title": f"Task {i}", "retired": False, "content": "x" * 1500}
             for i in range(100)]
    state = jev_state.state([line(1, "Ada", "new")], [line(0, "Ada", "old")], cards)
    assert len(json.dumps(state)) <= jev_state.STATE_CAP
    board = state["board"]
    whole = sum(isinstance(card, dict) for card in board)
    assert 0 < whole < 100 and board[:whole] == cards[:whole]
    assert board[whole:] == [f"A{i} [do] Task {i}" for i in range(whole, 100)]

    many = cards * 30
    assert len(json.dumps(jev_state.state([], [], many))) <= jev_state.STATE_CAP
    assert len(jev_state.state([], [], many)["board"]) < len(many)


def test_the_bounded_serializer_keeps_items_in_order_while_they_fit():
    items = [{"n": i} for i in range(5)]  # 8 characters each
    assert bounded(items, 24) == items[:3]
    assert bounded(items, 23) == items[:2]
    assert bounded([{"n": 1, "pad": "x" * 30}, {"n": 2}], 20, lambda item: item["n"]) == [1, {"n": 2}]


def test_earlier_lines_over_the_cap_lose_their_oldest_first_and_the_new_lines_stay_whole():
    # QOR-4769: the whole state fits the cap, the transcript part included.
    new = [line(100 + i, "Ada", f"new {i} " + "n" * 5000) for i in range(3)]
    earlier = [line(i, "Marco", f"earlier {i} " + "e" * 5000) for i in range(60)]
    state = jev_state.state(new, earlier, [])
    assert len(json.dumps(state)) <= jev_state.STATE_CAP
    assert all(f"new {i} " in state["new_lines"] for i in range(3))
    assert "earlier 59 " in state["earlier_lines"] and "earlier 0 " not in state["earlier_lines"]


def test_new_lines_over_the_cap_keep_the_newest_and_drop_every_earlier_line():
    new = [line(i, "Ada", f"new {i} " + "n" * 5000) for i in range(30)]
    cards = [{"id": "A1", "kind": "do", "title": "Task", "retired": False, "content": "c"}]
    state = jev_state.state(new, [line(0, "Marco", "earlier")], cards)
    assert len(json.dumps(state)) <= jev_state.STATE_CAP
    assert "new 29 " in state["new_lines"] and "new 0 " not in state["new_lines"]
    assert state["earlier_lines"] == ""


def taking(fakes, clock, seconds):
    """The model transport, each Jev call taking `seconds` on the loop's clock."""
    def handle(request):
        if request.url.path == "/api/alpha/decisions":
            clock.now += seconds
        return fakes.model(request)
    return httpx.MockTransport(handle)


def test_jev_is_not_asked_past_the_ticks_budget_and_the_meetings_left_are_asked_next_tick(db, meeting):
    # QOR-4769: 4 s of Jev a tick; a meeting past it is "not asked yet", not a failure.
    other = "00000000-0000-4000-8000-000000000001"
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    loop._model_transport = taking(fakes, clock, 2)
    for lost in (LOST, other):
        buffer.lines[lost] = {(0, 10): line(10, "Lost", "lost 10")}
        loop._last_pass[lost] = clock.now
    say(buffer, meeting, 10)
    fakes.jev_answers = [0.1, 0.1, 0.1]
    clock.now += 5
    loop.tick()
    assert len(fakes.jev_calls) == 2 and len(fakes.model_calls) == 1
    assert other not in loop._jev_hold and "jev" not in loop.activity.get(other, {})

    clock.now += 5
    loop.tick()
    assert len(fakes.jev_calls) == 3
    assert loop.activity[other]["jev"] == "waiting"


def test_a_jev_answer_slower_than_its_deadline_in_all_is_a_failure(db, meeting):
    fakes, loop, buffer, clock = jev_writer(db, meeting)
    loop._model_transport = taking(fakes, clock, 3.5)
    say(buffer, meeting, 10)
    fakes.jev_answers = [0.9]
    clock.now += 5
    loop.tick()
    assert (len(fakes.model_calls), len(fakes.jev_calls)) == (1, 1)
    assert loop.activity[str(meeting["id"])]["jev"] == "unavailable"


def test_the_board_for_jev_is_read_with_a_connect_timeout(db, meeting, monkeypatch):
    import psycopg

    _, loop, _, _ = jev_writer(db, meeting)
    connect, seen = psycopg.connect, []
    monkeypatch.setattr(psycopg, "connect", lambda *a, **kw: seen.append(kw) or connect(*a, **kw))
    loop._jev_board()
    assert seen == [{"connect_timeout": 5}]
