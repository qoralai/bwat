"""Live capture from a bot's feed (slice C3c, QOR-4679; D80, D171, D178).

A fake bot serves the feed's fixed test vector over a real WebSocket on loopback, and a fake
backend answers GET /v1/fleet and the transcript GET; the meeting row is real, because
capture files lines under the meeting the view names for the hello's occurrence.
"""

import asyncio
import ipaddress
import json
import logging
import threading
import time

import httpx
import pytest
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from capture import feed
from capture.buffer import Buffer
from capture.stored import StoredRead
from tests.acceptance.test_commitment_becomes_card import line

CREDENTIAL = "bwc_test"
TOKEN = "bwo_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
CLAIM = "3f2b6c1e-8a4d-4f0b-9c7e-1d2a3b4c5d6e"
BOT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
OCCURRENCE = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9"
NONCE = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"
AUTHORIZATION = "Bwat-Feed FRIRaPphoAt4GarQTJgwJfFEz5tE_DO894vZTETI3Es"
HELLO = (
    '{"type":"hello","bot_id":"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","claim_id":"3f2b6c1e-8a4d-4f0b-9c7e-1d2a3b4c5d6e",'
    '"generation":7,"occurrence_id":"0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9","transcript_epoch":2}'
)
LINE = (
    '{"type":"transcript","occurrence_id":"0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9","transcript_epoch":2,"seq":0,'
    '"source":"asr","speaker_label":"Speaker 1","text":"café ✓","start_ms":1000,"end_ms":2500}'
)
VECTOR = [
    {"c": 0, "f": HELLO, "m": "MuHJak6D58YiO2_srAcavDy-r7JdNRvzsL7rNGChgsA"},
    {"c": 1, "f": LINE, "m": "KAbo5WbTVyq5CYijqHaNfKv3_gOcBmb453x6ADY6pes"},
]


def test_the_fixed_vector():
    assert "Bwat-Feed " + feed.proof(TOKEN, CLAIM, 7, NONCE) == AUTHORIZATION
    key = feed.session_key(TOKEN, CLAIM, 7, NONCE)
    assert feed.b64(key) == "WALUKnsY0teO37iTnhnu_5YJHbvY7E46SRY6rg53UME"
    assert [feed.frame_mac(key, e["c"], e["f"]) for e in VECTOR] == [e["m"] for e in VECTOR]


@pytest.mark.parametrize(
    "host,ok",
    # IPv4 only (D165): a v6 address is refused, a v4 one inside it (the metadata service) included.
    [("10.0.4.7", True), ("172.31.2.9", True), ("8.8.8.8", False), ("127.0.0.1", False), ("169.254.169.254", False),
     ("::ffff:169.254.169.254", False), ("::ffff:10.0.4.7", False), ("fd00::5", False)],
)
def test_only_a_private_address_is_dialled(host, ok, monkeypatch):
    monkeypatch.setattr(feed, "ALLOW_LOOPBACK", False)
    assert feed.dialable(ipaddress.ip_address(host)) is ok


class FakeBot:
    """GET /feed: checks the proof, then sends `envelopes`, then closes with `close_code`."""

    def __init__(self, envelopes, close_code=4002):
        self.envelopes = envelopes
        self.close_code = close_code
        self.authorizations = []
        self.closed_with = None
        self.done = asyncio.Event()

    def check(self, connection, request):
        self.authorizations.append(request.headers.get("Authorization"))
        if request.headers.get("X-Bwat-Feed-Nonce") != NONCE or request.headers.get("Authorization") != AUTHORIZATION:
            return connection.respond(401, "")
        return None

    async def handle(self, ws):
        try:
            for envelope in self.envelopes:
                await ws.send(json.dumps(envelope))
            await asyncio.sleep(0.3)
            await ws.close(self.close_code)
        finally:
            self.closed_with = ws.close_code
            self.done.set()


class FakeBackend:
    def __init__(self, port, stored=(), generation=7):
        self.port = port
        self.stored = list(stored)
        self.generation = generation
        self.fleet_reads = 0
        self.transcript_reads = 0
        self.handle_fleet = lambda: [self.row()]

    def row(self):
        return {"bot_id": BOT, "claim_id": CLAIM, "generation": self.generation, "occurrence_id": OCCURRENCE,
                "transcript_epoch": 2, "feed_token": TOKEN, "feed_host": "127.0.0.1", "feed_port": self.port}

    def handle(self, request):
        assert request.headers["authorization"] == f"Bearer {CREDENTIAL}"
        if request.url.path == "/v1/fleet":
            self.fleet_reads += 1
            return httpx.Response(200, json={"fleet": self.handle_fleet()})
        self.transcript_reads += 1
        # Everything on a first read; nothing new after the cursor.
        segments = [] if request.url.params.get("cursor") else self.stored
        return httpx.Response(200, json={"occurrence_state": "live", "segments": segments, "next_cursor": None})


class Recording(Buffer):
    def __init__(self):
        super().__init__()
        self.added = []

    def add(self, meeting_id, line):
        self.added.append((line["epoch"], line["seq"]))
        super().add(meeting_id, line)


@pytest.fixture
def meeting(db):
    with db.connect("owner") as owner:
        meeting_id = owner.execute(
            "INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (%s, '123456789') RETURNING id::text",
            [OCCURRENCE],
        ).fetchone()[0]
    yield meeting_id
    with db.connect("owner") as owner:
        owner.execute("DELETE FROM bwat.meetings WHERE id = %s", [meeting_id])


@pytest.fixture(autouse=True)
def loopback_and_fixed_nonce(monkeypatch):
    monkeypatch.setattr(feed, "ALLOW_LOOPBACK", True)
    monkeypatch.setattr(feed, "new_nonce", lambda: NONCE)


async def capture_once(db, bot, stored=()):
    """Serves the fake bot, follows its one /fleet row until the connection ends."""
    async with serve(bot.handle, "127.0.0.1", 0, process_request=bot.check) as server:
        port = server.sockets[0].getsockname()[1]
        backend = FakeBackend(port, stored)
        http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
        buffer = Recording()
        capture = feed.FeedCapture(db.url("cards"), http, StoredRead(db.url("cards"), http, buffer), buffer)
        (row,) = capture.fleet()
        await asyncio.wait_for(capture.follow(row), timeout=10)
        return buffer, backend


def stored_lines(n):
    return [line(seq, "Speaker 1", f"stored {seq}", epoch=2) for seq in range(n)]


async def test_the_vectors_line_lands_under_the_hellos_meeting(db, meeting):
    bot = FakeBot(VECTOR)
    buffer, _ = await capture_once(db, bot)
    assert bot.authorizations == [AUTHORIZATION]
    assert buffer.lines[meeting][(2, 0)]["text"] == "café ✓"
    assert buffer.lines[meeting][(2, 0)]["speaker"]["label"] == "Speaker 1"


async def test_a_flipped_mac_closes_the_socket_and_files_nothing(db, meeting):
    flipped = dict(VECTOR[1], m="L" + VECTOR[1]["m"][1:])
    bot = FakeBot([VECTOR[0], flipped])
    buffer, _ = await capture_once(db, bot)
    await asyncio.wait_for(bot.done.wait(), 5)
    assert bot.closed_with == 1008
    assert (2, 0) not in buffer.lines.get(meeting, {})


async def test_a_hello_that_does_not_match_fleet_twice_closes_with_1008(db, meeting):
    key = feed.session_key(TOKEN, CLAIM, 7, NONCE)
    hello = HELLO.replace('"generation":7', '"generation":8')
    bot = FakeBot([{"c": 0, "f": hello, "m": feed.frame_mac(key, 0, hello)}])
    buffer, backend = await capture_once(db, bot)
    await asyncio.wait_for(bot.done.wait(), 5)
    assert bot.closed_with == 1008
    assert backend.fleet_reads == 2  # the row it dialled, then one re-read
    assert buffer.added == [] and backend.transcript_reads == 1  # only the read on close


async def test_stored_lines_are_filed_before_live_ones_and_once_more_on_close(db, meeting):
    bot = FakeBot(VECTOR, close_code=4002)
    buffer, backend = await capture_once(db, bot, stored=stored_lines(5))
    assert buffer.added == [(2, s) for s in range(5)] + [(2, 0)]
    assert buffer.lines[meeting][(2, 0)]["text"] == "stored 0"
    assert backend.transcript_reads == 2  # on bind, and on close


async def test_a_redirect_is_not_followed(db, meeting):
    elsewhere = FakeBot(VECTOR)
    async with serve(elsewhere.handle, "127.0.0.1", 0, process_request=elsewhere.check) as target:
        target_port = target.sockets[0].getsockname()[1]

        def redirect(connection, request):
            return Response(302, "Found", Headers({"Location": f"ws://127.0.0.1:{target_port}/feed"}))

        async with serve(elsewhere.handle, "127.0.0.1", 0, process_request=redirect) as server:
            port = server.sockets[0].getsockname()[1]
            backend = FakeBackend(port)
            http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
            buffer = Recording()
            capture = feed.FeedCapture(db.url("cards"), http, StoredRead(db.url("cards"), http, buffer), buffer)
            (row,) = capture.fleet()
            await asyncio.wait_for(capture.follow(row), timeout=10)
    assert elsewhere.authorizations == []


def test_capture_runs_in_its_own_thread_until_stopped(db):
    backend = FakeBackend(9)
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    buffer = Buffer()
    capture = feed.FeedCapture(db.url("cards"), http, StoredRead(db.url("cards"), http, buffer), buffer)
    stop = threading.Event()
    thread = threading.Thread(target=capture.run, args=(stop,))
    thread.start()
    deadline = time.monotonic() + 5
    while backend.fleet_reads == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    stop.set()
    thread.join(timeout=10)
    assert backend.fleet_reads >= 1
    assert not thread.is_alive()


def signed(c, f):
    return {"c": c, "f": f, "m": feed.frame_mac(feed.session_key(TOKEN, CLAIM, 7, NONCE), c, f)}


async def test_a_skipped_counter_closes_the_socket_and_files_nothing(db, meeting):
    bot = FakeBot([VECTOR[0], signed(2, LINE)])
    buffer, _ = await capture_once(db, bot)
    await asyncio.wait_for(bot.done.wait(), 5)
    assert bot.closed_with == 1008
    assert buffer.added == []


async def test_a_line_for_another_occurrence_is_dropped(db, meeting):
    other = LINE.replace(OCCURRENCE, "11111111-2222-4333-8444-555555555555")
    bot = FakeBot([VECTOR[0], signed(1, other)])
    buffer, _ = await capture_once(db, bot)
    assert buffer.added == []


async def test_a_hello_naming_another_bots_claim_is_refused_even_if_fleet_lists_it(db, meeting):
    other_claim = "44444444-5555-4666-8777-888888888888"
    hello = HELLO.replace(CLAIM, other_claim)
    bot = FakeBot([signed(0, hello), signed(1, LINE)])
    async with serve(bot.handle, "127.0.0.1", 0, process_request=bot.check) as server:
        backend = FakeBackend(server.sockets[0].getsockname()[1])
        listed = backend.row
        http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
        buffer = Recording()
        capture = feed.FeedCapture(db.url("cards"), http, StoredRead(db.url("cards"), http, buffer), buffer)
        (row,) = capture.fleet()
        # The re-read lists the other claim too, as /fleet would for a second live bot.
        backend.handle_fleet = lambda: [listed(), listed() | {"claim_id": other_claim}]
        await asyncio.wait_for(capture.follow(row), timeout=10)
        await asyncio.wait_for(bot.done.wait(), 5)
    assert bot.closed_with == 1008
    assert buffer.added == []


@pytest.mark.parametrize(
    "change",
    # A v6 host is never dialled, a v4 one inside it included (D165: bots report private IPv4).
    [{"feed_host": "fd00::5"}, {"feed_host": "::ffff:10.0.4.7"}, {"feed_host": "::ffff:169.254.169.254"}, {"generation": None}, {"feed_port": 80.7}, {"generation": "7"}],
)
def test_a_row_capture_cannot_dial_exactly_is_skipped(change):
    row = FakeBackend(9000).row() | {"feed_host": "10.0.4.7"}
    assert feed.feedable(row)
    assert not feed.feedable(row | change)


@pytest.mark.parametrize(
    "second",
    [
        {"c": 1, "f": LINE, "m": "\u00e9"},  # not even ASCII, before any MAC check
        "not json",
        signed(1, "[1]"),  # authenticated, but not a frame
        signed(1, LINE.replace('"seq":0,', "")),  # a transcript frame missing a field
        signed(1, LINE.replace('"seq":0,', '"seq":"0",')),  # a field of the wrong type
        signed(1, LINE.replace('"text":"caf\u00e9 \u2713"', '"text":null')),
    ],
)
async def test_any_malformed_message_closes_with_1008_and_files_nothing(db, meeting, second):
    bot = FakeBot([VECTOR[0], second])
    buffer, _ = await capture_once(db, bot)
    await asyncio.wait_for(bot.done.wait(), 5)
    assert bot.closed_with == 1008
    assert buffer.added == []


async def test_a_first_frame_that_is_not_hello_closes_with_1008(db, meeting):
    bot = FakeBot([signed(0, LINE)])
    buffer, _ = await capture_once(db, bot)
    await asyncio.wait_for(bot.done.wait(), 5)
    assert bot.closed_with == 1008
    assert buffer.added == []


async def test_a_line_for_another_epoch_than_the_hellos_is_dropped(db, meeting):
    bot = FakeBot([VECTOR[0], signed(1, LINE.replace('"transcript_epoch":2', '"transcript_epoch":3'))])
    buffer, _ = await capture_once(db, bot)
    assert buffer.added == []


async def test_being_replaced_by_another_capture_is_a_warning(db, meeting, caplog):
    bot = FakeBot(VECTOR, close_code=4000)
    with caplog.at_level(logging.WARNING, logger="cards.feed"):
        await capture_once(db, bot)
    assert "4000" in caplog.text


async def test_a_hello_with_a_missing_field_closes_with_1008(db, meeting):
    key = feed.session_key(TOKEN, CLAIM, 7, NONCE)
    hello = HELLO.replace(',"transcript_epoch":2', "")
    bot = FakeBot([{"c": 0, "f": hello, "m": feed.frame_mac(key, 0, hello)}])
    _, _ = await capture_once(db, bot)
    await asyncio.wait_for(bot.done.wait(), 5)
    assert bot.closed_with == 1008


async def test_a_re_read_row_cannot_move_the_feed_to_another_occurrence(db, meeting):
    other = "77777777-8888-4999-8aaa-bbbbbbbbbbbb"
    hello = HELLO.replace(OCCURRENCE, other)
    bot = FakeBot([signed(0, hello), signed(1, LINE.replace(OCCURRENCE, other))])
    async with serve(bot.handle, "127.0.0.1", 0, process_request=bot.check) as server:
        backend = FakeBackend(server.sockets[0].getsockname()[1])
        listed = backend.row
        http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
        buffer = Recording()
        capture = feed.FeedCapture(db.url("cards"), http, StoredRead(db.url("cards"), http, buffer), buffer)
        (row,) = capture.fleet()
        # The same claim's row now names another occurrence.
        backend.handle_fleet = lambda: [listed() | {"occurrence_id": other}]
        await asyncio.wait_for(capture.follow(row), timeout=10)
        await asyncio.wait_for(bot.done.wait(), 5)
    assert bot.closed_with == 1008
    assert buffer.added == []
