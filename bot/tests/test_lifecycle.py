"""The claim lifecycle rules from backend/README.md."""
import asyncio
import logging

import pytest

from bwat_bot import lifecycle
from bwat_bot.audio import Segment
from bwat_bot.bridge import (
    Alone,
    Ended,
    Failed,
    Joined,
    Left,
    OccurrenceKnown,
    Removed,
    WaitingForHost,
    WaitingRoom,
)
from bwat_bot.fake_bridge import FakeBridge
from bwat_bot.lifecycle import next_wait
from tests.conftest import MEETING, PASSCODE, calls, joined, make_bot, until

OCCURRENCE = "kq8Zr1x2Tq+Ab/Cd9eFg=="


async def test_meeting_end_arriving_during_a_heartbeat_is_not_discarded(
        running, backend, bridge, monkeypatch):
    await joined(backend, bridge)
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: running._recorded == OCCURRENCE)
    original = running._beat_or_leave
    injected = False

    async def end_during_heartbeat(claim):
        nonlocal injected
        if not injected:
            injected = True
            bridge.emit(Ended())
            await asyncio.sleep(0)
        return await original(claim)

    monkeypatch.setattr(running, "_beat_or_leave", end_during_heartbeat)
    await until(lambda: backend.releases)
    assert backend.releases[0]["reason"] == "meeting_ended"


@pytest.mark.parametrize(("event", "state"), [
    (WaitingRoom(), "waiting_room"), (WaitingForHost(), "waiting_for_host"),
])
async def test_waiting_state_is_reported_for_the_meeting_board(running, backend, bridge, event, state):
    await joined(backend, bridge)
    bridge.emit(event)
    await until(lambda: any(beat.get("state") == state for beat in backend.heartbeats))
    assert backend.heartbeats[-1]["joined"] is False


@pytest.mark.parametrize(("stored", "declared"), [(None, 0), (4, 5)])
async def test_a_new_stream_declares_the_epoch_above_the_claims(running, backend, bridge,
                                                                 stored, declared):
    # Restart rule: whatever the claim view says, a new transcript stream starts above it,
    # including a claim that comes back to a bot with its occurrence already in use.
    await until(lambda: backend.ready)
    backend.ready.clear()  # hold the claim back until it is set up
    claim = backend.send(MEETING, PASSCODE)
    if stored is not None:
        claim.occurrence_uuid, claim.epoch = OCCURRENCE, stored
        backend.highest[OCCURRENCE] = stored
    backend.ready.update({bot_id: True for bot_id in backend.bots.values()})
    backend._allocate()
    await until(lambda: backend.heartbeats)
    assert backend.heartbeats[0]["transcript_epoch"] == declared


async def test_recall_means_leave_without_a_release(running, backend, bridge):
    claim = await joined(backend, bridge)
    backend.recall(claim)
    await until(lambda: bridge.leaves == 1)
    await until(lambda: any(beat.get("state") == "idle" for beat in backend.heartbeats))
    idle = next(beat for beat in backend.heartbeats if beat.get("state") == "idle")
    assert idle == {"state": "idle", "joined": False}
    assert backend.releases == []


async def test_a_lapsed_lease_means_leave(backend, bridge, config):
    bot = make_bot(backend, bridge, config, heartbeat_seconds=0.01, lease_seconds=0.1)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    backend.down = True  # no renewal reaches the backend
    await until(lambda: bridge.leaves == 1)
    bot.stop()
    await asyncio.wait_for(task, 2)


@pytest.mark.parametrize(
    ("event", "reason"),
    [
        (Failed("waiting_room_timeout"), "waiting_room_timeout"),
        (Failed("app_cannot_join_external"), "app_cannot_join_external"),  # fail code 63, D105
        (Removed(), "removed_by_host"),  # D72
        # QOR-4887: Zoom ends a meeting only once nobody is in it, the bot included.
        (Alone(), "left_alone"),
    ],
)
async def test_a_failed_removed_or_left_meeting_is_released_without_requeue(running, backend,
                                                                            bridge, event, reason):
    await joined(backend, bridge)
    bridge.emit(event)
    await until(lambda: backend.releases)
    release = backend.releases[0]
    assert release["reason"] == reason
    assert "requeue" not in release and "meeting_ended" not in release
    assert bridge.leaves == 1


async def test_a_meeting_end_is_released_as_ended(running, backend, bridge):
    await joined(backend, bridge)
    bridge.emit(Ended())
    await until(lambda: backend.releases)
    assert backend.releases[0] == {**backend.releases[0], "reason": "meeting_ended",
                                   "meeting_ended": True}
    assert "requeue" not in backend.releases[0]


async def test_stopping_withdraws_then_requeues_the_claim(backend, bridge, config):
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    claim = await joined(backend, bridge)
    bot.stop()
    await asyncio.wait_for(task, 2)

    # Leave the meeting first (the budget's first claim), then requeue, then withdraw.
    assert backend.timeline[-3:] == ["bridge.leave", "/v1/assignment/release", "/v1/bots/ready"]
    assert backend.ready_bodies[-1]["ready"] is False
    assert backend.releases == [{"claim_id": claim.claim_id, "generation": 1,
                                 "reason": "bot_stopping", "requeue": True}]
    assert bridge.leaves == 1


async def test_stopping_while_idle_withdraws(backend, bridge, config):
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    bot.stop()
    await asyncio.wait_for(task, 2)
    assert backend.ready_bodies[-1]["ready"] is False
    assert backend.releases == []


async def test_ready_only_when_the_bridge_and_transcription_are_up(backend, bridge, config):
    transcription = {"ok": False}
    bridge.up = False

    async def transcription_ready() -> bool:
        return transcription["ok"]

    bot = make_bot(backend, bridge, config, transcription_ready=transcription_ready)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready_bodies)
    assert backend.ready_bodies[-1] == {"ready": False, "reason": "bridge_down"}
    bridge.up = True
    await until(lambda: backend.ready_bodies[-1].get("reason") == "transcription_unavailable")
    transcription["ok"] = True
    await until(lambda: backend.ready_bodies[-1] == {"ready": True})
    bot.stop()
    await asyncio.wait_for(task, 2)


async def test_promotion_keeps_the_declared_epoch(running, backend, bridge):
    claim = await joined(backend, bridge)
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: claim.occurrence_uuid == OCCURRENCE)
    assert claim.epoch == 0 and backend.highest[OCCURRENCE] == 0


async def test_occurrence_report_includes_the_sdk_meeting_title(running, backend, bridge):
    claim = await joined(backend, bridge)
    bridge.emit(OccurrenceKnown(OCCURRENCE, meeting_title='daily artifact temp meet'))
    await until(lambda: claim.occurrence_uuid == OCCURRENCE)
    request = next(r for r in backend.requests if r.path == '/v1/assignment/occurrence')
    assert request.body['meeting_title'] == 'daily artifact temp meet'


async def test_promotion_into_a_used_occurrence_declares_above_its_highest(running, backend,
                                                                          bridge):
    backend.highest[OCCURRENCE] = 3  # a vanished bot's stream
    claim = await joined(backend, bridge)
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: claim.epoch == 4)
    assert backend.heartbeats[-1]["transcript_epoch"] == 4
    # Declared straight from the promotion's answer, not after a refused heartbeat: a
    # transcript push in between would otherwise be refused too (Track 3).
    assert backend.stale_epochs == 0


async def test_an_ended_occurrence_ends_the_claim_without_a_release(running, backend, bridge):
    backend.ended_occurrences.add(OCCURRENCE)
    await joined(backend, bridge)
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: bridge.leaves == 1)
    assert backend.releases == []


async def test_a_different_occurrence_ends_the_claim_but_not_the_meeting(running, backend, bridge):
    claim = await joined(backend, bridge)
    claim.occurrence_uuid = "another-occurrence"
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: backend.releases)
    # QOR-5113: meeting_ended means Zoom said the meeting itself is over; the bot may be in
    # another occurrence that is still running.
    assert backend.releases[0]["reason"] == "occurrence_conflict"
    assert "meeting_ended" not in backend.releases[0]


async def test_joined_is_reported_in_the_heartbeat(running, backend, bridge):
    await joined(backend, bridge)
    bridge.emit(Joined())
    await until(lambda: backend.heartbeats[-1].get("joined") is True)
    assert backend.heartbeats[-1]["state"] == "in_meeting"


async def test_a_transcription_error_is_reported_in_the_heartbeat_until_it_clears(
        backend, bridge, config):
    # QOR-4738: the board shows a model key out of credit from what the bot reports.
    error: list[str | None] = ["model_out_of_credit"]
    bot = make_bot(backend, bridge, config, transcription_error=lambda: error[0])
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        await until(lambda: backend.heartbeats[-1].get("error") == "model_out_of_credit")
        error[0] = None
        await until(lambda: "error" not in backend.heartbeats[-1])
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


async def test_a_new_claim_clears_an_error_from_an_earlier_meeting(backend, bridge, config):
    # QOR-4738: credit may have been added since; the new meeting reports only its own error.
    error: list[str | None] = ["model_out_of_credit"]
    bot = make_bot(backend, bridge, config, transcription_error=lambda: error[0],
                   clear_transcription_error=lambda: error.__setitem__(0, None))
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        assert error[0] is None
        assert all("error" not in beat for beat in backend.heartbeats)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


async def test_a_recall_learned_when_joined_still_leaves(backend, bridge, config):
    # A long heartbeat interval, so the beat Joined triggers is the only one to learn of it.
    bot = make_bot(backend, bridge, config, heartbeat_seconds=60)
    task = asyncio.create_task(bot.run())
    claim = await joined(backend, bridge)
    backend.recall(claim)
    bridge.emit(Joined())
    await until(lambda: bridge.leaves == 1)
    assert backend.releases == []
    bot.stop()
    await asyncio.wait_for(task, 2)


async def test_a_lease_the_backend_lapsed_means_leave(running, backend, bridge):
    claim = await joined(backend, bridge)
    claim.lease_ok = False
    await until(lambda: bridge.leaves == 1)
    assert backend.releases == []


async def test_an_epoch_refused_mid_meeting_is_redeclared_above_the_occurrences(
        running, backend, bridge):
    claim = await joined(backend, bridge)
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: claim.occurrence_uuid == OCCURRENCE)
    claim.epoch, backend.highest[OCCURRENCE] = 6, 6  # the backend moved on without this bot
    await until(lambda: backend.heartbeats[-1].get("transcript_epoch") == 7)
    assert backend.stale_epochs >= 1 and claim.epoch == 7


async def test_a_failed_release_is_retried_and_the_claim_never_rejoined(running, backend,
                                                                        bridge):
    claim = await joined(backend, bridge)
    backend.fail_once.add("/v1/assignment/release")
    bridge.emit(Removed())
    await until(lambda: claim.state == "done")
    assert [r["reason"] for r in backend.releases] == ["removed_by_host"]
    assert len(bridge.joins) == 1


async def test_a_claim_already_let_go_is_not_joined_again(backend, bridge, config):
    # The release never lands, so the backend still shows the claim as this bot's until
    # its lease lapses; the bot gives up retrying at its own lease deadline and must not
    # walk back into a meeting it was removed from (D72).
    bot = make_bot(backend, bridge, config, lease_seconds=0.2)
    task = asyncio.create_task(bot.run())
    claim = await joined(backend, bridge)
    backend.unavailable.add("/v1/assignment/release")
    bridge.emit(Removed())
    polls = calls(backend, "/v1/assignment")
    await until(lambda: calls(backend, "/v1/assignment") > polls + 5,
                timeout=5)  # the failed releases leave a backoff of up to ~1.3 s first
    assert len(bridge.joins) == 1 and claim.state == "held"
    bot.stop()
    await asyncio.wait_for(task, 2)


async def test_a_late_event_from_an_earlier_meeting_never_acts_on_the_next(running, backend,
                                                                           bridge):
    first = await joined(backend, bridge)
    backend.recall(first)
    await until(lambda: bridge.leaves == 1)
    bridge.emit(Ended())  # arrives after the bot left
    second = backend.send("84900000001")
    await until(lambda: len(bridge.joins) == 2)
    await asyncio.sleep(0.1)
    assert backend.releases == [] and second.state == "held"


async def test_an_occurrence_is_recorded_after_a_dropped_connection(running, backend, bridge):
    claim = await joined(backend, bridge)
    backend.fail_once.add("/v1/assignment/occurrence")
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: claim.occurrence_uuid == OCCURRENCE)


async def test_an_unknown_token_registers_again(running, backend, bridge):
    await until(lambda: backend.ready)
    backend.bots.clear()  # the backend's store was reset
    await until(lambda: calls(backend, "/v1/bots/register") == 2)
    await until(lambda: backend.ready)


async def test_a_malformed_claim_is_survived(running, backend, bridge):
    await until(lambda: backend.ready)
    backend.assignment_body = {"claim_id": "x"}
    await until(lambda: calls(backend, "/v1/assignment") > 3)
    backend.assignment_body = None
    backend.send(MEETING, PASSCODE)
    await until(lambda: bridge.joins)


async def test_a_join_that_hangs_is_released_as_failed(backend, config, monkeypatch):
    class HangingBridge(FakeBridge):
        async def join(self, meeting_number, passcode, credentials=None, options=None):
            await asyncio.sleep(3600)

    monkeypatch.setattr(lifecycle, "BRIDGE_CALL_SECONDS", 0.05)
    bridge = HangingBridge(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING, PASSCODE)
    await until(lambda: backend.releases)
    assert backend.releases[0]["reason"] == "zoom_join_failed"
    assert "requeue" not in backend.releases[0]
    bot.stop()
    await asyncio.wait_for(task, 2)


def test_retries_back_off_with_jitter_and_a_cap():
    assert all(0.8 <= next_wait(1.0, 0) <= 1.2 for _ in range(100))
    waits = [next_wait(1.0, 6) for _ in range(200)]
    assert all(1.0 <= w <= lifecycle.BACKOFF_CAP_SECONDS for w in waits)
    assert max(waits) > 8  # it does grow
    assert all(next_wait(1.0, 50) <= lifecycle.BACKOFF_CAP_SECONDS for _ in range(100))



async def test_an_unconfirmed_claim_is_retried_at_a_paced_rate(running, backend, bridge):
    await until(lambda: backend.ready)
    backend.unavailable.add("/v1/assignment/heartbeat")
    backend.send(MEETING, PASSCODE)
    await until(lambda: calls(backend, "/v1/assignment/heartbeat") >= 1)
    await asyncio.sleep(0.3)
    # Paced by the 10 ms tick with backoff: tens of attempts at most, never a tight loop.
    assert calls(backend, "/v1/assignment/heartbeat") < 40


async def test_no_join_without_a_confirmed_lease(running, backend, bridge):
    # GET /assignment does not renew the lease and can return one already lapsed: only a
    # heartbeat the backend accepted makes the claim this bot's to act on.
    await until(lambda: backend.ready)
    backend.unavailable.add("/v1/assignment/heartbeat")
    backend.send(MEETING, PASSCODE)
    await until(lambda: calls(backend, "/v1/assignment/heartbeat") >= 3)
    assert bridge.joins == []
    backend.unavailable.clear()
    await until(lambda: bridge.joins)


@pytest.mark.parametrize(
    ("queued", "reason"),
    [
        ([Removed()], "removed_by_host"),
        ([Joined(), Removed()], "removed_by_host"),  # behind another event
        ([Joined(), Failed("app_cannot_join_external")], "app_cannot_join_external"),
    ],
)
async def test_a_terminal_event_queued_at_shutdown_is_not_requeued(backend, config, queued,
                                                                    reason):
    class EventsOnJoin(FakeBridge):
        async def join(self, meeting_number, passcode, credentials=None, options=None):
            await super().join(meeting_number, passcode)
            for event in queued:
                self.emit(event)
            bot.stop()  # SIGTERM lands with the events still queued

    bridge = EventsOnJoin(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING, PASSCODE)
    await asyncio.wait_for(task, 2)
    assert backend.releases[0]["reason"] == reason
    assert "requeue" not in backend.releases[0]


async def test_an_occurrence_is_recorded_after_a_server_error(running, backend, bridge):
    claim = await joined(backend, bridge)
    backend.unavailable.add("/v1/assignment/occurrence")
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: calls(backend, "/v1/assignment/occurrence") >= 2)
    backend.unavailable.clear()
    await until(lambda: claim.occurrence_uuid == OCCURRENCE)


class _StuckLeave(FakeBridge):
    async def leave(self):
        await asyncio.sleep(3600)


async def _stuck_bot(backend, config, monkeypatch):
    """A bot in a meeting whose bridge never confirms a leave: the bot, its run task and its
    claim."""
    monkeypatch.setattr(lifecycle, "BRIDGE_CALL_SECONDS", 0.05)
    bridge = _StuckLeave(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    return bridge, bot, task, await joined(backend, bridge)


async def test_a_bridge_that_cannot_leave_stops_the_bot_taking_meetings(backend, config,
                                                                        monkeypatch):
    bridge, bot, task, _ = await _stuck_bot(backend, config, monkeypatch)
    bridge.emit(Removed())
    await until(lambda: backend.ready_bodies[-1] == {"ready": False, "reason": "bridge_stuck"})
    # Possibly still in the meeting: no release that would send a second bot in.
    assert backend.releases == []
    # It withdraws and the process ends, so the orchestrator restarts it with a fresh bridge
    # (the SDK process going with it) instead of idling forever.
    await asyncio.wait_for(task, 2)
    assert bot.bridge_stuck
    assert backend.ready_bodies[-1] == {"ready": False, "reason": "bridge_stuck"}
    assert len(bridge.joins) == 1


async def test_a_meeting_that_ended_is_released_as_ended_even_when_the_leave_is_stuck(
        backend, config, monkeypatch):
    # QOR-5113: a meeting that is over cannot get a second bot, so the claim is released
    # with meeting_ended at once; the bot still exits for a fresh bridge.
    bridge, bot, task, _ = await _stuck_bot(backend, config, monkeypatch)
    bridge.emit(Ended())
    await asyncio.wait_for(task, 2)
    assert bot.bridge_stuck
    assert [(r["reason"], r.get("meeting_ended")) for r in backend.releases] == [("meeting_ended", True)]
    assert backend.ready_bodies[-1] == {"ready": False, "reason": "bridge_stuck"}


@pytest.mark.parametrize("event", [
    # A conflicting occurrence may be a live meeting the bot is still in.
    "conflict",
    # An end reason that does not say the meeting is over.
    Left("zoom_end_unknown"),
])
async def test_a_stuck_leave_from_a_meeting_that_may_still_run_holds_the_claim(
        backend, config, monkeypatch, event):
    # QOR-5113: only Zoom's own meeting end skips the leave check; releasing here would let a
    # second bot join a meeting the stuck one is still in.
    bridge, bot, task, claim = await _stuck_bot(backend, config, monkeypatch)
    if event == "conflict":
        claim.occurrence_uuid = "another/occurrence=="
        event = OccurrenceKnown(OCCURRENCE)
    bridge.emit(event)
    await asyncio.wait_for(task, 2)
    assert bot.bridge_stuck
    assert backend.releases == []


async def test_a_meeting_end_with_a_stuck_leave_is_not_released_while_the_bot_is_still_ready(
        backend, config, monkeypatch):
    # QOR-5113: the release frees the bot's slot; until it has withdrawn, a stuck bot that
    # is about to exit could be handed a new claim.
    bridge, bot, task, _ = await _stuck_bot(backend, config, monkeypatch)
    backend.unavailable.add("/v1/bots/ready")
    bridge.emit(Ended())
    await asyncio.wait_for(task, 2)
    assert bot.bridge_stuck
    assert backend.releases == []


async def test_a_stuck_bot_retries_its_meeting_end_release_for_one_backoff_then_exits(
        backend, config, monkeypatch):
    # QOR-5113: a stuck bot must exit for a fresh bridge soon, not retry until its lease lapses.
    monkeypatch.setattr(lifecycle, "BACKOFF_CAP_SECONDS", 0.2)
    bridge, bot, task, _ = await _stuck_bot(backend, config, monkeypatch)
    backend.unavailable.add("/v1/assignment/release")
    bridge.emit(Ended())
    await asyncio.wait_for(task, 2)
    assert bot.bridge_stuck
    assert calls(backend, "/v1/assignment/release") >= 1


async def test_shutdown_finishes_within_its_budget(backend, bridge, config, monkeypatch):
    monkeypatch.setattr(lifecycle, "DRAIN_SECONDS", 0.3)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    backend.unavailable.add("/v1/assignment/release")  # the requeue never lands
    bot.stop()
    await asyncio.wait_for(task, 1.5)


async def test_backend_error_text_is_never_logged(running, backend, bridge, caplog):
    caplog.set_level(logging.DEBUG)
    backend.unavailable_error = f"meeting {MEETING} token Bearer x"
    backend.unavailable.add("/v1/assignment")
    await until(lambda: calls(backend, "/v1/assignment") >= 2)
    text = "\n".join(f"{r.getMessage()} {r.__dict__}" for r in caplog.records)
    assert MEETING not in text and "Bearer" not in text



async def test_a_slow_backend_cannot_stretch_shutdown_past_its_budget(backend, bridge, config,
                                                                     monkeypatch):
    monkeypatch.setattr(lifecycle, "DRAIN_SECONDS", 0.3)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    backend.delays = {"/v1/bots/ready": 5.0, "/v1/assignment/release": 5.0,
                      "/v1/assignment/heartbeat": 5.0}
    beats = calls(backend, "/v1/assignment/heartbeat")
    await until(lambda: calls(backend, "/v1/assignment/heartbeat") > beats)  # one in flight
    bot.stop()
    started = asyncio.get_running_loop().time()
    await asyncio.wait_for(task, 2)
    assert asyncio.get_running_loop().time() - started < 0.8
    assert bridge.leaves == 1  # the time went to leaving the meeting first


async def test_a_structured_error_body_is_survived(running, backend, bridge, caplog):
    caplog.set_level(logging.DEBUG)
    backend.unavailable_error = {"detail": ["x"]}
    backend.unavailable.add("/v1/assignment")
    await until(lambda: calls(backend, "/v1/assignment") >= 3)
    backend.unavailable.clear()
    backend.send(MEETING, PASSCODE)
    await until(lambda: bridge.joins)



async def test_queued_events_at_shutdown_never_delay_leaving(backend, config, monkeypatch):
    # Production ratio: calls slower than half the drain, and two Joined queued with it.
    monkeypatch.setattr(lifecycle, "DRAIN_SECONDS", 0.3)

    class JoinedTwiceOnJoin(FakeBridge):
        async def join(self, meeting_number, passcode, credentials=None, options=None):
            await super().join(meeting_number, passcode)
            backend.delays = {"/v1/assignment/heartbeat": 0.2}
            self.emit(Joined())
            self.emit(Joined())
            bot.stop()

    bridge = JoinedTwiceOnJoin(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING, PASSCODE)
    await asyncio.wait_for(task, 2)
    assert bridge.leaves == 1
    assert backend.releases and backend.releases[-1].get("requeue") is True


async def test_a_stop_during_a_release_backoff_is_prompt(backend, bridge, config, monkeypatch):
    monkeypatch.setattr(lifecycle, "DRAIN_SECONDS", 0.05)
    bot = make_bot(backend, bridge, config, tick_seconds=0.6)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    backend.unavailable.add("/v1/assignment/release")
    bridge.emit(Removed())
    # The first attempt failed; let its answer land, so the bot is in its backoff sleep.
    await until(lambda: calls(backend, "/v1/assignment/release") >= 1)
    await asyncio.sleep(0.05)
    bot.stop()
    started = asyncio.get_running_loop().time()
    await asyncio.wait_for(task, 2)
    assert asyncio.get_running_loop().time() - started < 0.3



async def test_a_claim_that_arrives_with_a_stop_is_handed_back_unjoined(backend, bridge, config):
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    claim = backend.send(MEETING, PASSCODE)
    backend.delays = {"/v1/assignment": 0.2}
    polls = calls(backend, "/v1/assignment")
    await until(lambda: calls(backend, "/v1/assignment") > polls)  # a poll is in flight
    bot.stop()
    await asyncio.wait_for(task, 2)
    assert bridge.joins == []
    assert backend.releases == [{"claim_id": claim.claim_id, "generation": 1,
                                 "reason": "bot_stopping", "requeue": True}]


@pytest.mark.parametrize("status", [401, 408, 429])
async def test_a_transient_refusal_keeps_the_occurrence_pending(running, backend, bridge, status):
    claim = await joined(backend, bridge)
    backend.unavailable_status = status
    backend.unavailable.add("/v1/assignment/occurrence")
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: calls(backend, "/v1/assignment/occurrence") >= 2)
    backend.unavailable.clear()
    await until(lambda: claim.occurrence_uuid == OCCURRENCE)


async def test_a_stop_during_a_join_hands_the_claim_back_in_time(backend, config, monkeypatch):
    monkeypatch.setattr(lifecycle, "DRAIN_SECONDS", 0.3)

    class HangingJoin(FakeBridge):
        async def join(self, meeting_number, passcode, credentials=None, options=None):
            self.joins.append((meeting_number, passcode))
            await asyncio.sleep(3600)

    bridge = HangingJoin(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING, PASSCODE)
    await until(lambda: bridge.joins)
    bot.stop()
    started = asyncio.get_running_loop().time()
    await asyncio.wait_for(task, 2)
    assert asyncio.get_running_loop().time() - started < 0.8
    # Cut short by the stop, not a failed join: requeued, not counted as a failure.
    assert backend.releases[-1]["requeue"] is True


async def test_a_stop_while_holding_a_claim_is_noticed_at_once(backend, bridge, config,
                                                               monkeypatch):
    monkeypatch.setattr(lifecycle, "DRAIN_SECONDS", 0.5)
    bot = make_bot(backend, bridge, config, tick_seconds=0.6, heartbeat_seconds=60)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    await asyncio.sleep(0.05)  # waiting on meeting events for up to a tick
    bot.stop()
    started = asyncio.get_running_loop().time()
    await asyncio.wait_for(task, 2)
    assert asyncio.get_running_loop().time() - started < 0.3
    assert backend.releases[-1]["requeue"] is True


async def test_a_stop_during_the_first_heartbeat_hands_the_claim_back(backend, bridge, config, monkeypatch):
    monkeypatch.setattr(lifecycle, "IN_FLIGHT_SECONDS", 0.05)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.delays = {"/v1/assignment/heartbeat": 5.0}
    claim = backend.send(MEETING, PASSCODE)
    await until(lambda: calls(backend, "/v1/assignment/heartbeat") >= 1)  # in flight
    bot.stop()
    await asyncio.wait_for(task, 3)
    assert bridge.joins == []
    assert backend.releases[-1] == {"claim_id": claim.claim_id, "generation": 1,
                                    "reason": "bot_stopping", "requeue": True}


async def test_a_join_that_raises_is_released_and_the_bot_keeps_running(backend, config):
    class BrokenJoin(FakeBridge):
        async def join(self, meeting_number, passcode, credentials=None, options=None):
            raise RuntimeError("sdk process gone")

    bridge = BrokenJoin(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING, PASSCODE)
    await until(lambda: backend.releases)
    assert backend.releases[0]["reason"] == "zoom_join_failed"
    assert not task.done()  # still polling for the next meeting
    bot.stop()
    await asyncio.wait_for(task, 2)


async def test_a_bridge_that_fails_mid_meeting_releases_the_claim(backend, config):
    class BrokenEvents(FakeBridge):
        async def next_event(self):
            raise RuntimeError("socket closed")

    bridge = BrokenEvents(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    await until(lambda: backend.releases)
    assert backend.releases[0]["reason"] == "bridge_failed"
    assert not task.done()
    bot.stop()
    await asyncio.wait_for(task, 2)


async def test_a_leave_that_raises_is_treated_as_stuck(backend, config):
    class BrokenLeave(FakeBridge):
        async def leave(self):
            raise RuntimeError("sdk process gone")

    bridge = BrokenLeave(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    bridge.emit(Removed())
    await until(lambda: backend.ready_bodies[-1] == {"ready": False, "reason": "bridge_stuck"})
    assert backend.releases == []
    bot.stop()
    await asyncio.wait_for(task, 2)


async def test_a_requeue_after_a_cut_first_heartbeat_is_retried(backend, bridge, config, monkeypatch):
    monkeypatch.setattr(lifecycle, "IN_FLIGHT_SECONDS", 0.05)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.delays = {"/v1/assignment/heartbeat": 5.0}
    backend.fail_once.add("/v1/assignment/release")  # the first requeue attempt is dropped
    claim = backend.send(MEETING, PASSCODE)
    await until(lambda: calls(backend, "/v1/assignment/heartbeat") >= 1)
    bot.stop()
    await asyncio.wait_for(task, 3)
    assert backend.releases[-1] == {"claim_id": claim.claim_id, "generation": 1,
                                    "reason": "bot_stopping", "requeue": True}


async def test_no_request_is_sent_without_a_bot_token(backend, bridge, config, monkeypatch):
    monkeypatch.setattr(lifecycle, "IN_FLIGHT_SECONDS", 0.05)
    backend.delays = {"/v1/bots/register": 5.0}
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: calls(backend, "/v1/bots/register") >= 1)
    bot.stop()  # before any token exists
    await asyncio.wait_for(task, 3)
    assert [r.path for r in backend.requests] == ["/v1/bots/register"]
    assert all(r.authorization != "Bearer None" for r in backend.requests)



async def test_a_persistent_401_registers_again_at_a_backed_off_rate(backend, bridge, config):
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.reject_bot_tokens = True
    registered = calls(backend, "/v1/bots/register")
    await asyncio.sleep(0.4)
    # The 10 ms tick with no backoff would register ~40 ghost bots here.
    assert calls(backend, "/v1/bots/register") - registered < 12
    bot.stop()
    await asyncio.wait_for(task, 3)


async def test_an_undecodable_response_is_survived(running, backend, bridge):
    await until(lambda: backend.ready)
    backend.undecodable_once.add("/v1/assignment")
    await until(lambda: not backend.undecodable_once)
    backend.send(MEETING, PASSCODE)
    await until(lambda: bridge.joins)


async def test_a_reason_the_backend_would_refuse_is_released_as_bridge_failed(running, backend,
                                                                              bridge):
    await joined(backend, bridge)
    bridge.emit(Failed("Join Failed: code 63!"))
    await until(lambda: backend.releases)
    assert backend.releases[-1]["reason"] == "bridge_failed"
    assert backend.releases[-1] == {**backend.releases[-1], "reason": "bridge_failed"}


async def test_promotion_into_an_epoch_already_used_redeclares_at_once(backend, bridge, config):
    # Another holder already used epoch 0 in this occurrence; this bot declared 0 too. The
    # promotion's view shows 0 as well, so only a heartbeat can tell the claim's epoch was
    # dropped. A long heartbeat interval proves the re-declare does not wait for it.
    backend.highest[OCCURRENCE] = 0
    bot = make_bot(backend, bridge, config, heartbeat_seconds=60)
    task = asyncio.create_task(bot.run())
    claim = await joined(backend, bridge)
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: claim.epoch == 1)
    bot.stop()
    await asyncio.wait_for(task, 3)



async def test_a_promote_backoff_never_carries_over_to_the_next_claim(backend, bridge, config,
                                                                      monkeypatch):
    # The failed promotion's backoff (the first one) is 5 s; every later wait is the tick, so
    # the second claim starts well inside that window and must not inherit it.
    long_waits = [5.0]

    def wait(tick, failures):
        return long_waits.pop() if failures and long_waits else tick

    monkeypatch.setattr(lifecycle, "next_wait", wait)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    first = await joined(backend, bridge)
    backend.unavailable.add("/v1/assignment/occurrence")
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: calls(backend, "/v1/assignment/occurrence") >= 1)
    backend.recall(first)
    await until(lambda: bridge.leaves == 1)
    backend.unavailable.clear()
    second = backend.send("84900000003")
    await until(lambda: len(bridge.joins) == 2)
    bridge.emit(OccurrenceKnown("another-occurrence"))
    await until(lambda: second.occurrence_uuid == "another-occurrence", timeout=1.0)
    bot.stop()
    await asyncio.wait_for(task, 3)


async def test_an_accepted_heartbeat_renews_whatever_its_body(running, backend, bridge):
    # The 2xx is the renewal; a reply body this client cannot parse must not undo it.
    await until(lambda: backend.ready)
    backend.heartbeat_body = {"claim_id": "changed", "generation": "not-a-number"}
    backend.send(MEETING, PASSCODE)
    await until(lambda: bridge.joins)


async def test_an_accepted_heartbeat_renews_even_with_a_body_that_is_not_json(running, backend,
                                                                              bridge):
    await until(lambda: backend.ready)
    backend.heartbeat_body = b"<html>proxy page</html>"
    backend.send(MEETING, PASSCODE)
    await until(lambda: bridge.joins)


async def test_a_stop_is_never_lost_to_the_call_shortening(backend, bridge, config,
                                                           monkeypatch):
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)

    def failing_stop_by(deadline, in_flight_by):
        raise RuntimeError("timeout already expiring")

    monkeypatch.setattr(bot._backend, "stop_by", failing_stop_by)
    bot.stop()  # must still stop the bot
    await asyncio.wait_for(task, 2)


async def test_an_expiring_call_timeout_cannot_break_stop_by(config):
    from bwat_bot.backend import BackendClient

    class Expiring:
        def when(self):
            return 1.0

        def reschedule(self, when):
            raise RuntimeError("Cannot change state of expiring Timeout")

    client = BackendClient(config)
    client._active.add(Expiring())
    client.stop_by(10.0, 0.5)  # must not raise
    await client.aclose()


@pytest.mark.parametrize("status", [400, 401, 403])
async def test_a_rejected_fleet_credential_ends_the_run(backend, bridge, config, status):
    backend.unavailable_status = status
    backend.unavailable_error = "unauthorized"
    backend.unavailable.add("/v1/bots/register")
    bot = make_bot(backend, bridge, config)
    await asyncio.wait_for(bot.run(), 2)  # ends by itself: no retry can fix it
    assert bot.credential_rejected
    assert calls(backend, "/v1/bots/register") == 1


async def test_a_transient_registration_failure_is_retried(backend, bridge, config):
    backend.fail_once.add("/v1/bots/register")
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    assert not bot.credential_rejected
    bot.stop()
    await asyncio.wait_for(task, 2)


@pytest.mark.parametrize(
    ("event", "reason"),
    [(Removed(), "removed_by_host"),
     (Failed("app_cannot_join_external"), "app_cannot_join_external")],
)
async def test_a_terminal_event_during_a_pending_join_outranks_sigterm(backend, config,
                                                                     event, reason):
    class PendingJoin(FakeBridge):
        async def join(self, meeting_number, passcode, credentials=None, options=None):
            self.joins.append((meeting_number, passcode))
            self.emit(event)  # Zoom already refused or removed the bot...
            bot.stop()        # ...when SIGTERM lands, with the join still pending
            await asyncio.sleep(3600)

    bridge = PendingJoin(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING, PASSCODE)
    await asyncio.wait_for(task, 3)
    assert backend.releases[0]["reason"] == reason
    assert "requeue" not in backend.releases[0]


async def test_a_failing_first_heartbeat_backs_off_across_polls(running, backend, bridge):
    # Each poll succeeds, so only a per-claim failure count can make the retries slow down.
    await until(lambda: backend.ready)
    backend.unavailable.add("/v1/assignment/heartbeat")
    backend.send(MEETING, PASSCODE)
    await until(lambda: calls(backend, "/v1/assignment/heartbeat") >= 1)
    await asyncio.sleep(0.6)
    # With no backoff (10 ms tick) this is ~40 attempts; with it, the gaps double each time.
    assert calls(backend, "/v1/assignment/heartbeat") < 15


async def test_a_claim_that_vanished_unconfirmed_leaves_no_backoff(backend, bridge, config,
                                                                   monkeypatch):
    # Any failure backs off a full second, so a lingering per-claim count shows up as a
    # second's delay before the next meeting is picked up.
    monkeypatch.setattr(lifecycle, "next_wait", lambda tick, failures: 1.0 if failures else tick)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.unavailable.add("/v1/assignment/heartbeat")
    first = backend.send(MEETING, PASSCODE)
    await until(lambda: calls(backend, "/v1/assignment/heartbeat") >= 1)
    backend.recall(first)  # the claim goes away while unconfirmed
    backend.unavailable.clear()
    polls = calls(backend, "/v1/assignment")
    await until(lambda: calls(backend, "/v1/assignment") > polls, timeout=3)  # answers no claim
    backend.send("84900000004")
    await until(lambda: bridge.joins, timeout=0.5)  # idle pace again, not the backoff
    bot.stop()
    await asyncio.wait_for(task, 3)


async def holding_two_unpushed_segments(backend, bridge, config):
    """A bot in a recorded meeting with two segments queued and not yet pushed."""
    bot = make_bot(backend, bridge, config, push_linger_seconds=60.0)
    task = asyncio.create_task(bot.run())
    claim = await joined(backend, bridge)
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: claim.occurrence_uuid == OCCURRENCE)
    for seq in (0, 1):
        bot.segments.put_nowait(Segment(seq, "Speaker 1", f"line {seq}", seq, seq + 1))
    await asyncio.sleep(0.05)  # the push is lingering for more
    return bot, task


async def test_stopping_pushes_what_is_queued_then_leaves_and_requeues(backend, bridge, config):
    bot, task = await holding_two_unpushed_segments(backend, bridge, config)
    assert backend.pushes == []
    bot.stop()
    await asyncio.wait_for(task, 2)
    (push,) = backend.pushes
    assert [s["seq"] for s in push["segments"]] == [0, 1] and push["complete"] is False
    pushed = max(i for i, p in enumerate(backend.timeline) if p.endswith("/transcript"))
    assert pushed < backend.timeline.index("bridge.leave") < backend.timeline.index(
        "/v1/assignment/release")
    assert backend.releases[-1]["requeue"] is True


async def test_stopping_with_the_backend_down_still_ends_in_time(backend, bridge, config,
                                                                 monkeypatch):
    monkeypatch.setattr(lifecycle, "DRAIN_SECONDS", 0.5)
    bot, task = await holding_two_unpushed_segments(backend, bridge, config)
    backend.down = True
    bot.stop()
    await asyncio.wait_for(task, 1.0)
    assert bridge.leaves == 1


class TokenBridge(FakeBridge):
    """A bridge that, like the Zoom one, asks the backend for its join tokens."""

    tokens: dict | None = None

    async def join(self, meeting_number, passcode, credentials=None, options=None):
        self.tokens = await credentials()
        await super().join(meeting_number, passcode)


async def test_the_join_asks_the_backend_for_the_claims_zoom_tokens(backend, config):
    bridge = TokenBridge(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    try:
        claim = await joined(backend, bridge)
        (request,) = [r for r in backend.requests if r.path == "/v1/assignment/join-token"]
        assert request.body == {"claim_id": claim.claim_id, "generation": claim.generation}
        assert bridge.tokens["sdk_jwt"] == backend.join_tokens["sdk_jwt"]
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


async def test_a_backend_outage_at_the_join_token_is_a_failed_join_not_bad_credentials(backend, config):
    # Any 503 from the backend or a proxy in front of it: only the two configuration codes
    # mean the Zoom credentials themselves are the problem.
    backend.unavailable.add("/v1/assignment/join-token")
    backend.unavailable_error = "unavailable"
    bridge = TokenBridge(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    try:
        await until(lambda: backend.ready)
        backend.send(MEETING, PASSCODE)
        await until(lambda: backend.releases)
        assert backend.releases[0]["reason"] == "zoom_join_failed"
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


async def test_no_zoom_app_configured_releases_as_sdk_auth_failed(backend, config):
    backend.unavailable.add("/v1/assignment/join-token")
    backend.unavailable_error = "not_configured"
    bridge = TokenBridge(timeline=backend.timeline)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    try:
        await until(lambda: backend.ready)
        backend.send(MEETING, PASSCODE)
        await until(lambda: backend.releases)
        assert backend.releases[0]["reason"] == "sdk_auth_failed"
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)
