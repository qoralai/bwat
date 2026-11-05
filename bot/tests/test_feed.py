"""The operator feed (D171, D178): capture proves it holds the claim's feed token
before the upgrade; every message the bot sends is MACed with a key derived for that
connection; the newest connection wins; the bot closes the feed when the token changes, the
claim ends or the lease lapses. The test vector is fixed, so the backend, bot and card service derive the same values."""
import asyncio
import json

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedError, InvalidStatus

from bwat_bot import feed as feed_module
from bwat_bot.audio import Segment
from bwat_bot.config import Config, ConfigError
from bwat_bot.feed import (
    Binding,
    FeedServer,
    b64url,
    frame,
    mac,
    proof,
    session_key,
    transcript_frame,
)

# A fixed test vector for the feed's token, proof and MAC derivations.
TOKEN = "bwo_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
CLAIM = "3f2b6c1e-8a4d-4f0b-9c7e-1d2a3b4c5d6e"
GENERATION = 7
NONCE = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"
BOT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
OCCURRENCE = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9"
HELLO = ('{"type":"hello","bot_id":"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",'
         '"claim_id":"3f2b6c1e-8a4d-4f0b-9c7e-1d2a3b4c5d6e","generation":7,'
         '"occurrence_id":"0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9","transcript_epoch":2}')
LINE = ('{"type":"transcript","occurrence_id":"0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",'
        '"transcript_epoch":2,"seq":0,"source":"asr","speaker_label":"Speaker 1",'
        '"text":"café ✓","start_ms":1000,"end_ms":2500}')
AUTHORIZATION = "Bwat-Feed FRIRaPphoAt4GarQTJgwJfFEz5tE_DO894vZTETI3Es"
K = "WALUKnsY0teO37iTnhnu_5YJHbvY7E46SRY6rg53UME"
M0 = "MuHJak6D58YiO2_srAcavDy-r7JdNRvzsL7rNGChgsA"
M1 = "KAbo5WbTVyq5CYijqHaNfKv3_gOcBmb453x6ADY6pes"
VECTOR = Binding(bot_id=BOT, claim_id=CLAIM, generation=GENERATION, occurrence_id=OCCURRENCE,
                 transcript_epoch=2, feed_token=TOKEN)


def test_the_fixed_vector():
    assert f"Bwat-Feed {proof(TOKEN, CLAIM, GENERATION, NONCE)}" == AUTHORIZATION
    key = session_key(TOKEN, CLAIM, GENERATION, NONCE)
    assert b64url(key) == K
    assert frame({"type": "hello", "bot_id": BOT, "claim_id": CLAIM, "generation": 7,
                  "occurrence_id": OCCURRENCE, "transcript_epoch": 2}) == HELLO
    assert mac(key, 0, HELLO) == M0
    assert mac(key, 1, LINE) == M1


@pytest.fixture
async def feed():
    server = FeedServer(port=0, host="127.0.0.1")
    await server.start()
    yield server
    await server.aclose()


def dial(feed: FeedServer, authorization: str = AUTHORIZATION, nonce: str = NONCE):
    return connect(f"ws://127.0.0.1:{feed.port}/feed",
                   additional_headers={"authorization": authorization,
                                       "x-bwat-feed-nonce": nonce})


async def envelope(ws) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), 2))


async def test_a_dial_with_the_vector_proof_gets_the_vector_hello(feed):
    feed.bind(VECTOR)
    async with dial(feed) as ws:
        assert await envelope(ws) == {"c": 0, "f": HELLO, "m": M0}


async def test_a_wrong_proof_is_refused_before_the_upgrade(feed):
    feed.bind(VECTOR)
    with pytest.raises(InvalidStatus) as refused:
        async with dial(feed, authorization="Bwat-Feed " + "A" * 43):
            pass
    assert refused.value.response.status_code == 401


async def test_nothing_is_served_before_a_binding(feed):
    with pytest.raises(InvalidStatus) as refused:
        async with dial(feed):
            pass
    assert refused.value.response.status_code == 503


async def test_the_newest_connection_wins(feed):
    feed.bind(VECTOR)
    async with dial(feed) as first:
        await envelope(first)
        async with dial(feed) as second:
            assert (await envelope(second))["c"] == 0
            with pytest.raises(ConnectionClosedError) as closed:
                await first.recv()
            assert closed.value.rcvd.code == 4000


async def test_an_admitted_meeting_follows_hello_and_counts_on(feed):
    feed.bind(VECTOR)
    await feed.admitted("2026-10-03T10:00:00Z")
    async with dial(feed) as ws:
        await envelope(ws)
        started = await envelope(ws)
    assert started["c"] == 1
    assert json.loads(started["f"]) == {"type": "meeting_started", "occurrence_id": OCCURRENCE,
                                        "started_at": "2026-10-03T10:00:00Z"}
    assert started["m"] == mac(session_key(TOKEN, CLAIM, GENERATION, NONCE), 1, started["f"])


@pytest.mark.parametrize("code", [4001, 4002, 4004])
async def test_an_unbind_closes_the_feed_with_its_code(feed, code):
    feed.bind(VECTOR)
    async with dial(feed) as ws:
        await envelope(ws)
        feed.unbind(code)
        with pytest.raises(ConnectionClosedError) as closed:
            await ws.recv()
        assert closed.value.rcvd.code == code
    with pytest.raises(InvalidStatus):
        async with dial(feed):
            pass


BASE = {"BWAT_BACKEND_URL": "https://backend.test", "BWAT_FLEET_CREDENTIAL": "bwf_" + "a" * 43}


def test_the_feed_port_is_8771_unless_set():
    assert Config.from_env(BASE).feed_port == 8771
    assert Config.from_env(BASE | {"BWAT_FEED_PORT": "9000"}).feed_port == 9000


@pytest.mark.parametrize("port", ["0", "65536", "http", "-1"])
def test_a_feed_port_that_is_not_a_port_stops_the_bot(port):
    with pytest.raises(ConfigError):
        Config.from_env(BASE | {"BWAT_FEED_PORT": port})


async def test_a_replacement_that_dies_on_hello_still_closes_the_one_it_replaced(feed,
                                                                                 monkeypatch):
    feed.bind(VECTOR)
    async with dial(feed) as first:
        await envelope(first)
        send = feed_module._Subscriber.send

        async def dies_on_hello(self, body):
            if body["type"] == "hello":
                await self.connection.close()
            await send(self, body)

        monkeypatch.setattr(feed_module._Subscriber, "send", dies_on_hello)
        async with dial(feed):
            with pytest.raises(ConnectionClosedError) as closed:
                await asyncio.wait_for(first.recv(), 2)
    assert closed.value.rcvd.code == 4000


async def test_a_new_epoch_closes_the_feed_so_capture_hears_the_new_hello(feed):
    feed.bind(VECTOR)
    async with dial(feed) as ws:
        await envelope(ws)
        feed.bind(Binding(BOT, CLAIM, GENERATION, OCCURRENCE, 3, TOKEN))
        with pytest.raises(ConnectionClosedError) as closed:
            await asyncio.wait_for(ws.recv(), 2)
        assert closed.value.rcvd.code == 4001


async def test_a_subscriber_that_stops_reading_never_blocks_the_bot(feed, monkeypatch):
    feed.bind(VECTOR)
    async with dial(feed) as ws:
        await envelope(ws)

        async def stalled(*_args, **_kwargs):
            await asyncio.sleep(3600)  # a write buffer that never drains

        monkeypatch.setattr(feed._subscriber.connection, "send", stalled)
        await asyncio.wait_for(feed.publish({"type": "meeting_ended",
                                             "occurrence_id": OCCURRENCE}), 3)
        assert feed._subscriber is None  # the stalled subscriber was dropped


async def test_a_stored_line_goes_out_as_the_vector_transcript_frame(feed):
    feed.bind(VECTOR)
    async with dial(feed) as ws:
        await envelope(ws)
        await feed.publish(transcript_frame(
            OCCURRENCE, 2, Segment(0, "Speaker 1", "café ✓", 1000, 2500)))
        assert await envelope(ws) == {"c": 1, "f": LINE, "m": M1}


def test_a_chat_line_goes_out_marked_as_chat():
    frame = transcript_frame(OCCURRENCE, 2, Segment(3, "Ada", "agreed", 900, 900, "chat"))
    assert (frame["source"], frame["speaker_label"]) == ("chat", "Ada")
