"""The transcript push through the running bot (persistence first): what was
said goes to POST /meetings/{occurrence}/transcript in seq order, one push at a time, at the
claim's registered epoch; the meeting's end makes a final push with complete: true before
the claim is released."""
import asyncio

import pytest

from bwat_bot.audio import Segment
from bwat_bot.bridge import Alone, Ended, Joined, OccurrenceKnown
from bwat_bot.fake_bridge import FakeBridge
from tests.conftest import MEETING, joined, make_bot, until

OCCURRENCE = "aB/c+d=="  # Zoom occurrence ids carry '/', '+' and '='
HEARTBEAT = "/v1/assignment/heartbeat"


def said(seq: int) -> Segment:
    return Segment(seq, "Speaker 1", f"line {seq}", 1000 * seq, 1000 * seq + 900)


@pytest.fixture
async def bot(backend, bridge, config):
    """A bot in a meeting whose occurrence the backend has recorded."""
    bot = make_bot(backend, bridge, config, push_linger_seconds=0.05, final_seconds=1.0)
    task = asyncio.create_task(bot.run())
    bot.claim = await joined(backend, bridge)
    bridge.emit(Joined())
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: bot.claim.occurrence_uuid == OCCURRENCE)
    yield bot
    bot.stop()
    await asyncio.wait_for(task, 3)


def say(bot, *seqs: int) -> None:
    for seq in seqs:
        bot.segments.put_nowait(said(seq))


def stored_seqs(backend) -> list[int]:
    return sorted(seq for (_, _, seq) in backend.stored)


async def test_segments_are_pushed_in_batches_of_twenty_in_seq_order(bot, backend):
    say(bot, *range(25))
    await until(lambda: len(backend.stored) == 25)
    assert [[s["seq"] for s in p["segments"]] for p in backend.pushes] == [
        list(range(20)), list(range(20, 25))]
    assert {p["epoch"] for p in backend.pushes} == {bot.claim.epoch}
    assert {p["path"] for p in backend.pushes} == {"/v1/meetings/aB%2Fc%2Bd%3D%3D/transcript"}
    assert backend.pushes[0]["segments"][0] == {
        "seq": 0, "speaker_label": "Speaker 1", "text": "line 0", "start_ms": 0,
        "end_ms": 900, "source": "asr"}
    assert not any(p.get("complete") for p in backend.pushes)


async def test_a_server_error_is_retried_with_the_same_batch(bot, backend):
    backend.push_refusals.append((503, "unavailable"))
    say(bot, 0, 1)
    await until(lambda: len(backend.stored) == 2)
    assert [[s["seq"] for s in p["segments"]] for p in backend.pushes] == [[0, 1], [0, 1]]


async def test_a_stale_claim_stops_the_push(bot, backend):
    backend.push_refusals.append((409, "stale_claim"))
    say(bot, 0)
    await until(lambda: backend.pushes)
    say(bot, 1)
    await asyncio.sleep(0.2)
    assert len(backend.pushes) == 1 and backend.stored == {}


async def test_a_deleted_meeting_stops_the_push_and_releases_the_claim(bot, backend):
    backend.deleted.add(OCCURRENCE)
    say(bot, 0)
    await until(lambda: backend.releases)
    assert backend.releases[0]["reason"] == "meeting_deleted"
    say(bot, 1)
    await asyncio.sleep(0.2)
    assert len(backend.pushes) == 1


@pytest.mark.parametrize(("event", "reason", "meeting_ended"),
                         [(Ended(), "meeting_ended", True), (Alone(), "left_alone", None)])
async def test_the_meeting_end_pushes_complete_before_the_release(bot, backend, bridge, event,
                                                                  reason, meeting_ended):
    say(bot, 0, 1)
    bridge.emit(event)
    await until(lambda: backend.releases)
    assert backend.pushes[-1]["complete"] is True
    assert stored_seqs(backend) == [0, 1] and OCCURRENCE in backend.complete
    final = max(i for i, p in enumerate(backend.timeline) if p.endswith("/transcript"))
    assert final < backend.timeline.index("/v1/assignment/release")
    assert backend.releases[0]["reason"] == reason
    assert backend.releases[0].get("meeting_ended") is meeting_ended


async def test_a_meeting_end_after_everything_is_stored_still_says_complete(bot, backend,
                                                                           bridge):
    say(bot, 0)
    await until(lambda: backend.stored)
    bridge.emit(Ended())
    await until(lambda: backend.releases)
    assert backend.pushes[-1]["segments"] == [] and backend.pushes[-1]["complete"] is True


async def test_with_the_backend_down_the_meeting_end_still_releases(bot, backend, bridge):
    backend.push_refusals.extend([(503, "unavailable")] * 1000)
    say(bot, 0)
    await until(lambda: backend.pushes)
    bridge.emit(Ended())
    await until(lambda: backend.releases, timeout=3)


async def test_nothing_is_pushed_until_a_heartbeat_registers_the_epoch(backend, bridge, config):
    bot = make_bot(backend, bridge, config, push_linger_seconds=0.05)
    task = asyncio.create_task(bot.run())
    try:
        claim = await joined(backend, bridge)
        backend.unavailable.add(HEARTBEAT)  # the promotion's confirming beat goes unanswered
        bridge.emit(OccurrenceKnown(OCCURRENCE))
        await until(lambda: claim.occurrence_uuid == OCCURRENCE)
        bot.segments.put_nowait(said(0))
        await asyncio.sleep(0.2)
        assert backend.pushes == []
        backend.unavailable.clear()
        await until(lambda: backend.stored)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 3)


async def test_the_final_push_ends_before_the_lease_would(backend, bridge, config):
    bot = make_bot(backend, bridge, config, lease_seconds=1.0, final_seconds=30.0)
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(OccurrenceKnown(OCCURRENCE))
        await until(lambda: backend.claims and all(
            c.occurrence_uuid == OCCURRENCE for c in backend.claims.values()))
        backend.push_refusals.extend([(503, "unavailable")] * 1000)
        bot.segments.put_nowait(said(0))
        bridge.emit(Ended())
        await until(lambda: backend.releases, timeout=2.5)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 3)


async def test_a_stop_during_the_final_push_still_ends_in_time(bot, backend, bridge):
    bot._final_seconds = 30.0
    backend.push_refusals.extend([(503, "unavailable")] * 1000)
    say(bot, 0)
    bridge.emit(Ended())
    await until(lambda: backend.pushes)
    bot.stop()
    await until(lambda: backend.releases, timeout=2.5)


async def test_a_meeting_end_while_a_stop_cuts_the_join_short_is_released(backend, config):
    class HangingJoin(FakeBridge):
        async def join(self, meeting_number, passcode, credentials=None, options=None):
            await super().join(meeting_number, passcode)
            self.emit(Ended())
            bot.stop()  # SIGTERM lands while the join is still running
            await asyncio.sleep(3600)

    bridge = HangingJoin(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING)
    await asyncio.wait_for(task, 3)
    assert backend.releases[0]["reason"] == "meeting_ended"


async def test_a_final_push_cut_off_by_its_bound_stops_while_the_bot_leaves(backend, config):
    class SlowLeave(FakeBridge):
        async def leave(self):
            self.leaving = len(backend.pushes)
            await asyncio.sleep(1.5)  # past the pusher's retry pause
            self.left = len(backend.pushes)
            await super().leave()

    bridge = SlowLeave(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config, final_seconds=0.2)
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(OccurrenceKnown(OCCURRENCE))
        await until(lambda: all(c.occurrence_uuid == OCCURRENCE
                                for c in backend.claims.values()))
        backend.push_refusals.extend([(503, "unavailable")] * 1000)
        bot.segments.put_nowait(said(0))
        await until(lambda: backend.pushes)
        bridge.emit(Ended())
        await until(lambda: backend.releases, timeout=3)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 3)
    assert bridge.left == bridge.leaving


@pytest.mark.parametrize("status", [429, 408])
async def test_a_rate_limit_or_timeout_answer_is_retried(bot, backend, status):
    backend.push_refusals.append((status, "rate_limited"))
    say(bot, 0)
    await until(lambda: backend.stored, timeout=3)
    assert len(backend.pushes) == 2


async def test_a_pusher_that_died_still_lets_the_bot_release(bot, backend, bridge, monkeypatch):
    async def broken(*_args, **_kwargs):
        raise RuntimeError("bug")

    monkeypatch.setattr(bot._backend, "transcript", broken)
    say(bot, 0)
    await until(lambda: bot._pusher._task.done())  # the push task died on its first batch
    bridge.emit(Ended())
    await until(lambda: backend.releases, timeout=3)



async def test_meeting_chat_is_pushed_as_a_chat_line_by_its_sender(bot, backend, bridge):
    from bwat_bot.bridge import ChatMessage
    bridge.emit(ChatMessage("Ada", "ship it friday"))
    await until(lambda: backend.stored)
    (chat,) = backend.pushes[0]["segments"]
    assert (chat["source"], chat["speaker_label"], chat["text"]) == ("chat", "Ada", "ship it friday")
    assert chat["start_ms"] == chat["end_ms"]
