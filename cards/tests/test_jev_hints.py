"""Jev's duplicate hints (QOR-4770): a card's create or revise queues a check, Jev names the
card of the same meeting it may duplicate and the card of another kind it may relate to,
the board shows the hint, and a person dismisses that pair or acts on it (Merge now, Link
now). Jev and the model are httpx.MockTransport fakes; the database is real.
"""

import contextlib
import json
import threading
import uuid
from types import SimpleNamespace

import httpx
import psycopg
import pytest

from api.app import make_server
from tests.test_api_person import BACKEND_TOKEN, CREDENTIAL, TOKEN, Clock, FakeBackend
from writer import hints
from writer.model import JevClient
from writer.reconcile import SUMMARY_PROMPT, apply_merge, apply_related, candidates


def card(db, meeting_id, title, kind="todo", action="card.create"):
    with db.connect("cards") as conn:
        card_id = conn.execute(
            f"""INSERT INTO cards.cards (meeting_id, kind, display_number, title, detail_html)
                VALUES (%s, %s, nextval('cards.{kind}_numbers'), %s, '<p>About ' || %s || '</p>') RETURNING id::text""",
            [meeting_id, kind, title, title]).fetchone()[0]
        conn.execute("INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind) VALUES (%s, %s, %s, 'writer')",
                     [card_id, meeting_id, action])
    return card_id


def display(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute("SELECT display_id FROM cards.cards WHERE id = %s", [card_id]).fetchone()[0]


def event(db, card_id, action):
    with db.connect("cards") as conn:
        conn.execute("""INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind)
                        SELECT id, meeting_id, %s, 'writer' FROM cards.cards WHERE id = %s""", [action, card_id])


def link(db, meeting_id, from_card, to_card, kind):
    with db.connect("cards") as conn:
        conn.execute("INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES (%s, %s, %s, %s)",
                     [meeting_id, from_card, to_card, kind])


def go_live(db, meeting_id):
    """A bot is attending the meeting now. One open claim per meeting number: its own number."""
    with db.connect("owner") as conn:
        conn.execute("UPDATE bwat.meetings SET meeting_number = %s WHERE id = %s", [str(uuid.uuid4().int)[:10], meeting_id])
        conn.execute("""INSERT INTO bwat.claims (meeting_number, occurrence_uuid, state)
                        SELECT meeting_number, occurrence_uuid, 'attending' FROM bwat.meetings WHERE id = %s""", [meeting_id])


def queued(db, meeting_id):
    """Queues every content event, then leaves only this meeting's checks pending, so other
    tests' cards in the shared database do not take the batch."""
    with db.connect("cards") as conn:
        hints.enqueue(conn)
        conn.execute("UPDATE cards.card_checks SET state = 'done' WHERE meeting_id <> %s AND state = 'pending'", [meeting_id])


def check_row(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute("SELECT state, dup_card_id::text, dup_confidence, rel_card_id::text, rel_confidence, threshold_pct, "
                            "attempts, retry_at > now() FROM cards.card_checks WHERE card_id = %s", [card_id]).fetchone()


def titled(*titles, confidence=0.9):
    """Jev's pick for a question: the first of `titles` among its options, else none."""
    def answer(key, question):
        options = {text: option for option, text in question["criteria"].items()}
        picks = [options[title] for title in titles if title in options]
        return (picks[0], confidence) if picks else ("none", confidence)
    return answer


class FakeJev:
    """OpenRouter's Decisions API: `answer(key, question)` is the (choice, confidence) for
    each choice question; each call recorded."""

    def __init__(self, answer=None):
        self.answer = answer or titled()
        self.calls = []
        self.status = 200
        self.during = None

    def handle(self, request):
        assert str(request.url) == "https://openrouter.ai/api/alpha/decisions"
        body = json.loads(request.content)
        self.calls.append(body)
        if self.during:
            self.during()
        if self.status != 200:
            return httpx.Response(self.status)
        answers = {}
        for key, question in body["questions"].items():
            choice, confidence = self.answer(key, question)
            answers[key] = {"type": "choice", "choice": choice, "confidence": confidence,
                            "probabilities": {choice: confidence}}
        return httpx.Response(200, json={"answers": answers})

    def client(self):
        http = httpx.Client(transport=httpx.MockTransport(self.handle), base_url="https://openrouter.ai/api/v1")
        return JevClient(http, "typesafe/jev-1.13", "k-jev")


# The trigger and the check


def test_jev_names_the_same_kind_card_it_may_duplicate_and_the_other_kind_card_it_may_relate_to(db, meeting):
    older = card(db, meeting["id"], "Send the draft to legal")
    newer = card(db, meeting["id"], "Send legal the draft")
    question = card(db, meeting["id"], "Who reviews the draft?", kind="question")
    queued(db, meeting["id"])
    assert check_row(db, newer)[:2] == ("pending", None)
    jev = FakeJev(titled("Send the draft to legal", "Who reviews the draft?", "Send legal the draft"))
    assert hints.check(db.url("cards"), jev.client(), 65) == 3
    (call,) = jev.calls
    ids = {c: display(db, c) for c in (older, newer, question)}
    questions = call["questions"]
    # Each card's question lists only the cards it may name, by display id, and none.
    n = {c["id"]: i for i, c in enumerate(call["state"]["cards"])}
    assert {k: (q["type"], q["criteria"]) for k, q in questions.items() if k.endswith(f"_{n[ids[newer]]}")} == {
        f"dup_{n[ids[newer]]}": ("choice", {ids[older]: "Send the draft to legal", "none": hints.NONE["dup"]}),
        f"rel_{n[ids[newer]]}": ("choice", {ids[question]: "Who reviews the draft?", "none": hints.NONE["rel"]}),
    }
    assert ids[newer] in questions[f"dup_{n[ids[newer]]}"]["instructions"]
    assert "SAME kind" in questions[f"dup_{n[ids[newer]]}"]["instructions"]
    assert "DIFFERENT kind" in questions[f"rel_{n[ids[newer]]}"]["instructions"]
    # The only question has no other question to duplicate: that question is not asked.
    assert f"dup_{n[ids[question]]}" not in questions and f"rel_{n[ids[question]]}" in questions
    assert sorted(c["title"] for c in call["state"]["cards"]) == [
        "Send legal the draft", "Send the draft to legal", "Who reviews the draft?"]
    assert check_row(db, newer)[:6] == ("done", older, 0.9, question, 0.9, 65)
    assert check_row(db, older)[:6] == ("done", newer, 0.9, question, 0.9, 65)
    assert check_row(db, question)[:6] == ("done", None, None, older, 0.9, 65)


def test_none_names_no_card(db, meeting):
    first = card(db, meeting["id"], "Ship it")
    card(db, meeting["id"], "Write docs")
    queued(db, meeting["id"])
    hints.check(db.url("cards"), FakeJev(titled()).client(), 65)
    assert check_row(db, first)[:6] == ("done", None, None, None, None, 65)


def test_jev_may_name_only_the_open_cards_of_the_same_meeting_live_or_not(db, meeting, other_meeting):
    go_live(db, meeting["id"])
    mine = card(db, meeting["id"], "Book a venue")
    card(db, other_meeting, "Book the venue")
    card(db, meeting["id"], "Book the hall")
    gone = {
        "archived": card(db, meeting["id"], "Book a room"),
        "done": card(db, meeting["id"], "Book a space"),
        "merged": card(db, meeting["id"], "Book a place"),
        "superseded": card(db, meeting["id"], "Book a spot"),
    }
    question = card(db, meeting["id"], "Which venue?", kind="question")
    decision = card(db, meeting["id"], "The venue is the hall", kind="decision")
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET archived = true WHERE id = %s", [gone["archived"]])
        conn.execute("UPDATE cards.cards SET status = 'done' WHERE id = %s", [gone["done"]])
    link(db, meeting["id"], gone["merged"], mine, "merges")
    link(db, meeting["id"], mine, gone["superseded"], "supersedes")
    link(db, meeting["id"], decision, question, "answers")
    queued(db, meeting["id"])
    jev = FakeJev()
    hints.check(db.url("cards"), jev.client(), 65)
    (call,) = jev.calls
    n = next(i for i, c in enumerate(call["state"]["cards"]) if c["title"] == "Book a venue")
    assert sorted(call["questions"][f"dup_{n}"]["criteria"].values()) == ["Book the hall", hints.NONE["dup"]]
    assert sorted(call["questions"][f"rel_{n}"]["criteria"].values()) == [hints.NONE["rel"], "The venue is the hall"]
    assert {c["title"] for c in call["state"]["cards"]} == {"Book a venue", "Book the hall", "The venue is the hall"}


def test_jev_is_never_offered_a_card_already_dismissed_with_it_for_that_kind(db, meeting):
    mine = card(db, meeting["id"], "Book a venue")
    hall = card(db, meeting["id"], "Book the hall")
    room = card(db, meeting["id"], "Book a room")
    question = card(db, meeting["id"], "Which venue?", kind="question")
    link(db, meeting["id"], hall, mine, "not_duplicate")
    link(db, meeting["id"], mine, question, "not_related")
    link(db, meeting["id"], mine, room, "not_related")
    queued(db, meeting["id"])
    jev = FakeJev()
    hints.check(db.url("cards"), jev.client(), 65)
    (call,) = jev.calls
    n = {c["title"]: i for i, c in enumerate(call["state"]["cards"])}

    def offered(key, title):
        return sorted(t for o, t in call["questions"].get(f"{key}_{n[title]}", {"criteria": {}})["criteria"].items()
                      if o != "none")

    # Each dismissal hides that pair from both cards, for its own kind alone.
    assert offered("dup", "Book a venue") == ["Book a room"]
    assert offered("dup", "Book the hall") == ["Book a room"]
    assert offered("dup", "Book a room") == ["Book a venue", "Book the hall"]
    assert offered("rel", "Book a venue") == []
    assert offered("rel", "Which venue?") == ["Book a room", "Book the hall"]


def test_jev_is_never_offered_a_card_already_related_to_it_as_related(db, meeting):
    mine = card(db, meeting["id"], "Book a venue")
    hall = card(db, meeting["id"], "Book the hall")
    question = card(db, meeting["id"], "Which venue?", kind="question")
    card(db, meeting["id"], "The venue may be full", kind="risk")
    link(db, meeting["id"], question, mine, "related")
    link(db, meeting["id"], mine, hall, "related")
    queued(db, meeting["id"])
    jev = FakeJev()
    hints.check(db.url("cards"), jev.client(), 65)
    (call,) = jev.calls
    n = next(i for i, c in enumerate(call["state"]["cards"]) if c["title"] == "Book a venue")
    # The board hides a related hint the pair's link already shows; a duplicate stays offered.
    assert sorted(call["questions"][f"rel_{n}"]["criteria"].values()) == [hints.NONE["rel"], "The venue may be full"]
    assert sorted(call["questions"][f"dup_{n}"]["criteria"].values()) == ["Book the hall", hints.NONE["dup"]]


@pytest.fixture
def other_meeting(db):
    with db.connect("runtime") as conn:
        return conn.execute("INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (%s, '987654321') RETURNING id::text",
                            [f"occ-other-{uuid.uuid4().hex[:8]}"]).fetchone()[0]


def test_a_card_alone_in_its_meeting_is_checked_without_asking_jev(db, meeting):
    alone = card(db, meeting["id"], "Ship it")
    queued(db, meeting["id"])
    jev = FakeJev()
    assert hints.check(db.url("cards"), jev.client(), 65) == 1
    assert jev.calls == [] and check_row(db, alone)[:2] == ("done", None)


def test_a_newer_revision_replaces_the_check_and_clears_its_hint(db, meeting):
    first = card(db, meeting["id"], "Ship it")
    second = card(db, meeting["id"], "Ship it soon")
    queued(db, meeting["id"])
    hints.check(db.url("cards"), FakeJev(titled("Ship it soon")).client(), 65)
    assert check_row(db, first)[:2] == ("done", second)
    event(db, first, "card.edit")
    queued(db, meeting["id"])
    assert check_row(db, first)[:6] == ("pending", None, None, None, None, None)
    # Queued again with no new event: the check stays as it is.
    hints.check(db.url("cards"), FakeJev(titled("Ship it soon", confidence=0.2)).client(), 65)
    queued(db, meeting["id"])
    assert check_row(db, first)[:3] == ("done", second, 0.2)


def explained_enqueue(db):
    """enqueue()'s plan, run for real (EXPLAIN ANALYZE), and each node of it."""
    plans = []

    class Explained:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, params=None):
            assert sql.lstrip().startswith("INSERT INTO cards.card_checks")
            plans.append(self.conn.execute("EXPLAIN (ANALYZE, FORMAT JSON) " + sql, params).fetchone()[0][0])

    with db.connect("cards") as conn:
        hints.enqueue(Explained(conn))

    def nodes(node):
        yield node
        for child in node.get("Plans", []):
            yield from nodes(child)
    return list(nodes(plans[0]["Plan"]))


def test_queueing_reads_each_cards_newest_event_by_its_index_not_the_windows_events(db, meeting):
    """enqueue() runs every 2 s: it looks up each open card's newest content event through
    card_events (card_id, at), and never reads every event of the window (QOR-4770)."""
    ids = [card(db, meeting["id"], f"History {n}") for n in range(20)]
    with db.connect("owner") as conn:
        conn.execute("""INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, at)
                        SELECT c.id, c.meeting_id, 'card.edit', 'writer', now() - n * interval '1 minute'
                          FROM cards.cards c CROSS JOIN generate_series(1, 2500) n WHERE c.id = ANY(%s::uuid[])""", [ids])
        for table in ("cards", "card_events", "card_checks"):
            conn.execute(f"ANALYZE cards.{table}")
    events = [n for n in explained_enqueue(db) if n.get("Relation Name") == "card_events"]
    read = sum((n["Actual Rows"] + n.get("Rows Removed by Filter", 0)) * n["Actual Loops"] for n in events)
    print([(n["Node Type"], n.get("Index Name"), n["Actual Rows"], n["Actual Loops"]) for n in events], read)
    assert events and all(n["Node Type"] != "Seq Scan" for n in events)
    assert read < 10000
    # Each card's check is for its newest content event, its card.create.
    with db.connect("cards") as conn:
        assert conn.execute("""SELECT count(*) FROM cards.card_checks k JOIN cards.card_events e ON e.id = k.event_id
                               WHERE k.card_id = ANY(%s::uuid[]) AND e.action = 'card.create'""", [ids]).fetchone()[0] == 20


def test_queueing_reads_only_the_cards_of_recent_meetings_not_the_backlog(db, meeting):
    """enqueue() runs every 2 s: its cards are those of meetings started within RECENT_HOURS,
    found by the meetings' and cards' indexes, so the open cards of old meetings are never
    read, however many there are (QOR-4770). Cards of a recent meeting are queued as before."""
    recent = card(db, meeting["id"], "Ship it")
    with db.connect("owner") as conn:
        # The backlog: every other meeting so far, and many more open cards in old meetings.
        conn.execute("UPDATE bwat.meetings SET started_at = started_at - interval '30 days' WHERE id <> %s", [meeting["id"]])
        old = [row[0] for row in conn.execute(
            """INSERT INTO bwat.meetings (occurrence_uuid, meeting_number, started_at, ended_at)
               SELECT 'occ-old-' || gen_random_uuid(), '123456789', now() - interval '30 days', now() - interval '30 days'
                 FROM generate_series(1, 100) RETURNING id""").fetchall()]
        conn.execute("""INSERT INTO cards.cards (meeting_id, kind, display_number, title, detail_html, created_at)
                        SELECT m, 'todo', nextval('cards.todo_numbers'), 'Old ' || n, '<p>Old</p>', now() - interval '30 days'
                          FROM unnest(%s::uuid[]) m CROSS JOIN generate_series(1, 40) n""", [old])
        # A content event within the window on each old card: only the meeting's age keeps it out.
        conn.execute("""INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind)
                        SELECT id, meeting_id, 'card.edit', 'writer' FROM cards.cards WHERE meeting_id = ANY(%s::uuid[])""", [old])
        for table in ("bwat.meetings", "cards.cards", "cards.card_events", "cards.card_checks"):
            conn.execute(f"ANALYZE {table}")
        shown = conn.execute("""SELECT count(*) FROM cards.cards c JOIN bwat.meetings m ON m.id = c.meeting_id
                                WHERE m.started_at >= now() - interval '1 hour' * %s""", [hints.RECENT_HOURS]).fetchone()[0]
    plan = explained_enqueue(db)
    cards = [n for n in plan if n.get("Relation Name") == "cards"]
    read = sum((n["Actual Rows"] + n.get("Rows Removed by Filter", 0)) * n["Actual Loops"] for n in cards)
    print([(n["Node Type"], n.get("Index Name"), n["Actual Rows"], n["Actual Loops"]) for n in cards], read, shown)
    assert cards and all(n["Node Type"] != "Seq Scan" for n in cards)
    assert read <= shown
    with db.connect("cards") as conn:
        assert conn.execute("SELECT count(*) FROM cards.card_checks WHERE meeting_id = ANY(%s::uuid[])", [old]).fetchone()[0] == 0
    assert check_row(db, recent)[0] == "pending"


def test_an_answer_for_a_superseded_check_is_dropped(db, meeting):
    first = card(db, meeting["id"], "Ship it")
    card(db, meeting["id"], "Ship it soon")
    queued(db, meeting["id"])
    jev = FakeJev(titled("Ship it soon"))
    jev.during = lambda: (event(db, first, "card.revise"), queued(db, meeting["id"]))
    hints.check(db.url("cards"), jev.client(), 65)
    assert check_row(db, first)[:2] == ("pending", None)


def test_a_jev_failure_leaves_the_check_pending_with_back_off_then_fails_it(db, meeting):
    first = card(db, meeting["id"], "Ship it")
    card(db, meeting["id"], "Ship it soon")
    queued(db, meeting["id"])
    jev = FakeJev()
    jev.status = 503
    assert hints.check(db.url("cards"), jev.client(), 65) == 0
    assert check_row(db, first)[0::6] == ("pending", 1)
    assert check_row(db, first)[7] is True
    # Not due until the back-off ends.
    hints.check(db.url("cards"), jev.client(), 65)
    assert len(jev.calls) == 1
    for _ in range(4):
        with db.connect("cards") as conn:
            conn.execute("UPDATE cards.card_checks SET retry_at = now() WHERE card_id = %s", [first])
        hints.check(db.url("cards"), jev.client(), 65)
    assert check_row(db, first)[0::6] == ("failed", 5)


def test_a_claimed_check_resumes_after_a_restart_once_its_lease_ends(db, meeting):
    first = card(db, meeting["id"], "Ship it")
    second = card(db, meeting["id"], "Ship it soon")
    queued(db, meeting["id"])

    def crash():
        raise SystemExit("the process dies mid-call")

    jev = FakeJev()
    jev.during = crash
    with pytest.raises(SystemExit):
        hints.check(db.url("cards"), jev.client(), 65)
    assert check_row(db, first)[0::6] == ("pending", 1)
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.card_checks SET retry_at = now() WHERE card_id = ANY(%s::uuid[])", [[first, second]])
    assert hints.check(db.url("cards"), FakeJev(titled("Ship it soon", confidence=0.3)).client(), 65) == 2
    assert check_row(db, first)[:3] == ("done", second, 0.3)


def test_a_card_off_the_board_is_checked_without_asking_jev(db, meeting):
    gone = card(db, meeting["id"], "Ship it")
    queued(db, meeting["id"])
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET archived = true WHERE id = %s", [gone])
    jev = FakeJev()
    hints.check(db.url("cards"), jev.client(), 65)
    assert jev.calls == [] and check_row(db, gone)[:2] == ("done", None)


def test_without_jev_the_writer_checks_nothing(db, meeting):
    from writer.loop import WriterLoop
    card(db, meeting["id"], "Ship it")
    loop = WriterLoop(db.url("cards"), None, None)
    loop._read_settings = lambda: SimpleNamespace(base_url="http://model.test", jev=None)
    loop._hint_checks()
    with db.connect("cards") as conn:
        assert conn.execute("SELECT count(*) FROM cards.card_checks WHERE meeting_id = %s", [meeting["id"]]).fetchone()[0] == 0


def test_with_jev_the_writer_queues_and_checks_at_the_link_threshold_not_the_writers(db, meeting):
    from tests.test_writer_loop import CREDENTIAL as WRITER_CREDENTIAL
    from tests.test_writer_loop import Fakes
    from writer.loop import WriterLoop
    first = card(db, meeting["id"], "Ship it")
    second = card(db, meeting["id"], "Ship it soon")
    fakes = Fakes([])
    fakes.jev_key = "k-jev"
    jev = FakeJev(titled("Ship it soon", confidence=0.8))
    backend = httpx.Client(transport=httpx.MockTransport(fakes.backend), base_url="http://backend.test",
                            headers={"Authorization": f"Bearer {WRITER_CREDENTIAL}"})
    loop = WriterLoop(db.url("cards"), None, backend, httpx.MockTransport(jev.handle))
    queued(db, meeting["id"])
    loop._hint_checks()
    assert jev.calls[0]["model"] == "typesafe/jev-1.13"
    assert check_row(db, first)[:3] + check_row(db, first)[5:6] == ("done", second, 0.8, 85)



# Dismissal in the clean-up


def test_the_clean_up_never_merges_or_links_a_dismissed_pair_from_either_side(db, meeting):
    older = card(db, meeting["id"], "Ship it")
    newer = card(db, meeting["id"], "Ship it soon")
    risk = card(db, meeting["id"], "Shipping may slip", kind="risk")
    link(db, meeting["id"], newer, older, "not_duplicate")
    link(db, meeting["id"], older, risk, "not_related")
    with db.connect("cards") as conn:
        board = candidates(conn, meeting["id"])
    with db.connect("cards") as conn, conn.transaction(), pytest.raises(ValueError, match="dismissed"):
        apply_merge(conn, {"older": older, "newer": newer, "context": "Same"}, board)
    with db.connect("cards") as conn, conn.transaction(), pytest.raises(ValueError, match="dismissed"):
        apply_related(conn, {"older": older, "newer": risk}, board)


def test_a_dismissal_with_another_card_does_not_stop_a_merge_or_a_link(db, meeting):
    older = card(db, meeting["id"], "Ship it")
    newer = card(db, meeting["id"], "Ship it soon")
    other = card(db, meeting["id"], "Ship it later")
    risk = card(db, meeting["id"], "Shipping may slip", kind="risk")
    link(db, meeting["id"], newer, other, "not_duplicate")
    link(db, meeting["id"], risk, newer, "not_related")
    with db.connect("cards") as conn:
        # A draft, as the writer makes it: the clean-up merges away only a draft.
        conn.execute("UPDATE cards.cards SET status = 'draft', live_at = NULL WHERE id = %s", [newer])
        board = candidates(conn, meeting["id"])
    with db.connect("cards") as conn, conn.transaction():
        apply_merge(conn, {"older": older, "newer": newer, "context": "Same"}, board)
        apply_related(conn, {"older": other, "newer": risk}, board)


# The board, and Merge now, Link now


class Settings:
    def __init__(self):
        self.api_key = "k-model"

    def __call__(self):
        return SimpleNamespace(base_url="https://openrouter.ai/api/v1", model="test-model", api_key=self.api_key, zdr=True, jev=None)


class FakeModel:
    """The writer's model behind chat/completions: a merge summary; each request recorded."""

    def __init__(self):
        self.requests = []
        self.during = None

    def handle(self, request):
        self.requests.append(request)
        if self.during:
            self.during()
        content = json.dumps({"context": "The same work."})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}, "finish_reason": "stop"}]})


@pytest.fixture
def hinted(db, meeting):
    with serving_hinted(db, meeting) as h:
        yield h


@contextlib.contextmanager
def serving_hinted(db, meeting, **options):
    """The card API with the writer's settings and model, over two near-duplicate cards and a
    question, in a live meeting."""
    go_live(db, meeting["id"])
    older = card(db, meeting["id"], "Ship it")
    newer = card(db, meeting["id"], "Ship it soon")
    question = card(db, meeting["id"], "Will it ship?", kind="question")
    backend = FakeBackend(str(meeting["marco"]))
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test",
                        headers={"Authorization": f"Bearer {CREDENTIAL}"})
    model, settings = FakeModel(), Settings()
    server = make_server(db.url("cards"), http, BACKEND_TOKEN, port=0, clock=Clock(), activity={},
                         settings=settings, model_transport=httpx.MockTransport(model.handle), **options)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = httpx.Client(base_url=f"http://127.0.0.1:{server.server_address[1]}", headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        yield SimpleNamespace(older=older, newer=newer, question=question, client=client, model=model, settings=settings,
                              meeting=meeting)
    finally:
        server.shutdown()
        server.server_close()


def checked(db, card_id, dup=None, rel=None):
    """The card's check, done: `dup` and `rel` are (named card, confidence)."""
    dup, rel = dup or (None, None), rel or (None, None)
    with db.connect("cards") as conn:
        hints.enqueue(conn)
        conn.execute("UPDATE cards.card_checks SET state = 'done', dup_card_id = %s, dup_confidence = %s, rel_card_id = %s, "
                     "rel_confidence = %s, threshold_pct = 65 WHERE card_id = %s", [*dup, *rel, card_id])


def board_card(h, card_id):
    cards = h.client.get(f"/v1/occurrences/{h.meeting['id']}/cards").json()
    return next(c for c in cards if c["id"] == card_id)


def named(db, card_id, title):
    return {"card_id": card_id, "display_id": display(db, card_id), "title": title}


def test_the_board_names_the_card_at_the_threshold_and_none_below_it(db, hinted):
    assert board_card(hinted, hinted.newer)["hint"] is None
    checked(db, hinted.newer, (hinted.older, 0.65), (hinted.question, 0.64))
    assert board_card(hinted, hinted.newer)["hint"] == {"duplicate": named(db, hinted.older, "Ship it"), "related": None}
    checked(db, hinted.newer, (hinted.older, 0.64), (hinted.question, 0.64))
    assert board_card(hinted, hinted.newer)["hint"] is None
    checked(db, hinted.newer, None, (hinted.question, 0.9))
    assert board_card(hinted, hinted.newer)["hint"] == {"duplicate": None, "related": named(db, hinted.question, "Will it ship?")}
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET archived = true WHERE id = %s", [hinted.newer])
    assert board_card(hinted, hinted.newer)["hint"] is None


@pytest.mark.parametrize("change", ["archived", "done", "merged", "answered"])
def test_the_board_hides_a_side_once_its_named_card_is_off_the_board(db, hinted, change):
    checked(db, hinted.newer, (hinted.older, 0.9), (hinted.question, 0.9))
    with db.connect("cards") as conn:
        if change == "archived":
            conn.execute("UPDATE cards.cards SET archived = true WHERE id = ANY(%s::uuid[])", [[hinted.older, hinted.question]])
        if change == "done":
            conn.execute("UPDATE cards.cards SET status = 'done' WHERE id = ANY(%s::uuid[])", [[hinted.older, hinted.question]])
    if change == "merged":
        link(db, hinted.meeting["id"], hinted.older, card(db, hinted.meeting["id"], "Ship"), "merges")
        link(db, hinted.meeting["id"], hinted.question, card(db, hinted.meeting["id"], "Will we ship?", kind="question"), "merges")
    if change == "answered":
        link(db, hinted.meeting["id"], card(db, hinted.meeting["id"], "We ship", kind="decision"), hinted.question, "answers")
        link(db, hinted.meeting["id"], card(db, hinted.meeting["id"], "Ship it now"), hinted.older, "supersedes")
    assert board_card(hinted, hinted.newer)["hint"] is None


def test_an_answered_or_superseded_card_shows_no_hint(db, hinted):
    checked(db, hinted.question, None, (hinted.older, 0.9))
    checked(db, hinted.older, (hinted.newer, 0.9))
    assert board_card(hinted, hinted.question)["hint"]["related"]["card_id"] == hinted.older
    decision = card(db, hinted.meeting["id"], "Ship on Friday", kind="decision")
    link(db, hinted.meeting["id"], decision, hinted.question, "answers")
    link(db, hinted.meeting["id"], card(db, hinted.meeting["id"], "Ship it Monday"), hinted.older, "supersedes")
    assert board_card(hinted, hinted.question)["hint"] is None
    assert board_card(hinted, hinted.older)["hint"] is None


def test_a_related_link_between_the_pair_hides_the_related_side(db, hinted):
    checked(db, hinted.newer, None, (hinted.question, 0.9))
    other = card(db, hinted.meeting["id"], "Shipping may slip", kind="risk")
    link(db, hinted.meeting["id"], other, hinted.newer, "related")
    assert board_card(hinted, hinted.newer)["hint"]["related"]["card_id"] == hinted.question
    link(db, hinted.meeting["id"], hinted.question, hinted.newer, "related")
    assert board_card(hinted, hinted.newer)["hint"] is None


def dismiss(h, card_id, target, kind="duplicate"):
    """The board's request: the kind, and the card it showed the hint naming."""
    return h.client.post(f"/v1/cards/{card_id}/hint/dismiss", json={"kind": kind, "target_card_id": target})


def test_not_a_duplicate_dismisses_that_pair_once_and_for_good(db, hinted):
    checked(db, hinted.newer, (hinted.older, 0.9), (hinted.question, 0.9))
    path = f"/v1/cards/{hinted.newer}/hint/dismiss"
    assert httpx.post(f"{hinted.client.base_url}{path}", json={"kind": "duplicate"}).status_code == 401
    assert hinted.client.post(path, json={"kind": "maybe", "target_card_id": hinted.older}).status_code == 400
    assert hinted.client.post(path, json={"kind": "duplicate"}).status_code == 400
    assert dismiss(hinted, str(uuid.uuid4()), hinted.older).status_code == 404
    first = dismiss(hinted, hinted.newer, hinted.older)
    assert first.status_code == 200 and first.json()["hint"] == {"duplicate": None, "related": named(db, hinted.question, "Will it ship?")}
    assert dismiss(hinted, hinted.newer, hinted.older).status_code == 200
    with db.connect("cards") as conn:
        assert conn.execute("SELECT kind, to_card_id::text FROM cards.card_links WHERE from_card_id = %s",
                            [hinted.newer]).fetchall() == [("not_duplicate", hinted.older)]
        assert conn.execute("SELECT actor_kind, actor_member_id, after FROM cards.card_events WHERE card_id = %s "
                            "AND action = 'card.dismiss'", [hinted.newer]).fetchall() == [
            ("member", hinted.meeting["marco"], {"kind": "duplicate", "card_id": hinted.older})]
    # A new revision names the same card: hidden, from either side. Another card shows.
    event(db, hinted.newer, "card.edit")
    checked(db, hinted.newer, (hinted.older, 0.9))
    checked(db, hinted.older, (hinted.newer, 0.9))
    assert board_card(hinted, hinted.newer)["hint"] is None
    assert board_card(hinted, hinted.older)["hint"] is None
    other = card(db, hinted.meeting["id"], "Ship it later")
    checked(db, hinted.newer, (other, 0.9))
    assert board_card(hinted, hinted.newer)["hint"]["duplicate"]["card_id"] == other


def test_dismiss_hides_the_related_pair_for_good(db, hinted):
    checked(db, hinted.newer, None, (hinted.question, 0.9))
    dismissed = dismiss(hinted, hinted.newer, hinted.question, "related")
    assert dismissed.status_code == 200 and dismissed.json()["hint"] is None
    with db.connect("cards") as conn:
        assert conn.execute("SELECT kind, to_card_id::text FROM cards.card_links WHERE from_card_id = %s",
                            [hinted.newer]).fetchall() == [("not_related", hinted.question)]
    checked(db, hinted.question, None, (hinted.newer, 0.9))
    assert board_card(hinted, hinted.question)["hint"] is None


def act(h, card_id, target, kind="duplicate"):
    return h.client.post(f"/v1/cards/{card_id}/hint/act", json={"kind": kind, "target_card_id": target})


def links_of(db, *card_ids):
    with db.connect("cards") as conn:
        return conn.execute("SELECT from_card_id::text, to_card_id::text, kind FROM cards.card_links "
                            "WHERE from_card_id = ANY(%s::uuid[]) ORDER BY created_at", [list(card_ids)]).fetchall()


@pytest.mark.parametrize("clicked", ["newer", "older"])
def test_merge_now_merges_the_named_pair_into_the_older_card(db, hinted, clicked):
    """Live meeting: the pair merges during it. The summary is the writer model's, with its key."""
    source, target = (hinted.newer, hinted.older) if clicked == "newer" else (hinted.older, hinted.newer)
    checked(db, source, (target, 0.9))
    done = act(hinted, source, target)
    assert done.status_code == 200
    assert (done.json()["outcome"], done.json()["message"]) == ("merged", "Merged")
    assert links_of(db, hinted.older, hinted.newer) == [(hinted.newer, hinted.older, "merges")]
    assert done.json()["card"]["id"] == source
    (request,) = hinted.model.requests
    assert request.headers["authorization"] == "Bearer k-model"
    body = json.loads(request.content)
    assert body["model"] == "test-model" and body["messages"][0]["content"] == SUMMARY_PROMPT
    assert json.loads(body["messages"][1]["content"])["title"] == "Ship it soon"
    assert "The same work." in board_card(hinted, hinted.older)["detail_html"]


def test_link_now_links_the_named_pair_without_the_model_or_its_key(db, hinted):
    hinted.settings.api_key = None
    checked(db, hinted.question, None, (hinted.older, 0.9))
    linked = act(hinted, hinted.question, hinted.older, "related")
    assert (linked.status_code, linked.json()["outcome"], linked.json()["message"]) == (200, "linked", "Linked")
    assert linked.json()["card"]["related"][0]["id"] == hinted.older and linked.json()["card"]["hint"] is None
    assert links_of(db, hinted.older, hinted.question) == [(hinted.question, hinted.older, "related")]
    assert hinted.model.requests == []


def test_merge_now_needs_the_writers_key(db, hinted):
    checked(db, hinted.newer, (hinted.older, 0.9))
    hinted.settings.api_key = None
    refused = act(hinted, hinted.newer, hinted.older)
    assert (refused.status_code, refused.json()["error"]) == (409, "model_key_missing")
    assert refused.json()["message"] and links_of(db, hinted.newer) == []


def test_acting_after_the_named_card_has_gone_says_so_and_clears_that_side(db, hinted):
    checked(db, hinted.newer, (hinted.older, 0.9), (hinted.question, 0.9))
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET archived = true WHERE id = %s", [hinted.older])
    gone = act(hinted, hinted.newer, hinted.older)
    assert gone.status_code == 200
    assert (gone.json()["outcome"], gone.json()["message"]) == ("gone", "That card is no longer on the board")
    assert check_row(db, hinted.newer)[1:5] == (None, None, hinted.question, 0.9)
    assert hinted.model.requests == [] and links_of(db, hinted.newer) == []


CHANGED = {"error": "hint_changed", "message": "The hint changed; look again"}


@pytest.mark.parametrize("change", ["another card", "no card", "below the threshold", "newer content"])
def test_acting_on_a_hint_that_changed_since_the_board_showed_it_is_refused(db, hinted, change):
    """The board sends the card its hint named; the pair is acted on only while the card's
    latest check still names that card (QOR-4770)."""
    other = card(db, hinted.meeting["id"], "Ship it later")
    checked(db, hinted.newer, (hinted.older, 0.9), (hinted.question, 0.9))
    if change == "another card":
        checked(db, hinted.newer, (other, 0.9), (other, 0.9))
    if change == "no card":
        checked(db, hinted.newer)
    if change == "below the threshold":
        checked(db, hinted.newer, (hinted.older, 0.5), (hinted.question, 0.5))
    if change == "newer content":
        event(db, hinted.newer, "card.edit")
    for kind, target in (("duplicate", hinted.older), ("related", hinted.question)):
        for verb in (act, dismiss):
            refused = verb(hinted, hinted.newer, target, kind)
            assert (refused.status_code, refused.json()) == (409, CHANGED)
    assert links_of(db, hinted.newer, hinted.older, hinted.question, other) == [] and hinted.model.requests == []
    with db.connect("cards") as conn:
        assert conn.execute("SELECT count(*) FROM cards.card_events WHERE card_id = %s AND action = 'card.dismiss'",
                            [hinted.newer]).fetchone()[0] == 0


def test_acting_needs_the_card_the_board_showed(db, hinted):
    checked(db, hinted.newer, (hinted.older, 0.9))
    for path in ("act", "dismiss"):
        for target in (None, "A3"):
            refused = hinted.client.post(f"/v1/cards/{hinted.newer}/hint/{path}", json={"kind": "duplicate", "target_card_id": target})
            assert (refused.status_code, refused.json()["error"]) == (400, "invalid_body")
    assert links_of(db, hinted.newer, hinted.older) == []


def test_merge_now_refuses_a_pair_that_may_not_merge_with_its_reason(db, hinted):
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET owner_member_id = %s WHERE id = %s", [hinted.meeting["marco"], hinted.older])
        conn.execute("UPDATE cards.cards SET owner_member_id = %s WHERE id = %s", [hinted.meeting["ada"], hinted.newer])
    checked(db, hinted.newer, (hinted.older, 0.9))
    refused = act(hinted, hinted.newer, hinted.older)
    assert (refused.status_code, refused.json()["error"]) == (409, "hint_refused")
    assert refused.json()["message"] == "Not merged: the cards have different owners"
    assert links_of(db, hinted.older, hinted.newer) == []


def test_merge_now_with_one_owner_merges_and_the_card_kept_takes_that_owner(db, hinted):
    """Only two cards owned by different people are refused."""
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET owner_member_id = %s WHERE id = %s", [hinted.meeting["ada"], hinted.newer])
    checked(db, hinted.newer, (hinted.older, 0.9))
    done = act(hinted, hinted.newer, hinted.older)
    assert (done.status_code, done.json()["outcome"]) == (200, "merged")
    assert board_card(hinted, hinted.older)["owner_member_id"] == str(hinted.meeting["ada"])


def test_merge_now_waits_for_a_running_clean_up(db, hinted):
    checked(db, hinted.newer, (hinted.older, 0.9))
    with psycopg.connect(db.url("cards"), autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", [f"reconcile:{hinted.meeting['id']}"])
        busy = act(hinted, hinted.newer, hinted.older)
    assert busy.status_code == 409
    assert busy.json() == {"error": "cleanup_running", "message": "Clean-up running, try again shortly"}
    # The summary comes before the lock, which is never held across a model call.
    assert len(hinted.model.requests) == 1 and links_of(db, hinted.older, hinted.newer) == []


def test_merge_now_on_a_connection_the_database_closed_answers_database_unavailable(db, hinted, monkeypatch):
    """The commit and unlock after the merge fail as the merge did, not with another error."""
    checked(db, hinted.question, None, (hinted.older, 0.9))

    def closed(conn, *args):
        with db.connect("cards") as other:  # as a database restart would, mid-merge
            other.execute("SELECT pg_terminate_backend(%s)", [conn.info.backend_pid])
        conn.execute("SELECT 1")

    monkeypatch.setattr(hints, "apply_related", closed)
    refused = act(hinted, hinted.question, hinted.older, "related")
    assert (refused.status_code, refused.json()) == (503, {"error": "database_unavailable"})
    assert links_of(db, hinted.older, hinted.question) == []


def test_merge_now_lets_the_clean_ups_lock_go_when_its_commit_fails(db, hinted, monkeypatch):
    """The pool keeps the connection, so a lock its commit skipped would outlive the request."""
    checked(db, hinted.question, None, (hinted.older, 0.9))

    def fails_at_commit(conn, *args):
        def commit():  # as a deferred constraint failing at commit would, on a live connection
            conn.rollback()
            raise psycopg.errors.IntegrityError("deferred constraint")
        conn.commit = commit

    monkeypatch.setattr(hints, "apply_related", fails_at_commit)
    assert act(hinted, hinted.question, hinted.older, "related").status_code == 500
    with psycopg.connect(db.url("cards"), autocommit=True) as conn:
        assert conn.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0))",
                            [f"reconcile:{hinted.meeting['id']}"]).fetchone()[0]


def edit_title(db, card_id):
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET title = title || '!' WHERE id = %s", [card_id])


def test_merge_now_holds_no_connection_while_the_model_writes_the_summary(db, meeting):
    """With a pool of one connection, a board read during the model call still gets it (QOR-4986)."""
    with serving_hinted(db, meeting, max_concurrent=1) as h:
        checked(db, h.newer, (h.older, 0.9))
        during = []
        h.model.during = lambda: during.append(h.client.get(f"/v1/occurrences/{meeting['id']}/cards").status_code)
        assert act(h, h.newer, h.older).status_code == 200
        assert during == [200]


def test_merge_now_tries_once_more_when_a_card_changes_during_the_call(db, hinted):
    checked(db, hinted.newer, (hinted.older, 0.9))
    changes = [1]
    hinted.model.during = lambda: changes and (changes.pop(), edit_title(db, hinted.older))
    done = act(hinted, hinted.newer, hinted.older)
    assert (done.status_code, done.json()["outcome"]) == (200, "merged")
    assert len(hinted.model.requests) == 2


def test_merge_now_gives_up_when_cards_keep_changing(db, hinted):
    checked(db, hinted.newer, (hinted.older, 0.9))
    hinted.model.during = lambda: edit_title(db, hinted.older)
    changed = act(hinted, hinted.newer, hinted.older)
    assert changed.status_code == 409
    assert changed.json() == {"error": "cards_changed", "message": "Cards changed, try again"}
    assert links_of(db, hinted.older, hinted.newer) == []


def test_link_now_goes_ahead_while_a_merge_now_waits_on_the_model(db, hinted):
    """The meeting's lock is never held across Merge now's model call (QOR-4770): a Link now
    in the same meeting goes ahead meanwhile, and the merge then applies, checking its cards'
    versions as before."""
    other = card(db, hinted.meeting["id"], "Ship it later")
    checked(db, hinted.newer, (hinted.older, 0.9))
    checked(db, hinted.question, None, (other, 0.9))
    gate = threading.Event()
    hinted.model.during = lambda: gate.wait(10)
    merged = []
    merging = threading.Thread(target=lambda: merged.append(act(hinted, hinted.newer, hinted.older)))
    merging.start()
    try:
        for _ in range(500):
            if hinted.model.requests:
                break
            threading.Event().wait(0.01)
        linked = act(hinted, hinted.question, other, "related")
        assert (linked.status_code, linked.json()["outcome"]) == (200, "linked")
    finally:
        gate.set()
        merging.join(15)
    assert (merged[0].status_code, merged[0].json()["outcome"]) == (200, "merged")
    assert links_of(db, hinted.newer, other) == [(other, hinted.question, "related"), (hinted.newer, hinted.older, "merges")]


def test_jev_reads_a_cards_text_as_the_brief_does_entities_decoded():
    assert hints.content({"detail_html": "<p>R&amp;D <b>ships</b>\n Friday</p>"}) == "R&D ships Friday"
