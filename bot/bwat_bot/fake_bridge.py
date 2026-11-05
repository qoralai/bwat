"""A bridge with no meeting behind it, for tests and the local stack (BWAT_BRIDGE=fake).
It records joins and leaves in memory and lets a test emit meeting events. Given a WAV file
(mono, 16-bit), it plays it as the meeting's audio."""
import asyncio
import base64
import secrets
import wave
from collections.abc import AsyncIterator
from pathlib import Path

from bwat_bot.bridge import BridgeEvent, Joined, OccurrenceKnown

CHUNK_MS = 100


class FakeBridge:
    def __init__(self, up: bool = True, auto_join: bool = False,
                 timeline: list[str] | None = None, audio: Path | None = None) -> None:
        self.up = up
        self.timeline = timeline if timeline is not None else []  # shared with a test's log
        # The local stack: report Joined right after a join, then a fresh occurrence,
        # shaped like Zoom's (base64 of 16 bytes), as the SDK does once in the meeting.
        self.auto_join = auto_join
        self.joins: list[tuple[str, str | None]] = []
        self.leaves = 0
        self.chats: list[str] = []  # what the bot posted in the meeting chat
        self._audio = audio
        self._events: asyncio.Queue[BridgeEvent] = asyncio.Queue()

    def is_up(self) -> bool:
        return self.up

    def emit(self, event: BridgeEvent) -> None:
        self._events.put_nowait(event)

    async def join(self, meeting_number: str, passcode: str | None, credentials=None,
                   options=None) -> None:
        while not self._events.empty():  # nothing from an earlier meeting carries over
            self._events.get_nowait()
        self.joins.append((meeting_number, passcode))
        if self.auto_join:
            self.emit(Joined())
            self.emit(OccurrenceKnown(base64.b64encode(secrets.token_bytes(16)).decode()))

    async def send_chat(self, text: str) -> None:
        self.chats.append(text)

    async def leave(self) -> None:
        self.leaves += 1
        self.timeline.append("bridge.leave")

    async def audio(self) -> AsyncIterator[dict | bytes]:
        if self._audio is None:
            return
        with wave.open(str(self._audio), "rb") as wav:
            rate = wav.getframerate()
            yield {"sample_rate": rate, "channels": 1}
            while chunk := wav.readframes(rate * CHUNK_MS // 1000):
                yield chunk
                await asyncio.sleep(0)

    async def next_event(self) -> BridgeEvent:
        return await self._events.get()
