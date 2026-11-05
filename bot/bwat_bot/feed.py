"""The operator feed (D80, D171, D178): a plain WebSocket at GET /feed that the
card service dials to follow the meeting live.

Capture proves it holds the claim's feed token before the upgrade (Authorization: Bwat-Feed
HMAC(token, "capture|claim|generation|nonce")); both sides derive a key for the connection,
K = HMAC(token, "session|claim|generation|nonce"), and every message the bot sends is an
envelope {"c", "f", "m"} with m = HMAC(K, c "." f). One subscriber per claim, the newest
wins (4000). The bot closes with 4001 when the token changes, 4002 when the claim ends and
4004 when the lease lapses. No clock, no nonce memory, no gap frames, no counter limit.

Nothing here logs a token, a key, a nonce or a MAC.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
from dataclasses import dataclass, field

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request

from bwat_bot.audio import Segment
from bwat_bot.config import FEED_PORT

log = logging.getLogger("bwat_bot")

REPLACED, ROTATED, CLAIM_OVER, LEASE_EXPIRED = 4000, 4001, 4002, 4004
SEND_SECONDS = 1.0  # a subscriber that takes longer to take a frame is dropped
SCHEME = "Bwat-Feed "


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def proof(token: str, claim_id: str, generation: int, nonce: str) -> str:
    """What capture sends to show it holds the token. The nonce goes in as sent."""
    return b64url(_hmac(token.encode(), f"capture|{claim_id}|{generation}|{nonce}"))


def session_key(token: str, claim_id: str, generation: int, nonce: str) -> bytes:
    return _hmac(token.encode(), f"session|{claim_id}|{generation}|{nonce}")


def mac(key: bytes, c: int, f: str) -> str:
    return b64url(_hmac(key, f"{c}.{f}"))


def frame(body: dict) -> str:
    """A frame's JSON exactly as it is MACed and sent."""
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False)


def transcript_frame(occurrence_id: str, epoch: int, segment: Segment) -> dict:
    """A stored segment as the feed carries it; published only after the backend stored it."""
    return {"type": "transcript", "occurrence_id": occurrence_id, "transcript_epoch": epoch,
            "seq": segment.seq, "source": segment.source, "speaker_label": segment.speaker_label,
            "text": segment.text, "start_ms": segment.start_ms, "end_ms": segment.end_ms,
            **({"speaker_zoom_id": segment.speaker_zoom_id,
                "speaker_member_id": segment.speaker_member_id} if segment.speaker_zoom_id else {})}


@dataclass(frozen=True)
class Binding:
    """The claim the feed serves: what hello says, and the token that opens it."""

    bot_id: str
    claim_id: str
    generation: int
    occurrence_id: str
    transcript_epoch: int
    feed_token: str = field(repr=False)


class _Subscriber:
    def __init__(self, connection: ServerConnection, key: bytes) -> None:
        self.connection = connection
        self._key = key
        self._c = 0

    async def send(self, body: dict) -> None:
        """Numbers and MACs the frame at once, so frames keep the order of the calls."""
        f = frame(body)
        c, self._c = self._c, self._c + 1
        await self.connection.send(json.dumps({"c": c, "f": f, "m": mac(self._key, c, f)}))


class FeedServer:
    def __init__(self, port: int = FEED_PORT, host: str = "0.0.0.0") -> None:
        self._host = host
        self._port = port
        self._server: Server | None = None
        self._binding: Binding | None = None
        self._subscriber: _Subscriber | None = None
        self._started_at: str | None = None
        self._admitted = False

    @property
    def port(self) -> int:
        """The port listened on (the one asked for, or the one picked for port 0)."""
        return self._server.sockets[0].getsockname()[1] if self._server else self._port

    @property
    def binding(self) -> Binding | None:
        return self._binding

    async def start(self) -> None:
        self._server = await serve(self._handle, self._host, self._port,
                                   process_request=self._check, compression=None)

    async def aclose(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    def bind(self, binding: Binding) -> None:
        """Serves `binding` from now on. A new token or epoch closes the open feed (4001),
        so capture dials again and hears the new hello."""
        if self._binding is not None and binding != self._binding:
            self._close(ROTATED)
        self._binding = binding

    def unbind(self, code: int) -> None:
        """Stops serving and closes the open feed with `code`. Safe to call when unbound."""
        self._binding = None
        self._admitted, self._started_at = False, None
        self._close(code)

    async def admitted(self, started_at: str | None) -> None:
        """The bot is in the meeting: subscribers hear meeting_started now and on connect."""
        self._admitted, self._started_at = True, started_at
        if self._binding is not None:
            await self.publish(self._meeting_started())

    async def publish(self, body: dict) -> None:
        """Sends a frame to the subscriber, if there is one. Frames go out in call order.
        A subscriber that stops reading is dropped rather than allowed to stall the bot;
        capture reads the stored transcript when it dials again."""
        subscriber = self._subscriber
        if subscriber is None:
            return
        try:
            await asyncio.wait_for(_quietly(subscriber.send(body)), SEND_SECONDS)
        except TimeoutError:
            log.warning("feed.subscriber_stalled")
            if self._subscriber is subscriber:
                self._close(REPLACED)

    def _meeting_started(self) -> dict:
        return {"type": "meeting_started", "occurrence_id": self._binding.occurrence_id,
                "started_at": self._started_at}

    def _close(self, code: int) -> None:
        subscriber, self._subscriber = self._subscriber, None
        if subscriber is not None:
            asyncio.ensure_future(_quietly(subscriber.connection.close(code)))

    def _check(self, connection: ServerConnection, request: Request):
        """Before the upgrade: 503 with nothing to serve, 401 without the claim's proof."""
        binding = self._binding
        if binding is None:
            return connection.respond(503, "")
        nonce = request.headers.get("x-bwat-feed-nonce", "")
        sent = request.headers.get("authorization", "")
        expected = SCHEME + proof(binding.feed_token, binding.claim_id, binding.generation,
                                  nonce)
        if not nonce or not hmac.compare_digest(sent.encode(), expected.encode()):
            return connection.respond(401, "")
        return None

    async def _handle(self, connection: ServerConnection) -> None:
        binding = self._binding
        if binding is None:  # unbound between the check and the upgrade
            await connection.close(CLAIM_OVER)
            return
        nonce = connection.request.headers["x-bwat-feed-nonce"]
        subscriber = _Subscriber(connection, session_key(
            binding.feed_token, binding.claim_id, binding.generation, nonce))
        old, self._subscriber = self._subscriber, subscriber
        if old is not None:  # closed in the background: a dead socket never delays hello
            log.info("feed.replaced")
            asyncio.ensure_future(_quietly(old.connection.close(REPLACED)))
        try:
            await subscriber.send({"type": "hello", "bot_id": binding.bot_id,
                                   "claim_id": binding.claim_id,
                                   "generation": binding.generation,
                                   "occurrence_id": binding.occurrence_id,
                                   "transcript_epoch": binding.transcript_epoch})
            if self._admitted:
                await subscriber.send(self._meeting_started())
            async for _ in connection:  # one direction only: anything sent up is ignored
                pass
        except ConnectionClosed:
            pass
        finally:
            if self._subscriber is subscriber:
                self._subscriber = None


async def _quietly(call) -> None:
    try:
        await call
    except ConnectionClosed:
        pass
