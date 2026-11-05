"""How many database connections the card API holds at once (QOR-4986): a pool of at most
BWAT_CARDS_MAX_CONCURRENT, here 1. A request with none free waits briefly and is refused with
503, rather than opening another. Same database and fake backend as test_api_person."""

import contextlib
import threading
import time
import uuid

import httpx
import pytest

from api import app
from api.app import make_server
from tests import test_api_person as person
from tests.test_api_person import BACKEND_TOKEN, CREDENTIAL, FakeBackend, as_person

board = person.board
WAIT_S = 0.3  # the pool's wait here, for quick tests


@contextlib.contextmanager
def serving(db, board, **options):
    """A second server on the board's database, and a client for it."""
    backend = FakeBackend(board["member"])
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test",
                        headers={"Authorization": f"Bearer {CREDENTIAL}"})
    server = make_server(db.url("cards"), http, BACKEND_TOKEN, port=0, **options)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield httpx.Client(base_url=f"http://127.0.0.1:{server.server_address[1]}", timeout=30)
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def capped(db, board, monkeypatch):
    """A server whose one connection a set_owner holds, blocked on the card's row lock, until
    the test lets it go."""
    monkeypatch.setattr(app, "BUSY_WAIT_S", WAIT_S)
    with serving(db, board, max_concurrent=1) as client:
        lock = db.connect("cards")
        lock.execute("BEGIN")
        lock.execute("SELECT 1 FROM cards.cards WHERE id = %s FOR UPDATE", [board["card"]])
        held = {}

        def set_owner():
            held["response"] = client.put(f"/v1/cards/{board['card']}/owner",
                                          **as_person(json={"revision": 1, "owner_member_id": board["member"]}))

        holder = threading.Thread(target=set_owner)
        holder.start()
        # The set_owner is waiting on the row lock, so holding the connection.
        with db.connect("cards") as conn:
            deadline = time.monotonic() + 10
            while not conn.execute("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                                   "AND usename = 'bwat_cards'").fetchone():
                assert time.monotonic() < deadline, "set_owner never reached the row lock"
                time.sleep(0.05)

        def release():
            lock.execute("COMMIT")
            holder.join(10)
            return held["response"]

        yield {"client": client, "release": release}
        lock.close()


def cards_of(capped, board):
    return capped["client"].get(f"/v1/occurrences/{board['meeting']}/cards", **as_person())


def test_a_request_with_no_connection_free_waits_briefly_then_is_refused_with_503(board, capped):
    started = time.monotonic()
    refused = cards_of(capped, board)
    assert (refused.status_code, refused.json()) == (503, {"error": "busy"})
    assert WAIT_S <= time.monotonic() - started < 5  # inside the backend's own wait (cards-client.ts TIMEOUT_MS)
    assert capped["release"]().status_code == 200
    assert cards_of(capped, board).status_code == 200  # the connection is free again


def test_a_handlers_refusal_gives_its_connection_back(board, capped):
    capped["release"]()
    # Refused inside its handler, holding the one connection: it goes back all the same.
    assert capped["client"].get(f"/v1/cards/{uuid.uuid4()}", **as_person()).status_code == 404
    assert cards_of(capped, board).status_code == 200


def test_health_does_not_wait_for_the_pool(capped):
    assert capped["client"].get("/health").status_code == 200


def test_the_default_wait_is_inside_the_backends_5_s():
    assert app.BUSY_WAIT_S < 5


def test_the_counts_never_wait_for_the_pool(board, capped):
    """Boards queue on the one count, which therefore needs at most one connection of its own."""
    started = time.monotonic()
    assert capped["client"].get("/v1/cards/counts", **as_person()).status_code == 200
    assert time.monotonic() - started < WAIT_S


def test_a_pooled_connection_the_database_closed_is_replaced_not_failed(db, board):
    with serving(db, board) as client:
        assert client.get(f"/v1/occurrences/{board['meeting']}/cards", **as_person()).status_code == 200
        with db.connect("cards") as conn:  # as a database restart would
            conn.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                         "WHERE usename = 'bwat_cards' AND pid <> pg_backend_pid()")
        assert client.get(f"/v1/occurrences/{board['meeting']}/cards", **as_person()).status_code == 200
