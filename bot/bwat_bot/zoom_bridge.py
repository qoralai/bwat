"""The bridge to the Zoom Meeting SDK app (Track 4): a WebSocket to the in-container bridge
(bot/container/bridge.py) on 127.0.0.1:8770, one connection per meeting.

The join carries the Meeting SDK JWT and the local recording token the backend mints for
the claim (POST /v1/assignment/join-token), so the bot never holds the Zoom app's secret.
The SDK app reports raw numbers; what they mean is decided here. Logs carry event names
and codes only: never a token, meeting number, passcode or participant name.
"""
import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from bwat_bot.bridge import (
    Alone,
    BridgeEvent,
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

log = logging.getLogger("bwat_bot")

HOST, PORT = "127.0.0.1", 8770
READY = Path("/tmp/bwat-bridge.ready")  # written by the in-container bridge once it listens
# Two minutes of the SDK's audio (32 kHz, 16-bit, mono) may wait for transcription; past
# that, new audio is dropped rather than held, so a stalled route cannot grow memory for
# the rest of the meeting.
AUDIO_BACKLOG_BYTES = 32_000 * 2 * 120
# How long the audio still runs after Zoom's meeting end. The capture socket and the status
# lines travel apart, so audio said just before the end can arrive just after it; past
# this, the audio ends and the final drain takes only what is queued (QOR-5113).
END_GRACE_SECONDS = 0.5
# The SDK's MeetingStatus (meeting_service_interface.h, SDK 7.0.2.5001; positional).
WAITING_FOR_HOST, IN_MEETING, FAILED, ENDED, IN_WAITING_ROOM = 2, 3, 6, 7, 11
# MeetingEndReason with status ENDED (meeting_service_interface.h, SDK 7.0.2.5001).
KICKED_BY_HOST, AUTHORIZED_USER_LEFT = 1, 8
# The reasons that say the meeting itself is over: ended by the host, the join-before-host
# limit, no attendee, the host started another, the free-meeting limit. Any other (none,
# undefined, the authorized user left) may leave the meeting running (QOR-5113).
MEETING_OVER = {2, 3, 4, 5, 6}
# MeetingFailCode -> release reason (backend README, release reasons).
FAIL_REASONS = {
    1: "unable_to_connect", 2: "unable_to_connect", 3: "unable_to_connect",
    5: "unable_to_connect", 7: "waiting_for_host_timeout", 11: "unable_to_connect",
    15: "unable_to_connect", 50: "unable_to_connect", 63: "app_cannot_join_external",
    501: "obf_user_not_in_meeting", 504: "app_cannot_join_anonymously",
}

Credentials = Callable[[], Awaitable[dict]]


class ZoomBridge:
    def __init__(self, host: str = HOST, port: int = PORT, ready: Path = READY,
                 audio_backlog_bytes: int = AUDIO_BACKLOG_BYTES,
                 end_grace_seconds: float = END_GRACE_SECONDS) -> None:
        self._host, self._port, self._ready = host, port, ready
        self._end_grace = end_grace_seconds
        self._backlog = _Backlog(audio_backlog_bytes)
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task | None = None
        self._events: asyncio.Queue[BridgeEvent] = asyncio.Queue()
        self._audio: asyncio.Queue[dict | bytes | None] = asyncio.Queue()

    def is_up(self) -> bool:
        """The in-container bridge is listening."""
        return self._ready.exists()

    async def join(self, meeting_number: str, passcode: str | None,
                   credentials: Credentials | None = None,
                   options: JoinOptions | None = None) -> None:
        options = options or JoinOptions()
        tokens = await credentials()  # minted per join: the recording token lasts 2 min
        await self._close()
        self._events, self._audio = asyncio.Queue(), asyncio.Queue()
        self._backlog = _Backlog(self._backlog.limit)
        self._ws = await connect(f"ws://{self._host}:{self._port}", max_size=None,
                                 compression=None)
        await self._ws.send(json.dumps({
            "type": "join", "meeting_number": meeting_number, "passcode": passcode or "",
            "display_name": options.display_name, "jwt": tokens["sdk_jwt"],
            "join_token": tokens.get("recording_token"), "per_participant": options.per_participant,
            "presence_frame": options.presence_frame}))
        self._reader = asyncio.create_task(self._read(self._ws, self._events, self._audio, self._backlog,
                                                      self._end_grace))

    async def send_chat(self, text: str) -> None:
        """Asks the bridge to post `text` in the meeting chat; Zoom's answer comes back as a
        chat_sent status, logged by its code."""
        await self._ws.send(json.dumps({"type": "send_chat", "text": text}))

    async def leave(self) -> None:
        """Asks the bridge to leave and waits for it to close the meeting's connection."""
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps({"type": "leave"}))
        except ConnectionClosed:
            pass
        await ws.wait_closed()
        self._ws = None

    async def next_event(self) -> BridgeEvent:
        return await self._events.get()

    async def audio(self) -> AsyncIterator[dict | bytes]:
        audio, backlog = self._audio, self._backlog
        while (item := await audio.get()) is not None:
            if isinstance(item, dict):
                yield {"sample_rate": item["sample_rate"], "channels": item.get("channels", 1)}
            else:
                backlog.bytes -= len(item) if isinstance(item, bytes) else len(item[2])
                yield item

    async def _close(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
        if self._ws is not None:
            await self._ws.close()
        self._ws = self._reader = None

    @staticmethod
    async def _read(ws: ClientConnection, events: asyncio.Queue, audio: asyncio.Queue,
                    backlog: "_Backlog", end_grace: float) -> None:
        """The meeting's connection: PCM to `audio`, meaning to `events`. The bridge
        closes it once the SDK app has exited; a close with no ending reported first means
        the app died, which is not a meeting end. With per-participant audio each binary
        message is [u32 node LE][pcm]: node 0, the mix, is dropped, and the rest are named
        from the participant lines, which also tell when everyone else has left."""
        over, framed, names, others = False, False, {}, set()
        loop = asyncio.get_running_loop()
        heard_until: float | None = None  # past this, the meeting's audio has ended
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    if heard_until is not None and loop.time() >= heard_until:
                        continue  # the meeting is over and its audio ended: nobody reads it
                    node = int.from_bytes(message[:4], "little") if framed else None
                    if node == 0:
                        continue  # the mix, when each participant also comes on its own
                    pcm = message[4:] if framed else message
                    if backlog.bytes + len(pcm) > backlog.limit:
                        backlog.dropped += 1
                        if backlog.dropped == 1:
                            log.warning("zoom.audio_backlog_full", extra={"limit_bytes": backlog.limit})
                        continue
                    backlog.bytes += len(pcm)
                    audio.put_nowait((node, names.get(node, f"Participant {node}"), pcm) if framed else pcm)
                elif (body := json.loads(message)).get("type") == "audio_format":
                    framed = bool(body.get("per_participant"))
                    audio.put_nowait(body)
                elif (body.get("type") == "participant"
                      and str(body.get("id", "")).isdigit()):  # an odd line never ends the meeting
                    node = int(body["id"])
                    if body.get("event") == "join":
                        name = body.get("name")
                        names[node] = name if isinstance(name, str) and name else f"Participant {node}"
                        if body.get("is_self") is not True:
                            others.add(node)
                    elif body.get("event") == "leave" and node in others:
                        others.discard(node)
                        if not others:  # Zoom keeps the meeting open while the bot is in it
                            events.put_nowait(Alone())
                elif (event := _meaning(body)) is not None:
                    over = over or isinstance(event, Ended | Removed | Left | Failed)
                    if over and heard_until is None:
                        # Zoom's end ends the audio after the grace, so the final drain waits
                        # only for what was said, not for the app to exit (QOR-5113). Any
                        # other ending takes no more audio; the close ends the stream.
                        grace = end_grace if isinstance(event, Ended) else 0.0
                        heard_until = loop.time() + grace
                        if isinstance(event, Ended):
                            loop.call_later(grace, audio.put_nowait, None)
                    events.put_nowait(event)
        except ConnectionClosed:
            pass
        finally:
            audio.put_nowait(None)
            if not over:
                events.put_nowait(Failed("bridge_failed"))


class _Backlog:
    """Audio bytes read from the bridge and not yet taken for transcription."""

    def __init__(self, limit: int) -> None:
        self.limit, self.bytes, self.dropped = limit, 0, 0


def _meaning(body: dict) -> BridgeEvent | None:
    """A bridge message as a meeting event, or None when it changes nothing."""
    kind, event = body.get("type"), body.get("event")
    if kind == "chat":
        sender, text = body.get("from"), body.get("text")
        # An odd line is skipped: it must never end the meeting.
        if not (isinstance(sender, str) and isinstance(text, str) and text):
            return None
        # Zoom may give no name; the backend refuses an empty speaker, which would lose a batch.
        return ChatMessage(sender or "Someone in chat", text)
    if kind != "sdk_status":
        return None
    if event == "meeting_id" and body.get("meeting_uuid"):
        topic = body.get("meeting_topic")
        title = " ".join(topic.split())[:200] if isinstance(topic, str) else None
        return OccurrenceKnown(str(body["meeting_uuid"]), title or None)
    if event == "meeting" and body.get("status") == IN_WAITING_ROOM:
        return WaitingRoom()
    if event == "meeting" and body.get("status") == WAITING_FOR_HOST:
        return WaitingForHost()
    if event == "meeting" and body.get("status") == IN_MEETING:
        return Joined()
    if event == "meeting" and body.get("status") == ENDED:
        code = body.get("code")
        if code == KICKED_BY_HOST:
            return Removed()
        if code in MEETING_OVER:
            return Ended()
        log.warning("zoom.left_meeting", extra={"error": str(code)})
        if code == AUTHORIZED_USER_LEFT:
            return Left("authorized_user_left")
        return Left("zoom_end_unknown")
    if event == "meeting" and body.get("status") == FAILED:
        log.error("zoom.join_failed", extra={"error": str(body.get("code"))})
        return Failed(FAIL_REASONS.get(body.get("code"), "zoom_join_failed"))
    if event == "chat_sent":
        if body.get("code") == 0:
            log.info("zoom.chat_sent")
        else:  # 18: Zoom's limit on chat posts per sender
            log.warning("zoom.chat_failed", extra={"error": str(body.get("code"))})
        return None
    if event == "auth":
        log.error("zoom.auth_failed", extra={"error": str(body.get("code"))})
        return Failed("sdk_auth_failed")
    if event == "join_call":
        log.error("zoom.join_call_failed", extra={"error": str(body.get("code"))})
        return Failed("zoom_join_failed")
    return None
