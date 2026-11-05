"""The feed through the running bot: it serves the claim it holds once the backend recorded
the occurrence and registered the epoch, reports where to dial only then (and only a private
address), and closes the feed when the token changes, the claim ends or the lease lapses."""
import asyncio
import json
import secrets

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedError

from bwat_bot.audio import Segment
from bwat_bot.bridge import Ended, OccurrenceKnown
from bwat_bot.fake_bridge import FakeBridge
from bwat_bot.feed import FeedServer, mac, proof, session_key
from tests.conftest import MEETING, joined, make_bot, until
from tests.fake_backend import feed_token

OCCURRENCE = "kq8Zr1x2Tq+Ab/Cd9eFg=="
PRIVATE = "10.180.1.5"


@pytest.fixture
async def feed():
    server = FeedServer(port=0, host="127.0.0.1")
    await server.start()
    yield server
    await server.aclose()


async def attending(backend, bridge, config, feed, host=PRIVATE, **options):
    bot = make_bot(backend, bridge, config, feed=feed, feed_host=lambda: host, **options)
    task = asyncio.create_task(bot.run())
    claim = await joined(backend, bridge)
    return bot, task, claim


async def recorded(backend, bridge, claim):
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: claim.occurrence_uuid == OCCURRENCE)
    await until(lambda: "feed_host" in backend.heartbeats[-1])


def dial(feed, backend, claim):
    nonce = "n" * 43
    token = feed_token(backend.feed_key, claim)
    return connect(f"ws://127.0.0.1:{feed.port}/feed", additional_headers={
        "authorization": "Bwat-Feed " + proof(token, claim.claim_id, claim.generation, nonce),
        "x-bwat-feed-nonce": nonce})


async def closed_with(ws) -> int:
    with pytest.raises(ConnectionClosedError) as closed:
        while True:
            await asyncio.wait_for(ws.recv(), 2)
    return closed.value.rcvd.code


async def stop(bot, task):
    bot.stop()
    await asyncio.wait_for(task, 3)


async def test_the_address_is_reported_only_once_the_feed_serves(backend, bridge, config, feed):
    bot, task, claim = await attending(backend, bridge, config, feed)
    try:
        await until(lambda: len(backend.heartbeats) >= 3)
        assert not any("feed_host" in h for h in backend.heartbeats)
        await recorded(backend, bridge, claim)
        assert backend.heartbeats[-1]["feed_host"] == PRIVATE
        assert backend.heartbeats[-1]["feed_port"] == feed.port
        async with dial(feed, backend, claim) as ws:
            hello = json.loads(json.loads(await asyncio.wait_for(ws.recv(), 2))["f"])
        assert hello == {"type": "hello", "bot_id": backend.bots[next(iter(backend.bots))],
                         "claim_id": claim.claim_id, "generation": claim.generation,
                         "occurrence_id": OCCURRENCE, "transcript_epoch": claim.epoch}
    finally:
        await stop(bot, task)


@pytest.mark.parametrize("host", ["127.0.0.1", "169.254.169.254", "8.8.8.8", None])
async def test_an_address_capture_could_not_dial_is_never_reported(backend, bridge, config,
                                                                    feed, host):
    bot, task, claim = await attending(backend, bridge, config, feed, host=host)
    try:
        bridge.emit(OccurrenceKnown(OCCURRENCE))
        await until(lambda: claim.occurrence_uuid == OCCURRENCE)
        beats = len(backend.heartbeats)
        await until(lambda: len(backend.heartbeats) >= beats + 3)
        assert not any("feed_host" in h or "feed_port" in h for h in backend.heartbeats)
        assert claim.state == "held"
    finally:
        await stop(bot, task)


async def test_a_recall_closes_the_feed_as_claim_over(backend, bridge, config, feed):
    bot, task, claim = await attending(backend, bridge, config, feed)
    try:
        await recorded(backend, bridge, claim)
        async with dial(feed, backend, claim) as ws:
            await ws.recv()
            backend.recall(claim)
            assert await closed_with(ws) == 4002
    finally:
        await stop(bot, task)


async def test_a_lapsed_lease_closes_the_feed_as_lease_expired(backend, bridge, config, feed):
    bot, task, claim = await attending(backend, bridge, config, feed, heartbeat_seconds=0.01,
                                       lease_seconds=0.3)
    try:
        await recorded(backend, bridge, claim)
        async with dial(feed, backend, claim) as ws:
            await ws.recv()
            backend.down = True  # no renewal reaches the backend
            assert await closed_with(ws) == 4004
    finally:
        await stop(bot, task)


async def test_a_new_feed_token_closes_the_feed_as_rotated(backend, bridge, config, feed):
    bot, task, claim = await attending(backend, bridge, config, feed)
    try:
        await recorded(backend, bridge, claim)
        async with dial(feed, backend, claim) as ws:
            await ws.recv()
            backend.feed_key = secrets.token_bytes(32)  # BWAT_FEED_KEY rotated
            assert await closed_with(ws) == 4001
        async with dial(feed, backend, claim) as ws:  # the new token opens it again
            assert json.loads(await asyncio.wait_for(ws.recv(), 2))["c"] == 0
    finally:
        await stop(bot, task)


async def test_without_a_feed_token_there_is_no_feed(backend, bridge, config, feed):
    backend.feed_key = None  # a backend from before the feed
    bot, task, claim = await attending(backend, bridge, config, feed)
    try:
        bridge.emit(OccurrenceKnown(OCCURRENCE))
        await until(lambda: claim.occurrence_uuid == OCCURRENCE)
        beats = len(backend.heartbeats)
        await until(lambda: len(backend.heartbeats) >= beats + 3)
        assert not any("feed_host" in h for h in backend.heartbeats)
    finally:
        await stop(bot, task)


async def test_a_lost_claim_closes_the_feed_before_the_bot_has_left(backend, config, feed):
    class SlowLeave(FakeBridge):
        async def leave(self):
            await asyncio.sleep(1.0)
            await super().leave()

    bridge = SlowLeave(timeline=backend.timeline)
    bot, task, claim = await attending(backend, bridge, config, feed)
    try:
        await recorded(backend, bridge, claim)
        async with dial(feed, backend, claim) as ws:
            await ws.recv()
            backend.recall(claim)
            assert await closed_with(ws) == 4002
            assert bridge.leaves == 0
    finally:
        await stop(bot, task)


async def test_a_failed_address_lookup_is_tried_again(backend, bridge, config, feed):
    answers = iter([None, PRIVATE])
    bot, task, claim = await attending(backend, bridge, config, feed)
    bot._find_feed_host = lambda: next(answers, PRIVATE)
    try:
        await recorded(backend, bridge, claim)
        assert backend.heartbeats[-1]["feed_host"] == PRIVATE
    finally:
        await stop(bot, task)


@pytest.mark.parametrize("host", ["192.0.2.10", "0.1.2.3", "100.64.0.1"])
def test_only_rfc1918_addresses_are_dialable(host):
    from bwat_bot.lifecycle import dialable
    assert not dialable(host)
    assert dialable("10.180.1.5") and dialable("172.16.0.9") and dialable("192.168.1.2")


class RecordedFeed(FeedServer):
    """Logs each frame it publishes on the backend's timeline, to order it against calls."""

    def __init__(self, timeline: list[str]) -> None:
        super().__init__(port=0, host="127.0.0.1")
        self._timeline = timeline

    async def publish(self, body: dict) -> None:
        self._timeline.append(f"feed.{body['type']}")
        await super().publish(body)


async def test_stored_segments_go_out_in_order_then_meeting_ended_before_the_release(
        backend, bridge, config):
    feed = RecordedFeed(backend.timeline)
    await feed.start()
    bot, task, claim = await attending(backend, bridge, config, feed,
                                       push_linger_seconds=0.2)
    try:
        await recorded(backend, bridge, claim)
        async with dial(feed, backend, claim) as ws:
            await ws.recv()  # hello
            for seq in range(3):
                bot.segments.put_nowait(Segment(seq, "Speaker 1", f"line {seq}", seq, seq + 1))
            envelopes = [json.loads(await asyncio.wait_for(ws.recv(), 2)) for _ in range(3)]
            bridge.emit(Ended())
            ended = json.loads(await asyncio.wait_for(ws.recv(), 2))
            await until(lambda: backend.releases)
    finally:
        await stop(bot, task)
        await feed.aclose()
    (push, final) = backend.pushes
    assert [s["seq"] for s in push["segments"]] == [0, 1, 2] and final["complete"] is True
    key = session_key(feed_token(backend.feed_key, claim), claim.claim_id, claim.generation,
                      "n" * 43)
    assert [e["c"] for e in envelopes] == [1, 2, 3]
    assert all(e["m"] == mac(key, e["c"], e["f"]) for e in envelopes)
    assert [json.loads(e["f"])["seq"] for e in envelopes] == [0, 1, 2]
    assert json.loads(ended["f"]) == {"type": "meeting_ended", "occurrence_id": OCCURRENCE}
    timeline = backend.timeline
    first_push = timeline.index(next(p for p in timeline if p.endswith("/transcript")))
    last_push = max(i for i, p in enumerate(timeline) if p.endswith("/transcript"))
    assert first_push < timeline.index("feed.transcript")
    assert last_push < timeline.index("feed.meeting_ended") < timeline.index(
        "/v1/assignment/release")


async def test_a_meeting_end_before_the_join_completes_publishes_nothing(backend, config, feed):
    class HangingJoin(FakeBridge):
        async def join(self, meeting_number, passcode, credentials=None, options=None):
            await super().join(meeting_number, passcode)
            self.emit(Ended())
            bot.stop()  # SIGTERM lands while the join is still running
            await asyncio.sleep(3600)

    bridge = HangingJoin(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config, feed=feed, feed_host=lambda: PRIVATE)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING)
    await asyncio.wait_for(task, 3)
    assert backend.releases[0]["reason"] == "meeting_ended"


async def test_a_stalled_meeting_ended_send_still_releases_within_the_bound(backend, bridge,
                                                                            config):
    class StalledEnd(FeedServer):
        async def publish(self, body: dict) -> None:
            if body["type"] == "meeting_ended":
                await asyncio.sleep(3600)  # a subscriber that never drains
            await super().publish(body)

    feed = StalledEnd(port=0, host="127.0.0.1")
    await feed.start()
    bot, task, claim = await attending(backend, bridge, config, feed, final_seconds=0.5)
    try:
        await recorded(backend, bridge, claim)
        bridge.emit(Ended())
        await until(lambda: backend.releases, timeout=2)
    finally:
        await stop(bot, task)
        await feed.aclose()


async def test_no_meeting_ended_when_the_final_push_was_refused(backend, bridge, config):
    feed = RecordedFeed(backend.timeline)
    await feed.start()
    bot, task, claim = await attending(backend, bridge, config, feed)
    try:
        await recorded(backend, bridge, claim)
        backend.push_refusals.append((409, "stale_epoch"))
        bridge.emit(Ended())
        await until(lambda: backend.releases)
    finally:
        await stop(bot, task)
        await feed.aclose()
    assert backend.pushes and "feed.meeting_ended" not in backend.timeline


async def test_a_feed_that_fails_never_stops_the_transcript_push(backend, bridge, config):
    class BrokenFeed(FeedServer):
        async def publish(self, body: dict) -> None:
            raise RuntimeError("bug")

    feed = BrokenFeed(port=0, host="127.0.0.1")
    await feed.start()
    bot, task, claim = await attending(backend, bridge, config, feed, push_linger_seconds=0.05)
    try:
        await recorded(backend, bridge, claim)
        bot.segments.put_nowait(Segment(0, "Speaker 1", "line 0", 0, 1))
        await until(lambda: len(backend.stored) == 1)
        bot.segments.put_nowait(Segment(1, "Speaker 1", "line 1", 1, 2))
        await until(lambda: len(backend.stored) == 2)
    finally:
        await stop(bot, task)
        await feed.aclose()


async def test_the_feed_address_goes_out_as_soon_as_the_feed_serves(backend, bridge, config,
                                                                    feed):
    # Heartbeats far apart: the address must not wait for the next regular one.
    bot, task, _claim = await attending(backend, bridge, config, feed, heartbeat_seconds=60)
    try:
        bridge.emit(OccurrenceKnown(OCCURRENCE))
        await until(lambda: any("feed_host" in h for h in backend.heartbeats), timeout=2)
    finally:
        await stop(bot, task)
