"""QOR-4893: after the admin's idle_leave_min (default 5) of nothing said, the bot leaves and
releases its claim as `idle`, which the backend never retries. People may still be in the
room, so the transcript is not marked complete: Zoom's meeting.ended ends the meeting."""
import asyncio

import pytest

from bwat_bot.bridge import ChatMessage, Joined, Left, OccurrenceKnown
from bwat_bot.settings import SettingsPoller
from tests.conftest import Clock, joined, make_bot, until
from tests.test_join_options import advance


@pytest.mark.parametrize(("served", "minutes"), [({}, 5), ({"idle_leave_min": 2}, 2)])
async def test_a_silent_meeting_is_left_after_idle_leave_min(backend, bridge, config, served,
                                                              minutes):
    backend.settings_values = served
    clock = Clock()
    bot = make_bot(backend, bridge, config, clock=clock, settings=SettingsPoller(every=0.01))
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(Joined())
        await asyncio.sleep(0.05)
        await advance(clock, 60 * minutes - 5)
        assert backend.releases == []
        await advance(clock, 10)
        await until(lambda: backend.releases)
        release = backend.releases[0]
        assert release["reason"] == "idle"
        assert "requeue" not in release and "meeting_ended" not in release
        assert bridge.leaves == 1
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


async def test_anything_said_starts_the_wait_again(backend, bridge, config):
    clock = Clock()
    bot = make_bot(backend, bridge, config, clock=clock)
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(Joined())
        await asyncio.sleep(0.05)
        await advance(clock, 4 * 60)
        bridge.emit(ChatMessage("Ada", "still here"))
        await asyncio.sleep(0.05)
        await advance(clock, 4 * 60)
        assert backend.releases == []
        await advance(clock, 2 * 60)
        await until(lambda: backend.releases)
        assert backend.releases[0]["reason"] == "idle"
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


async def test_an_idle_leave_pushes_what_was_said_without_ending_the_meeting(backend, bridge,
                                                                             config):
    clock = Clock()
    bot = make_bot(backend, bridge, config, clock=clock, push_linger_seconds=0.05)
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(Joined())
        bridge.emit(OccurrenceKnown("occ-idle"))
        bridge.emit(ChatMessage("Ada", "anyone?"))
        await until(lambda: backend.stored)
        await advance(clock, 5 * 60 + 5)
        await until(lambda: backend.releases)
        assert backend.releases[0]["reason"] == "idle"
        assert not any(p.get("complete") for p in backend.pushes)
        assert "occ-idle" not in backend.complete
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


@pytest.mark.parametrize("reason", ["authorized_user_left", "zoom_end_unknown"])
async def test_zoom_taking_the_bot_out_pushes_what_was_said_without_ending_the_meeting(
        backend, bridge, config, reason):
    # QOR-5113: Zoom took the bot out for a reason that does not say the meeting is over.
    # What it heard and had not pushed yet still goes out; the meeting stays open.
    bot = make_bot(backend, bridge, config, push_linger_seconds=30)
    task = asyncio.create_task(bot.run())
    try:
        claim = await joined(backend, bridge)
        bridge.emit(Joined())
        bridge.emit(OccurrenceKnown("occ-left"))
        await until(lambda: claim.occurrence_uuid == "occ-left")
        bridge.emit(ChatMessage("Ada", "last words"))
        await asyncio.sleep(0.05)
        assert not backend.stored  # still queued: the linger holds it
        bridge.emit(Left(reason))
        await until(lambda: backend.releases)
        release = backend.releases[0]
        assert release["reason"] == reason
        assert "meeting_ended" not in release
        assert [s["text"] for p in backend.pushes for s in p.get("segments", [])] == ["last words"]
        assert not any(p.get("complete") for p in backend.pushes)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)
