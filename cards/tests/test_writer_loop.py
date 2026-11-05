"""The writer loop: buffered lines past the saved position become a window, the window
becomes cards (slice C5, QOR-4658).

The buffer is a plain object holding lines per meeting, as the stored read and the feed
fill it. The model's address, model and key come from the backend's GET /v1/cards/settings
(D179); the backend and the model are fakes, the database is real.
"""

import json
import logging
import re
import threading

import httpx

from capture.buffer import Buffer
from tests.acceptance.test_commitment_becomes_card import (
    cards_in,
    commitment,
    line,
    position,
    window,
)
from writer.loop import WriterLoop

CREDENTIAL = "bwc_test"
WINDOW_HEADING = "## Transcript window (the new lines; cite only these)"
CONTEXT_HEADING = (
    "## Earlier in the meeting (context only: already read; never cite these lines or write a card from them alone)"
)


def texts(section):
    return [text.strip() for text in re.split(r"\[(?:[^\n]*? )?@e\d+ seq \d+\] ", section)[1:]]


class Fakes:
    """The backend's settings route and an OpenAI-compatible model, recording each call."""

    def __init__(self, cards, base_url="https://openrouter.ai/api/v1", api_key="k-model"):
        self.cards = cards
        self.base_url = base_url
        self.api_key = api_key
        self.settings_reads = 0
        self.not_modified = 0
        self.model_calls = []
        self.requests = []
        self.windows = []
        self.contexts = []
        self.finish = "stop"
        self.status = 200
        self.usage = {"prompt_tokens": 10, "completion_tokens": 5}
        self.model_id = "test-model"
        # Jev (QOR-4769): off unless a test turns it on; its answers in order.
        self.jev_key = None
        self.jev = {"cards_granularity": "balanced", "jev_enabled": True, "jev_model": "typesafe/jev-1.13", "jev_threshold_pct": 65, "jev_link_threshold_pct": 85, "jev_deadline_s": 60}
        self.jev_answers = []
        self.jev_calls = []
        # An admin's save moves the version; zdr_waived for a model saved past the no-ZDR warning.
        self.version = 1
        self.zdr_writer = True
        self.zdr_waived = False
        # Runs inside a model call, before it answers: another thread's settings read.
        self.during_call = None

    def settings(self):
        return {"base_url": self.base_url, "model": self.model_id, "api_key": self.api_key,
                "settings": self.jev, "settingsVersion": self.version,
                "zdr": {"writer": self.zdr_writer, "jev": self.jev_key is not None}, "zdr_waived": self.zdr_waived,
                "jev_api_key": self.jev_key}

    def backend(self, request):
        assert request.url.path == "/v1/cards/settings"
        assert request.headers["authorization"] == f"Bearer {CREDENTIAL}"
        self.settings_reads += 1
        etag = f'"{hash(json.dumps(self.settings()))}"'
        if request.headers.get("if-none-match") == etag:
            self.not_modified += 1
            return httpx.Response(304)
        return httpx.Response(200, json=self.settings(), headers={"ETag": etag})

    def model(self, request):
        if request.url.path == "/api/alpha/decisions":
            assert str(request.url) == "https://openrouter.ai/api/alpha/decisions"
            self.jev_calls.append(json.loads(request.content))
            answer = self.jev_answers.pop(0)
            return answer if isinstance(answer, httpx.Response) else httpx.Response(
                200, json={"answers": {"due": {"type": "noul", "noul": answer}}})
        assert str(request.url) == f"{self.base_url}/chat/completions"
        self.requests.append(json.loads(request.content))
        self.model_calls.append(request.headers.get("authorization"))
        before, window = json.loads(request.content)["messages"][1]["content"].split(f"{WINDOW_HEADING}\n")
        self.windows.append(texts(window))
        self.contexts.append(texts(before.split(f"{CONTEXT_HEADING}\n")[1]) if CONTEXT_HEADING in before else [])
        if self.during_call:
            self.during_call()
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"code": self.status, "message": "Insufficient credits"}})
        content = f"```json\n{json.dumps(self.cards)}\n```"
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": content}, "finish_reason": self.finish}],
                "usage": self.usage,
            },
        )


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def twenty_five_lines(meeting):
    lines = {seq: line(seq, meeting["ada_name"], f"filler {seq}", meeting["ada"]) for seq in range(25)}
    lines.update({f["seq"]: f for f in window(meeting)})
    return lines


def writer(db, meeting, fakes, lines, finished=()):
    buffer = Buffer()
    buffer.lines = {str(meeting["id"]): {(0, seq): f for seq, f in lines.items()}}
    buffer.finished = {str(meeting["id"])} if finished else set()
    backend = httpx.Client(transport=httpx.MockTransport(fakes.backend), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    clock = Clock()
    loop = WriterLoop(db.url("cards"), buffer, backend, httpx.MockTransport(fakes.model),
                      clock=clock, wall=clock)
    return loop, buffer, clock


def test_twenty_five_lines_become_one_card_and_the_position_moves_to_the_last(db, meeting):
    fakes = Fakes([commitment(meeting)])
    loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))

    loop.tick()
    assert [row[2] for row in cards_in(db, meeting["id"])] == ["Send the license draft to legal by Friday"]
    assert position(db, meeting["id"]) == 24
    assert fakes.model_calls == ["Bearer k-model"]

    loop.tick()
    assert len(fakes.model_calls) == 1


def test_a_meetings_first_lines_are_read_at_once_and_later_ones_wait_a_minute(db, meeting):
    fakes = Fakes([])
    loop, buffer, clock = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)})

    loop.tick()
    assert len(fakes.model_calls) == 1
    assert position(db, meeting["id"]) == 9

    buffer.lines[str(meeting["id"])][(0, 10)] = line(10, meeting["ada_name"], "one more", meeting["ada"])
    clock.now += 59
    loop.tick()
    assert len(fakes.model_calls) == 1

    clock.now += 1
    loop.tick()
    assert len(fakes.model_calls) == 2
    assert position(db, meeting["id"]) == 10


def test_a_finished_meeting_gets_its_last_window_at_once(db, meeting):
    fakes = Fakes([commitment(meeting)])
    loop, _, _ = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)}, finished=True)

    loop.tick()
    assert len(cards_in(db, meeting["id"])) == 1
    assert position(db, meeting["id"]) == 9


def test_a_failed_window_holds_the_position_and_waits_before_trying_again(db, meeting):
    fakes = Fakes([commitment(meeting)])
    fakes.finish = "length"
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))

    loop.tick()
    loop.tick()
    assert len(fakes.model_calls) == 1
    assert position(db, meeting["id"]) is None

    fakes.finish = "stop"
    clock.now += 60
    loop.tick()
    assert position(db, meeting["id"]) == 24


def test_no_key_from_the_backend_sends_no_authorization(db, meeting):
    fakes = Fakes([], base_url="http://model.slice.test/v1", api_key=None)
    loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))

    loop.tick()
    assert fakes.model_calls == [None]


def test_the_settings_are_read_every_thirty_seconds_and_an_unchanged_answer_is_a_304(db, meeting):
    # QOR-4769: one settings reader, polled with the last answer's ETag.
    fakes = Fakes([])
    loop, buffer, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    loop.tick()
    clock.now += 29
    buffer.lines[str(meeting["id"])][(0, 25)] = line(25, meeting["ada_name"], "more", meeting["ada"])
    loop.tick()
    assert (fakes.settings_reads, fakes.not_modified) == (1, 0)

    clock.now += 1
    loop.tick()
    assert (fakes.settings_reads, fakes.not_modified) == (2, 1)

    # A key entered in the admin panel is used from the next read on.
    fakes.api_key = "k-entered"
    clock.now += 30
    loop.tick()
    assert fakes.settings_reads == 3
    assert fakes.model_calls == ["Bearer k-model", "Bearer k-entered"]


def test_the_card_size_is_read_whether_or_not_jev_may_be_asked():
    from writer.loop import settings_of
    fakes = Fakes([])
    fakes.jev["cards_granularity"] = "fewer"
    settings = settings_of(fakes.settings())
    assert (settings.jev, settings.granularity) == (None, "fewer")


def test_a_backend_that_does_not_serve_the_card_size_yet_leaves_the_writer_balanced():
    from writer.loop import settings_of
    assert settings_of(Fakes([]).settings()).granularity == "balanced"


def written_with(db, meeting, granularity=None):
    """The rules the writer sends the model with this card size served, or none served."""
    fakes = Fakes([])
    if granularity:
        fakes.jev["cards_granularity"] = granularity
    with db.connect("owner") as conn:
        conn.execute("DELETE FROM cards.capture_positions WHERE meeting_id = %s", [meeting["id"]])
    loop, _, _ = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)})
    loop.tick()
    return fakes.requests[0]["messages"][0]["content"]


def test_each_card_size_but_balanced_adds_one_paragraph_to_the_rules_and_balanced_adds_none(db, meeting):
    from writer.window import GRANULARITY
    balanced = written_with(db, meeting, "balanced")
    assert written_with(db, meeting) == balanced
    for step in ("fewer", "more"):
        rules = written_with(db, meeting, step)
        assert rules.count(GRANULARITY[step]) == 1
        assert rules.replace(GRANULARITY[step] + "\n\n", "") == balanced
    assert "## Card size" not in balanced
    assert "fold the rest into its detail" in GRANULARITY["fewer"]
    assert "write a card for each" in GRANULARITY["more"]


def test_a_failed_settings_read_keeps_the_last_good_settings(db, meeting):
    fakes = Fakes([])
    loop, buffer, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    loop.tick()
    loop._backend = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503)),
                                 base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    buffer.lines[str(meeting["id"])][(0, 25)] = line(25, meeting["ada_name"], "more", meeting["ada"])
    clock.now += 60
    loop.tick()
    assert fakes.model_calls == ["Bearer k-model", "Bearer k-model"]
    assert position(db, meeting["id"]) == 25


def test_two_threads_reading_the_settings_at_once_both_get_them(db, meeting):
    # QOR-4769: the tick and the reconciliation thread share one settings reader; the
    # second caller waits for a first read in flight instead of getting no settings.
    fakes = Fakes([])
    loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))
    inner = loop._backend
    started, release = threading.Event(), threading.Event()

    def slow(request):
        started.set()
        release.wait(5)
        answer = inner.get(request.url.path, headers={"Authorization": request.headers["authorization"]})
        return httpx.Response(answer.status_code, headers={"etag": answer.headers.get("etag", "")},
                              content=answer.content)

    loop._backend = httpx.Client(transport=httpx.MockTransport(slow), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    got = {}
    first = threading.Thread(target=lambda: got.setdefault("first", loop._read_settings()))
    first.start()
    assert started.wait(5)
    second = threading.Thread(target=lambda: got.setdefault("second", loop._read_settings()))
    second.start()
    second.join(0.2)
    release.set()
    first.join(5)
    second.join(5)
    assert got["first"] is not None and got["second"] is not None


def test_a_call_to_openrouter_asks_for_zero_data_retention_endpoints_only(db, meeting):
    fakes = Fakes([])
    loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))
    loop.tick()
    assert fakes.requests[0]["provider"] == {"zdr": True}


def test_a_meeting_that_fails_outside_the_model_waits_and_does_not_hold_up_the_others(db, meeting):
    fakes = Fakes([])
    loop, buffer, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))
    # A meeting the database does not know: its position cannot be written.
    lost = "00000000-0000-4000-8000-000000000000"
    buffer.lines = {lost: dict(buffer.lines[str(meeting["id"])]), **buffer.lines}

    loop.tick()
    assert position(db, meeting["id"]) == 24
    assert len(fakes.model_calls) == 2
    loop.tick()
    assert len(fakes.model_calls) == 2


def test_a_long_backlog_is_read_two_hundred_lines_at_a_time(db, meeting):
    fakes = Fakes([])
    lines = {seq: line(seq, meeting["ada_name"], f"line {seq}", meeting["ada"]) for seq in range(250)}
    loop, _, _ = writer(db, meeting, fakes, lines)

    loop.tick()
    assert position(db, meeting["id"]) == 199
    loop.tick()
    assert position(db, meeting["id"]) == 249


def test_a_finished_meeting_leaves_the_buffer_once_it_is_read(db, meeting):
    fakes = Fakes([])
    loop, buffer, _ = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)}, finished=True)

    loop.tick()
    loop.tick()
    assert buffer.lines == {} and buffer.finished == set()
    assert len(fakes.model_calls) == 1


def test_each_epoch_reads_past_its_own_position(db, meeting):
    """A bot that rejoined starts a new epoch; the window holds what is unread in each."""
    fakes = Fakes([])
    lines = {(epoch, seq): line(seq, meeting["ada_name"], f"e{epoch} {seq}", meeting["ada"], epoch=epoch)
             for epoch in (0, 1) for seq in range(4)}
    loop, buffer, _ = writer(db, meeting, fakes, {})
    buffer.lines[str(meeting["id"])] = lines
    buffer.finished.add(str(meeting["id"]))
    with db.connect("cards") as conn:
        conn.execute("INSERT INTO cards.capture_positions (meeting_id, epoch, last_seq) VALUES (%s, 0, 1)", [meeting["id"]])

    loop.tick()
    with db.connect("cards") as conn:
        assert conn.execute(
            "SELECT epoch, last_seq FROM cards.capture_positions WHERE meeting_id = %s ORDER BY epoch", [meeting["id"]]
        ).fetchall() == [(0, 3), (1, 3)]
    assert fakes.windows == [["e0 2", "e0 3", "e1 0", "e1 1", "e1 2", "e1 3"]]


def test_a_settings_read_that_fails_backs_off_like_a_failed_window(db, meeting):
    fakes = Fakes([])
    original = fakes.backend
    fakes.backend = lambda request: httpx.Response(503)
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))

    loop.tick()
    loop.tick()
    assert fakes.model_calls == []

    loop._backend = httpx.Client(transport=httpx.MockTransport(original), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    clock.now += 60
    loop.tick()
    assert position(db, meeting["id"]) == 24


def test_a_finished_meeting_with_no_lines_is_forgotten(db, meeting):
    loop, buffer, _ = writer(db, meeting, Fakes([]), {})
    buffer.lines = {}
    buffer.finished = {str(meeting["id"])}
    loop.tick()
    assert buffer.finished == set()


def test_a_line_that_arrives_after_the_snapshot_keeps_the_meeting():
    buffer = Buffer()
    buffer.add("m", line(0, "Marco", "first"))
    buffer.finish("m")
    lines, _ = buffer.snapshot()
    buffer.add("m", line(1, "Marco", "the stored read's last line"))
    assert buffer.forget("m", len(lines["m"])) is False
    assert sorted(buffer.lines["m"]) == [(0, 0), (0, 1)]


def test_the_board_sees_each_meetings_last_pass_saved_or_failed(db, meeting):
    fakes = Fakes([commitment(meeting)])
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    meeting_id = str(meeting["id"])
    assert loop.activity == {}

    fakes.finish = "length"
    loop.tick()
    assert loop.activity[meeting_id]["phase"] == "failed"

    fakes.finish = "stop"
    clock.now += 60
    loop.tick()
    assert loop.activity[meeting_id]["phase"] == "complete"
    assert loop.activity[meeting_id]["expires_at"] > 0


def test_the_board_sees_a_key_out_of_credit_until_a_pass_succeeds_again(db, meeting):
    # QOR-4738: OpenRouter answers 402 when the key has run out of credit.
    fakes = Fakes([commitment(meeting)])
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    meeting_id = str(meeting["id"])

    fakes.status = 402
    loop.tick()
    assert loop.activity[meeting_id]["phase"] == "failed"
    assert loop.activity[meeting_id]["error"] == "model_out_of_credit"

    fakes.status = 200
    clock.now += 60
    loop.tick()
    assert loop.activity[meeting_id]["phase"] == "complete"
    assert "error" not in loop.activity[meeting_id]


def test_any_other_failure_names_no_error_for_the_board(db, meeting):
    fakes = Fakes([commitment(meeting)])
    fakes.status = 500
    loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))
    loop.tick()
    assert loop.activity[str(meeting["id"])]["phase"] == "failed"
    assert "error" not in loop.activity[str(meeting["id"])]
    assert loop.paused is None


def test_a_model_that_is_gone_pauses_the_writer_until_an_admin_saves_again(db, meeting):
    # A 404 is the model gone for good, not an outage: no call is paid for until
    # the settings change, and the board says why.
    fakes = Fakes([commitment(meeting)])
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    meeting_id = str(meeting["id"])

    fakes.status = 404
    loop.tick()
    assert loop.paused == {"model": "test-model", "error": "not found (404)"}
    assert loop.activity[meeting_id]["phase"] == "paused"
    assert loop.activity[meeting_id]["error"] == "model_unavailable"

    for _ in range(3):
        clock.now += 60
        loop.tick()
    assert len(fakes.model_calls) == 1
    assert loop.activity[meeting_id]["phase"] == "paused"
    assert loop.activity[meeting_id]["expires_at"] > clock.now

    fakes.status = 200
    fakes.version = 2
    clock.now += 60
    loop.tick()
    assert len(fakes.model_calls) == 2
    assert loop.paused is None
    assert loop.activity[meeting_id]["phase"] == "complete"


def test_a_404_answered_after_a_newer_settings_answer_does_not_pause(db, meeting):
    # A save read by another thread (Merge now, reconciliation) while the old model's call ran:
    # its 404 is the old model's, and must not pause the new one.
    fakes = Fakes([commitment(meeting)])
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    fakes.status = 404

    def saved_meanwhile():
        fakes.version = 2
        clock.now += 60
        loop._read_settings()
    fakes.during_call = saved_meanwhile
    loop.tick()
    assert loop.paused is None
    # An ordinary failed window on the board, not a pause.
    assert loop.activity[str(meeting["id"])]["phase"] == "failed"


def test_a_save_ends_the_pause_with_no_meeting_waiting(db, meeting):
    fakes = Fakes([commitment(meeting)])
    loop, buffer, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    fakes.status = 404
    loop.tick()
    assert loop.paused == {"model": "test-model", "error": "not found (404)"}

    buffer.lines = {}
    fakes.version = 2
    clock.now += 60
    loop.tick()
    assert loop.paused is None


def test_a_zdr_verdict_that_flips_ends_the_pause_with_no_save(db, meeting):
    # OpenRouter's 404 for a model whose ZDR endpoints dropped off: once the backend's verdict
    # follows, the answer changes and the writer tries again.
    fakes = Fakes([commitment(meeting)])
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    fakes.status = 404
    loop.tick()
    assert loop.paused is not None

    fakes.status = 200
    fakes.zdr_writer = False
    clock.now += 60
    loop.tick()
    assert len(fakes.model_calls) == 2
    assert loop.paused is None


def test_a_rate_limit_or_an_outage_never_pauses_the_writer(db, meeting):
    for status in (429, 503):
        fakes = Fakes([commitment(meeting)])
        fakes.status = status
        loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))
        loop.tick()
        assert loop.paused is None
        assert loop.activity[str(meeting["id"])]["phase"] == "failed"


def test_a_new_model_address_ends_the_pause_with_no_save(db, meeting):
    # The install's model address changed (an env change, not a save): the version stays,
    # but the writer is served another address and model, so it tries them.
    fakes = Fakes([commitment(meeting)])
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    fakes.status = 404
    loop.tick()
    assert loop.paused is not None

    fakes.status = 200
    fakes.base_url = "https://models.example.com/v1"
    clock.now += 60
    loop.tick()
    assert len(fakes.model_calls) == 2
    assert loop.paused is None


def test_a_model_saved_past_the_zdr_warning_is_called_without_zdr_routing(db, meeting):
    fakes = Fakes([])
    fakes.zdr_waived = True
    loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))
    loop.tick()
    assert "provider" not in fakes.requests[0]


def test_after_the_first_window_a_meeting_is_read_when_thirty_lines_are_waiting(db, meeting):
    fakes = Fakes([])
    loop, buffer, _ = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)})
    loop.tick()

    for seq in range(10, 39):
        buffer.lines[str(meeting["id"])][(0, seq)] = line(seq, meeting["ada_name"], f"line {seq}", meeting["ada"])
    loop.tick()
    assert len(fakes.model_calls) == 1

    buffer.lines[str(meeting["id"])][(0, 39)] = line(39, meeting["ada_name"], "line 39", meeting["ada"])
    loop.tick()
    assert len(fakes.model_calls) == 2
    assert position(db, meeting["id"]) == 39


def test_each_window_comes_with_the_sixty_lines_before_it(db, meeting):
    fakes = Fakes([])
    lines = {seq: line(seq, meeting["ada_name"], f"line {seq}", meeting["ada"]) for seq in range(100)}
    loop, _, _ = writer(db, meeting, fakes, lines, finished=True)
    with db.connect("cards") as conn:
        conn.execute("INSERT INTO cards.capture_positions (meeting_id, epoch, last_seq) VALUES (%s, 0, 69)", [meeting["id"]])

    loop.tick()
    assert fakes.contexts == [[f"line {seq}" for seq in range(10, 70)]]
    assert fakes.windows == [[f"line {seq}" for seq in range(70, 100)]]


def test_a_meetings_first_window_has_no_earlier_lines(db, meeting):
    fakes = Fakes([])
    loop, _, _ = writer(db, meeting, fakes, {f["seq"]: f for f in window(meeting)})

    loop.tick()
    assert fakes.contexts == [[]]


def test_each_window_logs_its_usage_and_the_cache_in_numbers_only(db, meeting, caplog):
    # QOR-5079: one line per writer call, so the cache's saving can be read from the log.
    fakes = Fakes([commitment(meeting)])
    fakes.usage = {"prompt_tokens": 15000, "completion_tokens": 900, "cost": 0.0321,
                   "prompt_tokens_details": {"cached_tokens": 11500, "cache_write_tokens": 0}}
    loop, _, clock = writer(db, meeting, fakes, twenty_five_lines(meeting))
    with caplog.at_level(logging.INFO, logger="cards.writer"):
        loop.tick()
    used = [r.getMessage() for r in caplog.records if r.getMessage().startswith("window usage")]
    assert used == [f"window usage meeting={meeting['id']} in=15000 out=900 cache_read=11500 cache_write=0 cost=0.0321"]

    # A failed window spent too, and says so.
    caplog.clear()
    fakes.finish = "length"
    loop._buffer.lines[str(meeting["id"])][(0, 30)] = line(30, meeting["ada_name"], "one more", meeting["ada"])
    clock.now += 60
    with caplog.at_level(logging.INFO, logger="cards.writer"):
        loop.tick()
    used = [r.getMessage() for r in caplog.records if r.getMessage().startswith("window usage")]
    assert len(used) == 1 and "in=15000" in used[0]
    assert "license" not in caplog.text and meeting["marco_name"] not in caplog.text


def test_the_writers_call_to_an_anthropic_model_on_openrouter_marks_its_rules_for_caching(db, meeting):
    fakes = Fakes([commitment(meeting)])
    fakes.model_id = "anthropic/claude-opus-5.5"
    loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))
    loop.tick()
    (system,) = fakes.requests[0]["messages"][0]["content"]
    assert system["cache_control"] == {"type": "ephemeral"} and system["text"].startswith("You keep a meeting board.")


def test_a_window_whose_write_fails_after_the_model_answered_still_logs_its_usage(db, meeting, caplog, monkeypatch):
    import psycopg

    def down(*args):
        raise psycopg.OperationalError("database went away")

    monkeypatch.setattr("writer.window.resolve_speakers", down)
    fakes = Fakes([commitment(meeting)])
    fakes.usage = {"prompt_tokens": 15000, "completion_tokens": 900}
    loop, _, _ = writer(db, meeting, fakes, twenty_five_lines(meeting))
    with caplog.at_level(logging.INFO, logger="cards.writer"):
        loop.tick()
    assert position(db, meeting["id"]) is None
    assert any(r.getMessage().startswith(f"window usage meeting={meeting['id']} in=15000 out=900")
               for r in caplog.records)
