"""D155/D166 on the bridge: the join carries the served name and options, per-participant
audio is always on (QOR-5121: the bot needs it to tell that everyone else has left), and a
bot kept waiting (waiting room 15 min, no host 10 min) gives the meeting back."""
import asyncio
import dataclasses

import pytest

from bwat_bot.bridge import Joined, JoinOptions, WaitingForHost, WaitingRoom
from bwat_bot.config import Config
from bwat_bot.settings import SettingsPoller
from tests.conftest import Clock, joined, make_bot, until
from tests.fake_asr import config_for


@pytest.fixture
def options_seen(bridge):
    seen: list[JoinOptions] = []
    join = bridge.join

    async def recording_join(meeting_number, passcode, credentials=None, options=None):
        seen.append(options)
        await join(meeting_number, passcode, credentials, options)

    bridge.join = recording_join
    return seen


# Every join shows a presence frame: the override, the admin's picture or the bundled logo
# (test_presence_setting.py).
@pytest.mark.parametrize(("served", "env", "expected"), [
    ({}, {}, JoinOptions("bwat", True)),
    ({"display_name": "Acme notes", "join_muted": True, "join_video_off": True},
     {}, JoinOptions("Acme notes", True)),
    ({}, {"BWAT_BOT_PRESENCE_IMAGE": "/app/presence.png"}, JoinOptions("bwat", True)),
])
async def test_the_join_carries_the_served_options(backend, bridge, options_seen, served, env,
                                                   expected, frame_path):
    expected = dataclasses.replace(expected, presence_frame=str(frame_path))
    backend.settings_values = served
    config = Config.from_env({"BWAT_BACKEND_URL": f"https://{backend.host}",
                              "BWAT_FLEET_CREDENTIAL": backend.fleet_credential, **env})
    bot = make_bot(backend, bridge, config, settings=SettingsPoller(every=0.01))
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)
    assert options_seen == [expected]


async def advance(clock: Clock, seconds: float) -> None:
    """Moves the clock in 10 s steps, so heartbeats keep the lease as they would."""
    for _ in range(int(seconds // 10)):
        clock.now += 10
        await asyncio.sleep(0.005)
    clock.now += seconds % 10
    await asyncio.sleep(0.02)


@pytest.mark.parametrize(("event", "minutes", "reason"), [
    (WaitingRoom(), 15, "waiting_room_timeout"),
    (WaitingForHost(), 10, "waiting_for_host_timeout"),
])
async def test_a_bot_kept_waiting_gives_the_meeting_back(backend, bridge, config, event,
                                                          minutes, reason):
    clock = Clock()
    bot = make_bot(backend, bridge, config, clock=clock)
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(event)
        await asyncio.sleep(0.05)
        await advance(clock, 60 * minutes - 5)
        assert backend.releases == []
        await advance(clock, 10)
        await until(lambda: backend.releases)
        assert backend.releases[0]["reason"] == reason
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


@pytest.mark.parametrize(("served", "event", "minutes", "reason"), [
    ({"waiting_room_min": 3}, WaitingRoom(), 3, "waiting_room_timeout"),
    ({"wait_for_start_min": 2}, WaitingForHost(), 2, "waiting_for_host_timeout"),
])
async def test_the_waits_are_the_admins_settings(backend, bridge, config, served, event,
                                                 minutes, reason):
    backend.settings_values = served
    clock = Clock()
    bot = make_bot(backend, bridge, config, clock=clock, settings=SettingsPoller(every=0.01))
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(event)
        await asyncio.sleep(0.05)
        await advance(clock, 60 * minutes + 5)
        await until(lambda: backend.releases)
        assert backend.releases[0]["reason"] == reason
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


@pytest.mark.parametrize(("served", "event", "reason"), [
    ({"wait_for_start_min": 0}, WaitingForHost(), "waiting_for_host_timeout"),
    ({"waiting_room_min": 0}, WaitingRoom(), "waiting_room_timeout"),
])
async def test_0_means_no_limit_on_that_wait(backend, bridge, config, served, event, reason):
    backend.settings_values = served
    clock = Clock()
    bot = make_bot(backend, bridge, config, clock=clock, settings=SettingsPoller(every=0.01))
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(event)
        await asyncio.sleep(0.05)
        await advance(clock, 60 * 120)
        assert not any(r.get("reason") == reason for r in backend.releases)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


async def test_being_let_in_stops_the_wait(backend, bridge, config):
    clock = Clock()
    bot = make_bot(backend, bridge, config, clock=clock)
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(WaitingRoom())
        bridge.emit(Joined())
        await asyncio.sleep(0.05)
        await advance(clock, 60 * 16)
        assert not any(r.get("reason") == "waiting_room_timeout" for r in backend.releases)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


WARNED = ("WARNING", "bot.per_participant_audio_switch_ignored")


@pytest.mark.parametrize(("env", "logged"), [
    ({}, []),
    ({"BWAT_PER_PARTICIPANT_AUDIO": ""}, []),  # empty is unset
    ({"BWAT_PER_PARTICIPANT_AUDIO": "0"}, [WARNED]),
    ({"BWAT_PER_PARTICIPANT_AUDIO": "1"}, [WARNED]),
    ({"BWAT_PER_PARTICIPANT_AUDIO": "yes"}, [WARNED]),  # the old check refused it
])
def test_the_removed_audio_switch_is_ignored_with_one_warning(env, logged, caplog):
    # QOR-5121: per-participant audio is always on; an install whose .env still sets the
    # switch starts as before, and says once that the switch does nothing.
    config_for(**env)
    assert [(r.levelname, r.getMessage()) for r in caplog.records if r.name == "bwat_bot"] == logged


async def test_the_latest_wait_sets_the_timer(backend, bridge, config):
    clock = Clock()
    bot = make_bot(backend, bridge, config, clock=clock)
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(WaitingForHost())
        bridge.emit(WaitingRoom())  # the host started; now the waiting room
        await asyncio.sleep(0.05)
        await advance(clock, 11 * 60)
        assert backend.releases == []
        await advance(clock, 5 * 60)
        await until(lambda: backend.releases)
        assert backend.releases[0]["reason"] == "waiting_room_timeout"
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)
