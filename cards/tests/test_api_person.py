"""The card API for people: a meeting's cards, setting an owner, archiving, /health
(slice C4a, QOR-4663).

The server runs for real on a free port against the test database; the backend that
answers POST /v1/card-service/person for the person's bearer is a fake.
"""

import json
import socket
import threading
import time
import uuid
from urllib.parse import quote

import httpx
import pytest

from api.app import People, RateLimited, make_server

# Shaped as a Google ID token: three base64url parts.
TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtIn0.c2lnbmF0dXJl"
BACKEND_TOKEN = "backend-token-0123456789abcdef"
CREDENTIAL = "bwc_" + "c" * 43


def junk(n):
    """A bearer shaped as a Google ID token that signs nobody in."""
    return f"eyJhbGciOiJSUzI1NiJ9.junk{n}.c2lnbmF0dXJl"


class FakeBackend:
    def __init__(self, member_id):
        self.member_id = member_id
        self.me_calls = 0
        self.seen = []
        self.down = False
        self.status = None
        self.valid = {TOKEN}

    def handle(self, request):
        assert (request.method, request.url.path) == ("POST", "/v1/card-service/person")
        self.me_calls += 1
        if self.down:
            return httpx.Response(503, json={"error": "unavailable"})
        if self.status == 429:
            return httpx.Response(429, json={"error": "rate_limited"}, headers={"retry-after": "17"})
        if self.status == 401:  # the card service's own credential refused
            return httpx.Response(401, json={"error": "unauthorized"})
        if request.headers.get("authorization") != f"Bearer {CREDENTIAL}":
            return httpx.Response(401, json={"error": "unauthorized"})
        body = json.loads(request.content)
        self.seen.append(body)
        if body["bearer"] not in self.valid:
            return httpx.Response(200, json={"person": None})
        return httpx.Response(200, json={"person": {"id": self.member_id, "email": "m@example.com", "display_name": "M",
                                                     "role": "member"}})


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def board(db):
    """A meeting with one card written by the card login, and a member M."""
    tag = uuid.uuid4().hex[:8]
    with db.connect("runtime") as backend:
        meeting_id = backend.execute(
            "INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (%s, '123456789') RETURNING id",
            [f"occ/{tag}=="],
        ).fetchone()[0]
        member = backend.execute(
            "INSERT INTO bwat.members (email, display_name, activated_at) VALUES (%s, %s, now()) RETURNING id",
            [f"m-{tag}@example.com", f"M {tag}"],
        ).fetchone()[0]
    with db.connect("cards") as cards:
        card_id = cards.execute(
            """INSERT INTO cards.cards (meeting_id, kind, display_number, title, detail_html)
               VALUES (%s, 'todo', nextval('cards.todo_numbers'), 'Ship it', '<p>Ship it on Friday.</p>') RETURNING id""",
            [meeting_id],
        ).fetchone()[0]
        cards.execute(
            """INSERT INTO cards.evidence (card_id, meeting_id, epoch, seq, speaker_member_id, speaker_label, text, source)
               VALUES (%s, %s, 0, 3, %s, 'Marco', 'ship it on friday', 'asr'), (%s, %s, 1, 0, NULL, 'Ada', 'and the docs', 'asr')""",
            [card_id, meeting_id, member, card_id, meeting_id],
        )
    backend = FakeBackend(str(member))
    clock = Clock()
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    activity = {}
    paused = {"now": None}
    server = make_server(db.url("cards"), http, BACKEND_TOKEN, port=0, clock=clock, activity=activity,
                         paused=lambda: paused["now"], failures_per_min=3)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = httpx.Client(base_url=f"http://127.0.0.1:{server.server_address[1]}")
    yield {"meeting": str(meeting_id), "occurrence": f"occ/{tag}==", "card": str(card_id), "member": str(member),
           "client": client, "backend": backend, "clock": clock, "activity": activity, "paused": paused}
    server.shutdown()
    server.server_close()


def as_person(**kwargs):
    return {"headers": {"Authorization": f"Bearer {TOKEN}"}, **kwargs}


def cards(board, key="meeting"):
    response = board["client"].get(f"/v1/occurrences/{quote(board[key], safe='')}/cards", **as_person())
    assert response.status_code == 200
    return response.json()


def events(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute(
            "SELECT action, actor_kind, actor_member_id::text FROM cards.card_events WHERE card_id = %s ORDER BY at", [card_id]
        ).fetchall()


def test_a_meetings_cards_come_back_with_their_quote_and_revision(board):
    (card,) = cards(board)
    assert card["id"] == board["card"]
    assert (card["kind"], card["title"], card["display_id"][0]) == ("task", "Ship it", "A")
    assert card["evidence"][0]["quote"] == "ship it on friday"
    assert card["source"] == {"epoch": 0, "segment_seq_from": 3, "segment_seq_to": 3, "quote": "ship it on friday",
                              "speaker_member_id": board["member"]}
    assert (card["owner_member_id"], card["archived"], card["revision"]) == (None, False, 1)


def test_each_quote_names_the_member_who_said_it_or_none(board):
    (card,) = cards(board)
    assert [(e["speaker"], e["speaker_member_id"]) for e in card["evidence"]] == [("Marco", board["member"]), ("Ada", None)]
    assert card["source"]["speaker_member_id"] == board["member"]



def test_an_occurrence_is_named_by_its_meeting_id_only(board):
    for other in (board["occurrence"], f"urn:uuid:{board['meeting']}", board["meeting"].replace("-", "")):
        response = board["client"].get(f"/v1/occurrences/{quote(other, safe='')}/cards", **as_person())
        assert response.status_code == 404, other


def test_setting_the_owner_needs_the_revision_the_person_saw(db, board):
    put = board["client"].put(
        f"/v1/cards/{board['card']}/owner", **as_person(json={"owner_member_id": board["member"], "revision": 1})
    )
    assert put.status_code == 200
    assert (put.json()["owner_member_id"], put.json()["revision"]) == (board["member"], 2)
    assert events(db, board["card"]) == [("card.owner", "member", board["member"])]

    stale = board["client"].put(
        f"/v1/cards/{board['card']}/owner", **as_person(json={"owner_member_id": None, "revision": 1})
    )
    assert stale.status_code == 409
    assert cards(board)[0]["owner_member_id"] == board["member"]


def test_archiving_needs_the_revision_too(db, board):
    stale = board["client"].post(f"/v1/cards/{board['card']}/archive", **as_person(json={"revision": 5}))
    assert stale.status_code == 409

    done = board["client"].post(f"/v1/cards/{board['card']}/archive", **as_person(json={"revision": 1}))
    assert done.status_code == 200 and done.json()["archived"] is True
    assert events(db, board["card"]) == [("card.archive", "member", board["member"])]
    with db.connect("cards") as conn:
        change = conn.execute("SELECT before, after FROM cards.card_events WHERE card_id = %s", [board["card"]]).fetchone()
    assert change == ({"archived": False}, {"archived": True})


def test_an_unknown_card_is_404(board):
    response = board["client"].post(f"/v1/cards/{uuid.uuid4()}/archive", **as_person(json={"revision": 1}))
    assert response.status_code == 404


def test_no_bearer_or_a_refused_one_is_401(board):
    path = f"/v1/occurrences/{board['meeting']}/cards"
    assert board["client"].get(path).status_code == 401
    assert board["client"].get(path, headers={"Authorization": f"Bearer {junk(0)}"}).status_code == 401


def test_a_refused_token_is_remembered_too(board):
    path = f"/v1/occurrences/{board['meeting']}/cards"
    for _ in range(3):
        assert board["client"].get(path, headers={"Authorization": f"Bearer {junk(0)}"}).status_code == 401
    assert board["backend"].me_calls == 1


def test_a_backend_that_cannot_answer_is_503_not_401(board):
    board["backend"].down = True
    response = board["client"].get(f"/v1/occurrences/{board['meeting']}/cards", **as_person())
    assert response.status_code == 503


@pytest.mark.parametrize("length,status", [("-1", 400), ("abc", 400), ("70000", 413)])
def test_a_bad_content_length_is_refused(board, length, status):
    port = int(str(board["client"].base_url).rsplit(":", 1)[1])
    with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
        raw.sendall(
            f"PUT /v1/cards/{board['card']}/owner HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n"
            f"Content-Length: {length}\r\n\r\n".encode()
        )
        assert raw.recv(64).split(b" ")[1] == str(status).encode()


def test_expired_people_are_forgotten():
    clock = Clock()
    http = httpx.Client(transport=httpx.MockTransport(FakeBackend("m").handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    people = People(http, clock)
    for n in range(1001):
        people.member(junk(n), f"10.0.{n // 250}.{n % 250}")
    clock.now += 61
    people.member(TOKEN, "10.1.0.1")
    assert len(people._known) == 1


def test_the_people_cache_never_holds_more_than_its_cap():
    clock = Clock()
    backend = FakeBackend("m")
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    people = People(http, clock)
    for n in range(10_050):
        people.member(junk(n), f"10.{n // 62500}.{n // 250 % 250}.{n % 250}")
    assert len(people._known) <= 10_000
    # A flood of junk bearers does not stop a real one being remembered.
    calls = backend.me_calls
    people.member(TOKEN, "10.9.0.1")
    people.member(TOKEN, "10.9.0.1")
    assert backend.me_calls == calls + 1


def test_the_backend_is_asked_once_per_token_within_a_minute(board):
    cards(board)
    board["clock"].now += 59
    cards(board)
    assert board["backend"].me_calls == 1

    board["clock"].now += 2
    cards(board)
    assert board["backend"].me_calls == 2


def test_health_answers_when_the_database_does(board):
    assert board["client"].get("/health").status_code == 200


def test_health_fails_when_the_database_does_not_answer():
    server = make_server(
        "postgresql://nobody:x@127.0.0.1:1/none", httpx.Client(base_url="http://backend.test"), BACKEND_TOKEN, port=0
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        assert httpx.get(f"http://127.0.0.1:{server.server_address[1]}/health", timeout=30).status_code == 503
    finally:
        server.shutdown()
        server.server_close()


def test_a_boolean_is_not_a_revision(board):
    response = board["client"].post(f"/v1/cards/{board['card']}/archive", **as_person(json={"revision": True}))
    assert response.status_code == 400


def test_a_change_to_the_value_already_set_writes_nothing(db, board):
    first = board["client"].post(f"/v1/cards/{board['card']}/archive", **as_person(json={"revision": 1}))
    again = board["client"].post(f"/v1/cards/{board['card']}/archive", **as_person(json={"revision": 2}))
    assert (again.status_code, again.json()["revision"]) == (200, first.json()["revision"])
    assert len(events(db, board["card"])) == 1


def test_a_database_that_cannot_be_reached_is_503(db):
    backend = FakeBackend(str(uuid.uuid4()))
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    server = make_server("postgresql://nobody@127.0.0.1:1/none?connect_timeout=2", http, BACKEND_TOKEN, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        response = httpx.get(
            f"http://127.0.0.1:{server.server_address[1]}/v1/occurrences/{uuid.uuid4()}/cards",
            headers={"Authorization": f"Bearer {TOKEN}"},
            timeout=30,
        )
        assert (response.status_code, response.json()) == (503, {"error": "database_unavailable"})
    finally:
        server.shutdown()
        server.server_close()


def test_cards_written_in_one_transaction_come_back_in_one_order(db, board):
    with db.connect("cards") as conn, conn.transaction():
        for title in ("B", "C", "D"):
            conn.execute(
                """INSERT INTO cards.cards (meeting_id, kind, display_number, title)
                   VALUES (%s, 'todo', nextval('cards.todo_numbers'), %s)""",
                [board["meeting"], title],
            )
    titles = [card["title"] for card in cards(board)]
    assert titles == ["Ship it", "B", "C", "D"]


def test_the_owner_already_set_in_another_spelling_is_a_no_op(db, board):
    first = board["client"].put(
        f"/v1/cards/{board['card']}/owner", **as_person(json={"owner_member_id": board["member"], "revision": 1})
    )
    again = board["client"].put(
        f"/v1/cards/{board['card']}/owner", **as_person(json={"owner_member_id": board["member"].upper(), "revision": 2})
    )
    assert again.json()["revision"] == first.json()["revision"] == 2
    assert len(events(db, board["card"])) == 1


def test_a_client_that_stalls_is_cut_off(board):
    port = int(str(board["client"].base_url).rsplit(":", 1)[1])
    with socket.create_connection(("127.0.0.1", port), timeout=30) as raw:
        raw.sendall(f"PUT /v1/cards/{board['card']}/owner HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n"
                    "Content-Length: 50\r\n\r\n".encode())
        started = time.monotonic()
        raw.recv(64)  # the server gives up on the missing body and closes
        assert time.monotonic() - started < 20


# QOR-4749: the person check, which junk and one flooding client can no longer use up.

def get_cards(board, token=TOKEN, forwarded=None):
    headers = {"Authorization": f"Bearer {token}"} | ({"X-Forwarded-For": forwarded} if forwarded else {})
    return board["client"].get(f"/v1/occurrences/{board['meeting']}/cards", headers=headers)


@pytest.mark.parametrize("bearer", [
    "person-token", "a.b", "a.b.c.d", "a..c", "a.b.c=", "a+b.c.d", "bwz_short", "bwz_" + "a" * 44,
    "bwz_" + "a" * 42 + "!", "eyJ." + "a" * 5000 + ".c", "bwc_" + "c" * 43,
    # QOR-4806: bwat's other service credentials are never a person either; the prefix is one lowercase letter
    "bwf_" + "f" * 43, "bwb_" + "b" * 43, "bwZ_" + "z" * 43, "bwzz_" + "z" * 43,
])
def test_a_bearer_of_no_known_shape_is_refused_without_asking_the_backend(board, bearer):
    assert get_cards(board, bearer).status_code == 401
    assert board["backend"].me_calls == 0


def test_a_plugins_bearer_reaches_the_backend_with_no_change_here(board):
    # QOR-4806: a bearer kind added later (a plugin's) is the backend's to decide.
    plugin_token = "bwr_" + "R2_-" * 10 + "xyz"
    board["backend"].valid.add(plugin_token)
    assert get_cards(board, plugin_token).status_code == 200
    assert board["backend"].seen[-1]["bearer"] == plugin_token


def test_a_board_token_and_a_google_token_reach_the_backend(board):
    board_token = "bwz_" + "A1_-" * 10 + "abc"
    board["backend"].valid.add(board_token)
    assert get_cards(board, board_token).status_code == 200
    assert get_cards(board).status_code == 200
    assert [seen["bearer"] for seen in board["backend"].seen] == [board_token, TOKEN]


def test_a_valid_token_resolves_with_the_credential_and_the_client_address_the_edge_appended(board):
    assert get_cards(board, forwarded="198.51.100.9, 203.0.113.1").status_code == 200
    assert board["backend"].seen == [{"bearer": TOKEN, "client_ip": "203.0.113.1"}]


def test_without_x_forwarded_for_the_client_is_the_socket_address(board):
    assert get_cards(board).status_code == 200
    assert board["backend"].seen == [{"bearer": TOKEN, "client_ip": "127.0.0.1"}]


def test_failed_sign_ins_are_limited_per_client_address_not_for_everyone(board):
    for n in range(3):
        assert get_cards(board, junk(n), forwarded="203.0.113.1").status_code == 401
    calls = board["backend"].me_calls
    limited = get_cards(board, forwarded="203.0.113.1")
    assert (limited.status_code, limited.json()) == (429, {"error": "rate_limited"})
    assert 1 <= int(limited.headers["retry-after"]) <= 60
    assert board["backend"].me_calls == calls
    # Another client through the same edge is its own; a left-hand entry the client wrote
    # changes nothing.
    assert get_cards(board, forwarded="203.0.113.1, 203.0.113.2").status_code == 200
    assert get_cards(board, junk(9), forwarded="203.0.113.2, 203.0.113.1").status_code == 429
    # Once the minute is over, the client may try again.
    board["clock"].now += 60
    assert get_cards(board, forwarded="203.0.113.1").status_code == 200


def test_junk_counts_as_a_failure_too(board):
    for n in range(3):
        assert get_cards(board, f"junk-{n}", forwarded="203.0.113.1").status_code == 401
    assert get_cards(board, forwarded="203.0.113.1").status_code == 429
    assert board["backend"].me_calls == 0


def test_a_person_already_known_is_not_held_up_by_their_address(board):
    assert get_cards(board, forwarded="203.0.113.1").status_code == 200
    for n in range(3):
        get_cards(board, junk(n), forwarded="203.0.113.1")
    assert get_cards(board, forwarded="203.0.113.1").status_code == 200


def test_a_client_the_backend_limits_is_answered_429_and_not_remembered(board):
    board["backend"].status = 429
    limited = get_cards(board)
    assert (limited.status_code, limited.json(), limited.headers["retry-after"]) == (429, {"error": "rate_limited"}, "17")
    board["backend"].status = None
    assert get_cards(board).status_code == 200


def test_a_credential_the_backend_refuses_is_503_and_not_remembered(board):
    board["backend"].status = 401
    assert get_cards(board).status_code == 503
    assert get_cards(board).status_code == 503
    assert board["backend"].me_calls == 2


def test_the_dev_token_reaches_the_backend_only_when_the_card_service_is_given_it():
    dev = "d" * 40
    backend = FakeBackend(str(uuid.uuid4()))
    backend.valid.add(dev)
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    assert People(http, Clock()).member(dev, "10.0.0.1") is None
    assert backend.me_calls == 0
    assert People(http, Clock(), dev_token=dev).member(dev, "10.0.0.1") == backend.member_id


def test_a_junk_person_shaped_token_counts_against_its_address():
    # QOR-4806: any bwat person shape reaches the backend, so a refused one must still spend the address's tries.
    backend = FakeBackend("m")
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    people = People(http, Clock(), failures_per_min=3)
    for n in range(3):
        assert people.member("bwr_" + str(n) * 43, "10.0.0.9") is None
    with pytest.raises(RateLimited):
        people.member("bwr_" + "9" * 43, "10.0.0.9")
