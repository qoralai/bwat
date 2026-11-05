"""The seam between the bot and the meeting: the Zoom SDK process in production (Track 4),
FakeBridge in tests and the local stack."""
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Joined:
    """The bot is in the meeting."""


@dataclass(frozen=True)
class OccurrenceKnown:
    """Zoom told the bot which occurrence of the meeting it is in."""

    occurrence_uuid: str
    meeting_title: str | None = None


@dataclass(frozen=True)
class Failed:
    """The join or the recording grant failed; `reason` is a release reason code."""

    reason: str


@dataclass(frozen=True)
class Removed:
    """A person removed the bot from the meeting (D72)."""


@dataclass(frozen=True)
class Ended:
    """The meeting ended."""


@dataclass(frozen=True)
class Left:
    """Zoom took the bot out for a reason that does not say the meeting is over (QOR-5113);
    `reason` is a release reason code. People may still be in it."""

    reason: str


@dataclass(frozen=True)
class Alone:
    """Everyone else has left: Zoom ends a meeting only once nobody is in it, the bot
    included (QOR-4887)."""


@dataclass(frozen=True)
class WaitingRoom:
    """The bot is in the meeting's waiting room."""


@dataclass(frozen=True)
class WaitingForHost:
    """The meeting has not been started by its host."""


@dataclass(frozen=True)
class ChatMessage:
    """Someone other than the bot wrote in the meeting chat."""

    sender: str
    text: str


BridgeEvent = (Joined | OccurrenceKnown | Failed | Removed | Ended | Left | Alone | WaitingRoom
               | WaitingForHost | ChatMessage)


@dataclass(frozen=True)
class JoinOptions:
    """How the bot joins (D166): its name, whether to hear each participant's own stream as
    well as the mixed one, and the I420 frame it shows as its video, if any. It always
    joins unmuted, as it never speaks, with its camera on to show that frame."""

    display_name: str = "bwat"
    per_participant: bool = True  # D184; always True in the bot (QOR-5121), False only in tests
    presence_frame: str | None = None


class Bridge(Protocol):
    def is_up(self) -> bool:
        """The bridge can take a join (the SDK process is listening and authenticated)."""

    async def join(self, meeting_number: str, passcode: str | None,
                   credentials: Callable[[], Awaitable[dict]] | None = None,
                   options: JoinOptions | None = None) -> None:
        """Starts a join and returns; the outcome comes as an event. Events still queued
        from an earlier meeting are discarded, so they never act on this claim.
        `credentials` asks the backend for the claim's Zoom tokens, for a bridge that
        needs them."""

    async def send_chat(self, text: str) -> None:
        """Posts `text` in the meeting chat, to everyone. Raising means it was not sent."""

    async def leave(self) -> None:
        """Leaves the meeting. Safe to call when no join happened or a join failed. Raising
        or not returning means the leave is unconfirmed: the bot withdraws as stuck."""

    def audio(self) -> AsyncIterator[dict | bytes]:
        """The meeting's mixed audio once joined: first an audio_format dict
        ({"sample_rate", "channels"}), then chunks of mono 16-bit little-endian PCM. It
        ends when the meeting's audio does."""

    async def next_event(self) -> BridgeEvent:
        """The next meeting event. Raising means the bridge is gone: the bot releases the
        claim as `bridge_failed`."""
