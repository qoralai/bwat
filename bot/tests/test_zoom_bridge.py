"""ZoomBridge against a stand-in for the in-container bridge (bot/container/bridge.py): the
join carries the backend's tokens, the SDK app's raw facts become meeting events, its
audio comes through in order, and a leave is sent and waited for."""
import asyncio
import json

import pytest
from websockets.asyncio.server import serve

from bwat_bot.__main__ import choose_bridge
from bwat_bot.bridge import (
    Alone,
    ChatMessage,
    Ended,
    Failed,
    Joined,
    JoinOptions,
    Left,
    OccurrenceKnown,
    Removed,
    WaitingForHost,
    WaitingRoom,
)
from bwat_bot.config import Config
from bwat_bot.fake_bridge import FakeBridge
from bwat_bot.zoom_bridge import ZoomBridge

TOKENS = {"sdk_jwt": "eyJ.sdk.jwt", "sdk_jwt_expires_at": "2026-10-03T12:30:00Z",
          "recording_token": "rec-token", "recording_token_expires_at": "2026-10-03T12:02:00Z"}
UUID = "kq8Zr1x2Tq+Ab/Cd9eFg=="
CLOSE = object()  # in a script: the bridge closes the connection there


class FakeContainerBridge:
    """Answers a join with what the SDK app would report, then waits for a leave."""

    def __init__(self, script: list) -> None:
        self.script = script
        self.received: list[dict] = []
        self.port = 0
        self._server = None

    async def __aenter__(self):
        self._server = await serve(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, ws):
        async for message in ws:
            body = json.loads(message)
            self.received.append(body)
            if body["type"] == "join":
                for item in self.script:
                    if item is CLOSE:
                        return
                    if isinstance(item, float):
                        await asyncio.sleep(item)  # a pause: what follows arrives later
                        continue
                    await ws.send(item if isinstance(item, bytes) else json.dumps(item))
            if body["type"] == "leave":
                return


async def credentials() -> dict:
    return TOKENS


async def joined_bridge(script: list, options: JoinOptions | None = None):
    fake = FakeContainerBridge(script)
    await fake.__aenter__()
    bridge = ZoomBridge(port=fake.port)
    await bridge.join("84912345678", "s3cret", credentials, options or JoinOptions(per_participant=False))
    return fake, bridge


async def event(bridge) -> object:
    return await asyncio.wait_for(bridge.next_event(), 2)


async def test_meeting_topic_travels_with_its_occurrence():
    fake, bridge = await joined_bridge([
        {"type": "sdk_status", "event": "meeting_id", "meeting_uuid": UUID,
         "meeting_topic": "daily artifact temp meet"},
    ])
    try:
        known = await event(bridge)
        assert known.occurrence_uuid == UUID
        assert known.meeting_title == "daily artifact temp meet"
    finally:
        await bridge.leave()
        await fake.__aexit__()


@pytest.mark.parametrize(('topic', 'expected'), [
    (None, None), (17, None), (' \n ', None), (' a\n b ', 'a b'), ('x' * 201, 'x' * 200),
])
async def test_optional_meeting_topic_is_normalized_without_losing_the_occurrence(topic, expected):
    fake, bridge = await joined_bridge([
        {"type": "sdk_status", "event": "meeting_id", "meeting_uuid": UUID, "meeting_topic": topic},
    ])
    try:
        assert await event(bridge) == OccurrenceKnown(UUID, expected)
    finally:
        await bridge.leave()
        await fake.__aexit__()


async def test_a_meeting_is_joined_heard_and_left():
    fake, bridge = await joined_bridge([
        {"type": "sdk_status", "event": "meeting", "status": 1, "code": 0},
        {"type": "sdk_status", "event": "meeting", "status": 3, "code": 0},
        {"type": "sdk_status", "event": "meeting_id", "meeting_uuid": UUID},
        {"type": "audio_format", "sample_rate": 32000, "channels": 1},
        b"\x01\x00" * 320, b"\x02\x00" * 320,
    ])
    try:
        assert await event(bridge) == Joined()
        assert await event(bridge) == OccurrenceKnown(UUID)
        audio = bridge.audio()
        assert await anext(audio) == {"sample_rate": 32000, "channels": 1}
        assert await anext(audio) == b"\x01\x00" * 320
        assert await anext(audio) == b"\x02\x00" * 320
        await asyncio.wait_for(bridge.leave(), 2)
    finally:
        await fake.__aexit__()
    join, leave = fake.received
    assert join == {"type": "join", "meeting_number": "84912345678", "passcode": "s3cret",
                    "display_name": "bwat", "jwt": "eyJ.sdk.jwt", "join_token": "rec-token",
                    "per_participant": False, "presence_frame": None}
    assert leave == {"type": "leave"}


async def test_audio_waiting_for_transcription_is_capped_and_the_rest_dropped():
    # A stalled transcription route must not grow memory for the rest of the meeting.
    fake = FakeContainerBridge([
        {"type": "audio_format", "sample_rate": 32000, "channels": 1},
        b"" * 640, b"" * 640, b"" * 640, b"" * 640, CLOSE])
    await fake.__aenter__()
    bridge = ZoomBridge(port=fake.port, audio_backlog_bytes=1300)
    await bridge.join("84912345678", "s3cret", credentials)
    try:
        assert await event(bridge) == Failed("bridge_failed")  # everything has been read
        heard = [item async for item in bridge.audio()]
        assert heard == [{"sample_rate": 32000, "channels": 1}, b"" * 640, b"" * 640]
    finally:
        await bridge.leave()
        await fake.__aexit__()


async def test_zoom_s_meeting_end_ends_the_audio_without_waiting_for_the_app_to_exit():
    # QOR-5113: the final drain waits for the audio to end. Ended ends it shortly after, so
    # the drain is not held until the SDK app exits and the bridge closes the connection.
    # The capture socket and the status lines travel apart: audio said before the end can
    # arrive just after it, and is still heard.
    fake, bridge = await joined_bridge([
        {"type": "audio_format", "sample_rate": 32000, "channels": 1},
        b"\x01\x00" * 320,
        {"type": "sdk_status", "event": "meeting", "status": 7, "code": 2},
        0.1,
        b"\x02\x00" * 320,
    ])
    try:
        assert await event(bridge) == Ended()
        heard = await asyncio.wait_for(_all(bridge.audio()), 2)
        assert heard == [{"sample_rate": 32000, "channels": 1}, b"\x01\x00" * 320, b"\x02\x00" * 320]
    finally:
        await bridge.leave()
        await fake.__aexit__()


async def test_audio_after_the_meeting_end_is_not_held(caplog):
    # QOR-5113: once the grace after the end has passed, nobody reads the audio; what still
    # arrives before the app exits is dropped, not held or counted against the backlog.
    fake = FakeContainerBridge([
        {"type": "audio_format", "sample_rate": 32000, "channels": 1},
        {"type": "sdk_status", "event": "meeting", "status": 7, "code": 2},
        0.2,
        b"\x01\x00" * 400, b"\x01\x00" * 400, CLOSE])
    await fake.__aenter__()
    bridge = ZoomBridge(port=fake.port, audio_backlog_bytes=1000, end_grace_seconds=0.05)
    await bridge.join("84912345678", "s3cret", credentials)
    try:
        assert await event(bridge) == Ended()
        await asyncio.wait_for(bridge._reader, 2)  # everything sent has been read
        assert "zoom.audio_backlog_full" not in caplog.text
        assert bridge._backlog.bytes == 0
        assert await asyncio.wait_for(_all(bridge.audio()), 2) == [{"sample_rate": 32000, "channels": 1}]
    finally:
        await bridge.leave()
        await fake.__aexit__()


async def _all(audio) -> list:
    return [item async for item in audio]


async def test_a_bridge_that_closes_without_an_end_is_a_failure_not_a_meeting_end():
    fake, bridge = await joined_bridge([
        {"type": "sdk_status", "event": "meeting", "status": 3, "code": 0}, CLOSE])
    try:
        assert await event(bridge) == Joined()
        assert await event(bridge) == Failed("bridge_failed")  # the SDK app died
    finally:
        await bridge.leave()
        await fake.__aexit__()


@pytest.mark.parametrize(("status", "expected"), [
    ({"event": "meeting", "status": 6, "code": 63}, Failed("app_cannot_join_external")),
    ({"event": "meeting", "status": 6, "code": 999}, Failed("zoom_join_failed")),
    ({"event": "auth", "code": 2}, Failed("sdk_auth_failed")),
    ({"event": "meeting", "status": 7, "code": 2}, Ended()),
    ({"event": "meeting", "status": 7, "code": 1}, Removed()),
    # QOR-5113: only an end reason that says the meeting itself is over is Ended
    # (MeetingEndReason, SDK 7.0.2.5001): JBH timeout, no attendee, host started another,
    # free-meeting timeout. The rest may leave the meeting running.
    ({"event": "meeting", "status": 7, "code": 3}, Ended()),
    ({"event": "meeting", "status": 7, "code": 4}, Ended()),
    ({"event": "meeting", "status": 7, "code": 5}, Ended()),
    ({"event": "meeting", "status": 7, "code": 6}, Ended()),
    ({"event": "meeting", "status": 7, "code": 8}, Left("authorized_user_left")),
    ({"event": "meeting", "status": 7, "code": 0}, Left("zoom_end_unknown")),
    ({"event": "meeting", "status": 7, "code": 7}, Left("zoom_end_unknown")),
    ({"event": "meeting", "status": 7}, Left("zoom_end_unknown")),
])
async def test_the_sdk_apps_facts_become_events(status, expected):
    fake, bridge = await joined_bridge([{"type": "sdk_status", **status}])
    try:
        assert await event(bridge) == expected
        await bridge.leave()
        await asyncio.sleep(0.05)
        assert bridge._events.empty()  # the close after an ending adds no second one
    finally:
        await fake.__aexit__()


def test_up_once_the_bridge_says_it_listens(tmp_path):
    bridge = ZoomBridge(ready=tmp_path / "ready")
    assert not bridge.is_up()
    (tmp_path / "ready").touch()
    assert bridge.is_up()


BASE = {"BWAT_BACKEND_URL": "https://backend.test", "BWAT_FLEET_CREDENTIAL": "bwf_" + "a" * 43}


def test_the_zoom_bridge_runs_anywhere_and_the_fake_only_on_a_local_stack():
    production, local = Config.from_env(BASE), Config.from_env(BASE | {"BWAT_LOCAL_STACK": "1"})
    assert isinstance(choose_bridge({"BWAT_BRIDGE": "zoom"}, production), ZoomBridge)
    assert isinstance(choose_bridge({"BWAT_BRIDGE": "fake"}, local), FakeBridge)
    assert choose_bridge({"BWAT_BRIDGE": "fake"}, production) is None
    assert choose_bridge({}, local) is None


def frame(node: int, pcm: bytes) -> bytes:
    """A per-participant frame as the bridge relays it: [u32 node LE][pcm]."""
    return node.to_bytes(4, "little") + pcm


async def test_the_join_options_reach_the_bridge_and_each_voice_is_named():
    options = JoinOptions("Acme notes", per_participant=True, presence_frame="/tmp/bwat-presence.i420")
    fake, bridge = await joined_bridge([
        {"type": "participant", "event": "join", "id": "16778240", "name": "Ada"},
        {"type": "participant", "event": "join", "id": "16779264", "name": "Grace"},
        {"type": "audio_format", "sample_rate": 32000, "channels": 1, "per_participant": True},
        frame(0, b"\x00\x01" * 4), frame(16778240, b"\x01\x00" * 4),
        frame(16779264, b"\x02\x00" * 4), frame(42, b"\x03\x00" * 4),
    ], options)
    try:
        audio = bridge.audio()
        assert await anext(audio) == {"sample_rate": 32000, "channels": 1}
        assert await anext(audio) == (16778240, "Ada", b"\x01\x00" * 4)  # node 0 skipped
        assert await anext(audio) == (16779264, "Grace", b"\x02\x00" * 4)
        assert await anext(audio) == (42, "Participant 42", b"\x03\x00" * 4)
        await bridge.leave()
    finally:
        await fake.__aexit__()
    join = fake.received[0]
    assert (join["display_name"], join["per_participant"], join["presence_frame"]) == (
        "Acme notes", True, "/tmp/bwat-presence.i420")
    assert "muted" not in join and "video_off" not in join


def person(event: str, id: str, is_self: bool = False) -> dict:
    return {"type": "participant", "event": event, "id": id, "name": "", "is_self": is_self}


async def test_the_bot_is_told_once_when_everyone_else_has_left():
    fake, bridge = await joined_bridge([
        person("join", "100", is_self=True), person("join", "1"), person("join", "2"),
        person("leave", "1"), {"type": "chat", "from": "Ada", "text": "one left"},
        person("leave", "2"), person("leave", "3"), {"type": "chat", "from": "Ada", "text": "after"},
    ])
    try:
        assert await event(bridge) == ChatMessage("Ada", "one left")  # one still here: nothing
        assert await event(bridge) == Alone()
        assert await event(bridge) == ChatMessage("Ada", "after")  # told once
        await bridge.leave()
    finally:
        await fake.__aexit__()


@pytest.mark.parametrize(("status", "expected"), [(11, WaitingRoom()), (2, WaitingForHost())])
async def test_waiting_to_be_let_in_is_reported(status, expected):
    fake, bridge = await joined_bridge([{"type": "sdk_status", "event": "meeting",
                                         "status": status, "code": 0}])
    try:
        assert await event(bridge) == expected
        await bridge.leave()
    finally:
        await fake.__aexit__()


async def test_a_chat_line_becomes_a_chat_event():
    from bwat_bot.bridge import ChatMessage
    fake, bridge = await joined_bridge([{"type": "chat", "from": "Ada", "text": "ship it friday"}])
    try:
        assert await event(bridge) == ChatMessage("Ada", "ship it friday")
        await bridge.leave()
    finally:
        await fake.__aexit__()


@pytest.mark.parametrize("line", [
    {"type": "chat", "text": "no sender"},
    {"type": "chat", "from": "Ada"},
    {"type": "chat", "from": "Ada", "text": 5},
])
def test_an_odd_chat_line_is_skipped_not_fatal(line):
    from bwat_bot.zoom_bridge import _meaning
    assert _meaning(line) is None


def test_a_chat_line_with_no_sender_name_still_has_a_speaker():
    from bwat_bot.zoom_bridge import _meaning
    assert _meaning({"type": "chat", "from": "", "text": "hi"}).sender == "Someone in chat"


async def test_a_chat_post_goes_to_the_bridge_for_everyone():
    fake, bridge = await joined_bridge([])
    try:
        await bridge.send_chat("Five minutes left.")
        await bridge.leave()
        assert fake.received[1] == {"type": "send_chat", "text": "Five minutes left."}
    finally:
        await fake.__aexit__()


def test_zoom_s_answer_to_a_chat_post_is_logged_by_its_code_only(caplog):
    from bwat_bot.zoom_bridge import _meaning
    caplog.set_level("INFO", logger="bwat_bot")
    assert _meaning({"type": "sdk_status", "event": "chat_sent", "code": 0}) is None
    assert _meaning({"type": "sdk_status", "event": "chat_sent", "code": 18}) is None  # too frequent
    assert [(r.getMessage(), r.levelname, getattr(r, "error", None)) for r in caplog.records] == [
        ("zoom.chat_sent", "INFO", None), ("zoom.chat_failed", "WARNING", "18")]
