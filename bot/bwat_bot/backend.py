"""The bwat backend's bot routes (backend/README.md, "Bots and allocations"). The bot token
is held in memory only; nothing here logs a token, meeting number or passcode."""
import asyncio
import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime
from urllib.parse import quote

import httpx

from bwat_bot.audio import Segment
from bwat_bot.config import Config
from bwat_bot.dictionary import Dictionary
from bwat_bot.egress import GuardedTransport

CALL_SECONDS = 10.0  # wall clock for a whole call; httpx's timeout is per phase
# The agenda's call waits past the backend's wait for it (cards-client.ts), which is past the
# card writer's model's deadline for its summary: without one, the agenda still arrives and
# the bot posts its count.
AGENDA_CALL_SECONDS = 25.0
BOT_TOKEN = re.compile(r"bwb_[A-Za-z0-9_-]{43}")

# The backend's segment view carries more than the bot keeps (epoch, created_at).
_SEGMENT_FIELDS = tuple(f.name for f in fields(Segment))


class BackendError(Exception):
    """A refusal the caller handles by its machine code (`409 stale_claim` and so on)."""

    def __init__(self, status: int, code: str | None) -> None:
        super().__init__(f"backend refused: {status} {code}")
        self.status = status
        self.code = code


@dataclass(frozen=True)
class Settings:
    """What every bot applies (GET /bot/settings). The backend leaves an unset setting out,
    so the bot keeps these defaults. The model keys never appear in a repr."""
    display_name: str = "bwat"
    provider_keys: Mapping[str, str] = field(default_factory=dict, repr=False)
    chat_posts_enabled: bool = False  # off until an admin turns it on
    chat_agenda_enabled: bool = False  # off, nothing posted on joining
    waiting_room_min: int = 15  # D155
    wait_for_start_min: int = 10  # 0, here and for the waiting room: no limit
    idle_leave_min: int = 5  # QOR-4893: the bot leaves after this long with nothing said
    dictionary: Dictionary = field(default_factory=Dictionary, repr=False)

    @classmethod
    def from_body(cls, body: object) -> "Settings":
        values = body.get("settings") if isinstance(body, dict) else None
        keys = body.get("providerKeys") if isinstance(body, dict) else None
        if not (isinstance(values, dict) and isinstance(keys, dict)
                and all(isinstance(k, str) and isinstance(v, str) for k, v in keys.items())):
            raise BackendError(200, "malformed_settings")
        name = values.get("display_name", cls.display_name)
        chat = values.get("chat_posts_enabled", cls.chat_posts_enabled)
        agenda = values.get("chat_agenda_enabled", cls.chat_agenda_enabled)
        room = values.get("waiting_room_min", cls.waiting_room_min)
        start = values.get("wait_for_start_min", cls.wait_for_start_min)
        idle = values.get("idle_leave_min", cls.idle_leave_min)
        if not (isinstance(name, str) and isinstance(chat, bool) and isinstance(agenda, bool)
                and all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (room, start, idle))):
            raise BackendError(200, "malformed_settings")
        try:
            served = body.get('dictionary') or {}
            dictionary = Dictionary.compile(served.get('payload') if served.get('state') == 'set' else None)
        except (ValueError, KeyError, TypeError, AttributeError):
            raise BackendError(200, 'malformed_settings') from None
        return cls(name, dict(keys), chat, agenda, room, start, idle, dictionary)


@dataclass(frozen=True)
class Claim:
    claim_id: str
    generation: int
    meeting_number: str = field(repr=False)
    passcode: str | None = field(repr=False)
    occurrence_uuid: str | None = field(repr=False)
    transcript_epoch: int | None
    feed_token: str | None = field(default=None, repr=False)  # opens the feed (feed.py)
    # When the meeting is due to end, for one with a fixed schedule; it times the chat posts.
    scheduled_end: datetime | None = field(default=None, repr=False)

    @classmethod
    def from_view(cls, view) -> "Claim":
        """A claim from the backend's view; a malformed one is a BackendError, never a crash."""
        try:
            briefing = view.get("briefing") or {}
            claim = cls(
                claim_id=str(view["claim_id"]),
                generation=int(view["generation"]),
                meeting_number=str(view["meeting_number"]),
                passcode=briefing.get("passcode"),
                occurrence_uuid=view.get("occurrence_uuid"),
                transcript_epoch=view.get("transcript_epoch"),
                feed_token=_feed_token(view),
                scheduled_end=(datetime.fromisoformat(briefing["scheduled_end"])
                               if briefing.get("scheduled_end") else None),
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            raise BackendError(200, "malformed_claim") from None
        if claim.transcript_epoch is not None and not isinstance(claim.transcript_epoch, int):
            raise BackendError(200, "malformed_claim")
        return claim

    @property
    def key(self) -> tuple[str, int]:
        """One holding of the claim: a requeue gives the same claim a new generation."""
        return self.claim_id, self.generation

    @property
    def next_epoch(self) -> int:
        """The epoch a new transcript stream declares: above the claim's, or 0."""
        return 0 if self.transcript_epoch is None else self.transcript_epoch + 1


class BackendClient:
    def __init__(self, config: Config, inner: httpx.AsyncBaseTransport | None = None) -> None:
        inner = inner or httpx.AsyncHTTPTransport()
        self._http = httpx.AsyncClient(
            base_url=f"{config.backend_url}/v1",
            transport=GuardedTransport({config.backend_host}, inner),
            follow_redirects=False,
            timeout=10.0,
        )
        self._fleet_credential = config.fleet_credential
        self._task_arn = config.task_arn
        self._token: str | None = None
        self._stop_at: float | None = None  # loop time by which every call must be done
        self._active: set[asyncio.Timeout] = set()

    def stop_by(self, deadline: float, in_flight_by: float) -> None:
        """Shortens calls for a shutdown: calls already in flight end by `in_flight_by`, so
        the drain can start, and no call runs past `deadline` (both loop times)."""
        self._stop_at = deadline
        for timeout in list(self._active):
            when = timeout.when()
            if when is None or when > in_flight_by:
                try:
                    timeout.reschedule(in_flight_by)
                except RuntimeError:
                    pass  # already expiring: that call is ending anyway

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, path: str, token: str | None, body: dict | None = None,
                    *, parse: bool = True, seconds: float = CALL_SECONDS):
        response = await self._send(method, path, token, body, seconds=seconds)
        if response.is_success and not parse:
            return None
        return _parsed(response)

    async def _send(self, method: str, path: str, token: str | None, body: dict | None = None,
                    headers: dict | None = None, *, seconds: float = CALL_SECONDS) -> httpx.Response:
        if token is None:  # not registered yet: never send `Bearer None`
            raise BackendError(401, "no_token")
        when = asyncio.get_running_loop().time() + seconds
        if self._stop_at is not None:
            when = min(when, self._stop_at)
        try:
            async with asyncio.timeout_at(when) as timeout:
                self._active.add(timeout)
                try:
                    return await self._http.request(
                        method, path, json=body,
                        headers={**(headers or {}), "authorization": f"Bearer {token}"},
                        timeout=seconds,  # httpx's own is per phase: a wait for the answer too
                    )
                finally:
                    self._active.discard(timeout)
        except TimeoutError:
            raise httpx.TimeoutException("backend call timed out") from None

    async def settings(self, etag: str | None) -> tuple[Settings, str | None] | None:
        """GET /bot/settings with the model keys, which this process keeps in memory only.
        The settings and their ETag, or None when nothing changed since `etag`."""
        headers = {"x-bwat-provider-keys": "memory-only"}
        if etag:
            headers["if-none-match"] = etag
        response = await self._send("GET", "/bot/settings", self._token, headers=headers)
        if response.status_code == 304:
            return None
        return Settings.from_body(_parsed(response)), response.headers.get("etag")

    async def presence_image(self, etag: str | None) -> tuple[int, bytes, str | None]:
        """GET /bot/presence-image: (200, the admin's picture, its ETag); (204, ...) while it
        is the default; (304, ...) when it is still the one tagged `etag`."""
        headers = {"if-none-match": etag} if etag else {}
        response = await self._send("GET", "/bot/presence-image", self._token, headers=headers)
        if response.status_code not in (200, 204, 304):
            _parsed(response)  # raises the refusal
            raise BackendError(response.status_code, "unreadable_body")
        return response.status_code, response.content, response.headers.get("etag")

    async def register(self, version: str) -> str:
        body = {"version": version}
        if self._task_arn:
            body["task_arn"] = self._task_arn
        reply = await self._call("POST", "/bots/register", self._fleet_credential, body)
        token = reply.get("bot_token") if isinstance(reply, dict) else None
        if not isinstance(token, str) or not BOT_TOKEN.fullmatch(token):
            raise BackendError(200, "malformed_registration")
        self._token = token
        return str(reply.get("bot_id"))

    async def ready(self, ready: bool, reason: str | None = None) -> None:
        body = {"ready": ready} if reason is None else {"ready": ready, "reason": reason}
        await self._call("POST", "/bots/ready", self._token, body)

    async def assignment(self) -> Claim | None:
        view = await self._call("GET", "/assignment", self._token)
        return Claim.from_view(view) if view else None

    async def idle(self) -> None:
        """Acknowledge confirmed departure without renewing any claim."""
        await self._call("POST", "/assignment/heartbeat", self._token,
                         {"state": "idle", "joined": False})

    async def heartbeat(self, claim: Claim, epoch: int, status: dict) -> str | None:
        """Renews the lease, and returns the claim's feed token if the reply carries one.
        The 2xx is the renewal, so the reply is read only for the token: a body this client
        can't read must never turn a renewed lease into a failure."""
        body = {"claim_id": claim.claim_id, "generation": claim.generation,
                "transcript_epoch": epoch, **status}
        response = await self._send("POST", "/assignment/heartbeat", self._token, body)
        if not response.is_success:
            _parsed(response)  # raises the refusal
        try:
            return _feed_token(response.json())
        except ValueError:
            return None

    async def occurrence(self, claim: Claim, occurrence_uuid: str, meeting_title: str | None = None) -> Claim:
        body = {"claim_id": claim.claim_id, "generation": claim.generation,
                "occurrence_uuid": occurrence_uuid}
        if meeting_title:
            body["meeting_title"] = meeting_title
        return Claim.from_view(await self._call("POST", "/assignment/occurrence", self._token, body))

    async def transcript(self, occurrence: str, epoch: int, segments: Sequence,
                         complete: bool) -> list[Segment] | None:
        """POST /meetings/{occurrence}/transcript: stored on a 2xx. The occurrence is
        path-encoded whole, since Zoom's carry '/', '+' and '='."""
        body = {"epoch": epoch, "complete": complete,
                "segments": [{k: v for k, v in asdict(s).items() if v is not None} for s in segments]}
        identity = any(s.speaker_zoom_id for s in segments)
        if identity:
            body['return_segments'] = True
        response = await self._send("POST", f"/meetings/{quote(occurrence, safe='')}/transcript", self._token, body)
        if response.is_success and not identity:
            return None
        result = _parsed(response)
        try:
            stored = [Segment(**{k: s[k] for k in _SEGMENT_FIELDS if k in s}) for s in result['segments']]
            if sorted(s.seq for s in stored) != sorted(s.seq for s in segments):
                raise ValueError('different segment batch')
            return stored
        except (AttributeError, KeyError, TypeError, ValueError):
            raise BackendError(502, 'malformed_transcript') from None

    async def join_token(self, claim: Claim) -> dict:
        """POST /assignment/join-token: the claim's Meeting SDK JWT and local recording
        token, minted for this join; never logged or stored."""
        body = {"claim_id": claim.claim_id, "generation": claim.generation}
        reply = await self._call("POST", "/assignment/join-token", self._token, body)
        if not (isinstance(reply, dict) and isinstance(reply.get("sdk_jwt"), str)):
            raise BackendError(200, "malformed_join_token")
        return reply

    async def chat_cards(self, claim: Claim, kind: str) -> dict:
        """POST /assignment/chat-cards: what the bot posts in the meeting chat, `agenda` or
        `questions`: {"cards": [{"display_id", "title"}, ...]}; for the agenda each card's
        "kind" too, and its "summary", None or absent when there is none (QOR-4966)."""
        body = {"claim_id": claim.claim_id, "generation": claim.generation, "list": kind}
        reply = await self._call("POST", "/assignment/chat-cards", self._token, body,
                                 seconds=AGENDA_CALL_SECONDS if kind == "agenda" else CALL_SECONDS)
        cards = reply.get("cards") if isinstance(reply, dict) else None
        if not (isinstance(cards, list) and all(isinstance(c, dict) for c in cards)
                and isinstance(reply.get("summary"), str | None)):
            raise BackendError(200, "malformed_chat_cards")
        return reply

    async def release(
        self, claim: Claim, reason: str, *, meeting_ended: bool = False, requeue: bool = False
    ) -> None:
        body = {"claim_id": claim.claim_id, "generation": claim.generation, "reason": reason}
        if meeting_ended:
            body["meeting_ended"] = True
        if requeue:
            body["requeue"] = True
        await self._call("POST", "/assignment/release", self._token, body, parse=False)


def _feed_token(view) -> str | None:
    token = view.get("feed_token") if isinstance(view, dict) else None
    return token if isinstance(token, str) and token else None


def _parsed(response: httpx.Response):
    """A 2xx answer's body, or the BackendError a refusal carries."""
    if response.is_success:
        try:
            return response.json()
        except ValueError:
            raise BackendError(response.status_code, "unreadable_body") from None
    try:
        code = response.json().get("error")
    except (ValueError, AttributeError):
        code = None
    raise BackendError(response.status_code, code)
