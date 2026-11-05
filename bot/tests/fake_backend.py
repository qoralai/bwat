"""An in-process stand-in for the bwat backend's bot routes, built from backend/README.md
("Bots and allocations", "The transcript epoch", "Release reasons"), not from the bot's
client. It runs behind httpx.MockTransport and records every request, so a test can
assert where the bot connected and what it sent.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import re
import secrets
import uuid
from dataclasses import dataclass, field
from urllib.parse import unquote

import httpx

REQUEUED_BY_REASON = {
    "waiting_for_host_timeout",
    "waiting_room_timeout",
    "unable_to_connect",
    "sdk_auth_failed",
    "obf_user_not_in_meeting",
}
MAX_TRANSCRIPT_EPOCH = 1_000_000
REASON = re.compile(r"[a-z][a-z0-9_]{0,63}")  # the backend's release reason format
NULL = {"content": b"null", "headers": {"content-type": "application/json"}}


@dataclass
class Claim:
    claim_id: str
    meeting_number: str
    briefing: dict
    generation: int = 1
    state: str = "pending"  # pending, held, done
    bot_id: str | None = None
    occurrence_uuid: str | None = None
    epoch: int | None = None  # the claim's accepted epoch
    reason: str | None = None
    recalled: bool = False
    lease_ok: bool = True  # False once a test lets the lease lapse

    def view(self, highest: dict[str, int], feed_key: bytes | None = None) -> dict:
        shown = highest.get(self.occurrence_uuid) if self.occurrence_uuid else None
        feed = {} if feed_key is None else {"feed_token": feed_token(feed_key, self)}
        return {
            **feed,
            "claim_id": self.claim_id,
            "generation": self.generation,
            "lease_until": "2099-01-01T00:00:00Z",
            "meeting_number": self.meeting_number,
            "occurrence_uuid": self.occurrence_uuid,
            "transcript_epoch": shown,
            "briefing": self.briefing,
        }


def feed_token(key: bytes, claim: Claim) -> str:
    """The backend's derivation (backend/src/feed.ts)."""
    digest = hmac.new(key, f"{claim.claim_id}|{claim.generation}".encode(), "sha256").digest()
    return "bwo_" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


@dataclass
class Request:
    method: str
    host: str
    path: str
    authorization: str | None
    body: dict | None
    headers: dict = field(default_factory=dict)
    read_timeout: float | None = None  # httpx's wait for the answer


@dataclass
class FakeBackend:
    host: str = "backend.test"
    fleet_credential: str = field(default_factory=lambda: "bwf_" + secrets.token_urlsafe(32))
    bots: dict[str, str] = field(default_factory=dict)  # token -> bot_id
    ready: dict[str, bool] = field(default_factory=dict)  # bot_id -> ready
    ready_bodies: list[dict] = field(default_factory=list)
    claims: dict[str, Claim] = field(default_factory=dict)
    highest: dict[str, int] = field(default_factory=dict)  # occurrence -> highest epoch
    ended_occurrences: set[str] = field(default_factory=set)
    requests: list[Request] = field(default_factory=list)
    heartbeats: list[dict] = field(default_factory=list)
    releases: list[dict] = field(default_factory=list)
    stale_epochs: int = 0  # heartbeats refused with 409 stale_epoch
    down: bool = False  # every route answers 503
    fail_once: set[str] = field(default_factory=set)  # paths whose next call drops the connection
    undecodable_once: set[str] = field(default_factory=set)  # paths whose next body won't decode
    reject_bot_tokens: bool = False  # something in front of the backend 401s every bot token
    unavailable: set[str] = field(default_factory=set)  # paths that answer 503 until removed
    unavailable_error: object = "unavailable"  # the error value those refusals carry
    unavailable_status: int = 503  # and their status
    delays: dict[str, float] = field(default_factory=dict)  # path -> seconds before answering
    assignment_body: object = None  # a test's stand-in for GET /assignment's answer
    heartbeat_body: object = None  # and for an accepted heartbeat's answer
    timeline: list[str] = field(default_factory=list)  # route paths, and the bridge's calls
    settings_values: dict = field(default_factory=dict)  # served settings that hold a value
    settings_version: int = 1
    dictionary: dict | None = None
    provider_keys: dict = field(default_factory=dict)  # model keys, served in memory only
    settings_body: object = None  # a test's stand-in for GET /bot/settings's answer
    presence_image: tuple[str, bytes] | None = None  # (content type, bytes); None: the default
    feed_key: bytes | None = field(default_factory=lambda: secrets.token_bytes(32))  # None: no feed
    pushes: list[dict] = field(default_factory=list)  # transcript pushes, with "path"
    push_refusals: list = field(default_factory=list)  # (status, error) for the next pushes
    stored: dict = field(default_factory=dict)  # (occurrence, epoch, seq) -> segment
    complete: set[str] = field(default_factory=set)  # occurrences whose final push landed
    deleted: set[str] = field(default_factory=set)  # occurrences whose meeting was deleted
    chat_cards: dict = field(default_factory=dict)  # list ("agenda", "questions") -> its cards
    agenda_summary: object = None  # the agenda's summary, as the card service writes it
    join_tokens: dict = field(default_factory=lambda: {
        "sdk_jwt": "eyJ." + secrets.token_urlsafe(16), "sdk_jwt_expires_at": "2099-01-01T00:00:00Z",
        "recording_token": secrets.token_urlsafe(16),
        "recording_token_expires_at": "2099-01-01T00:00:00Z"})

    # Test controls -----------------------------------------------------------------

    def send(self, meeting_number: str, passcode: str | None = None,
             scheduled_end: str | None = None) -> Claim:
        """A person sends bwat to a meeting (POST /allocations); with `scheduled_end`, as
        auto-join opens a claim for a meeting with a fixed schedule."""
        briefing = {} if passcode is None else {"passcode": passcode}
        if scheduled_end is not None:
            briefing["scheduled_end"] = scheduled_end
        claim = Claim(claim_id=str(uuid.uuid4()), meeting_number=meeting_number, briefing=briefing)
        self.claims[claim.claim_id] = claim
        self._allocate()
        return claim

    def recall(self, claim: Claim) -> None:
        claim.recalled = True
        claim.state = "done"
        claim.reason = "recalled"

    def held_by(self, bot_id: str) -> Claim | None:
        return next(
            (c for c in self.claims.values() if c.state == "held" and c.bot_id == bot_id), None
        )

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    # Routes ------------------------------------------------------------------------

    async def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        auth = request.headers.get("authorization")
        self.requests.append(Request(request.method, request.url.host, request.url.path, auth, body,
                                     dict(request.headers), request.extensions["timeout"]["read"]))
        self.timeline.append(request.url.path)
        await asyncio.sleep(self.delays.get(request.url.path, 0))  # recorded, then answered
        if self.down:
            return httpx.Response(503, json={"error": "unavailable"})
        if request.url.path in self.unavailable:
            return httpx.Response(self.unavailable_status, json={"error": self.unavailable_error})
        if request.url.path in self.fail_once:
            self.fail_once.discard(request.url.path)
            raise httpx.ConnectError("dropped", request=request)
        if request.url.path in self.undecodable_once:
            self.undecodable_once.discard(request.url.path)
            raise httpx.DecodingError("bad content-encoding", request=request)
        route = (request.method, request.url.path)
        token = auth.removeprefix("Bearer ") if auth and auth.startswith("Bearer ") else None
        if route == ("POST", "/v1/bots/register"):
            if token != self.fleet_credential:
                return httpx.Response(401, json={"error": "unauthorized"})
            bot_id, bot_token = str(uuid.uuid4()), "bwb_" + secrets.token_urlsafe(32)
            self.bots[bot_token] = bot_id
            return httpx.Response(200, json={"bot_id": bot_id, "bot_token": bot_token})
        bot_id = None if self.reject_bot_tokens else self.bots.get(token or "")
        if bot_id is None:
            code = 409 if token == self.fleet_credential else 401
            return httpx.Response(code, json={"error": "unregistered_bot" if code == 409 else "unauthorized"})
        if route == ("GET", "/v1/bot/settings"):
            return self._settings(request.headers)
        if route == ("GET", "/v1/bot/presence-image"):
            return self._presence_image(request.headers)
        handlers = {
            ("POST", "/v1/bots/ready"): self._ready,
            ("GET", "/v1/assignment"): self._assignment,
            ("POST", "/v1/assignment/heartbeat"): self._heartbeat,
            ("POST", "/v1/assignment/occurrence"): self._occurrence,
            ("POST", "/v1/assignment/release"): self._release,
            ("POST", "/v1/assignment/join-token"): self._join_token,
            ("POST", "/v1/assignment/chat-cards"): self._chat_cards,
        }
        prefix, _, occurrence = request.url.raw_path.decode().partition("/v1/meetings/")
        if request.method == "POST" and not prefix and occurrence.endswith("/transcript"):
            return self._transcript(bot_id, unquote(occurrence.removesuffix("/transcript")),
                                    {**(body or {}), "path": request.url.raw_path.decode()})
        handler = handlers.get(route)
        if handler is None:
            return httpx.Response(404, json={"error": "not_found"})
        return handler(bot_id, body or {})

    def _settings(self, headers: httpx.Headers) -> httpx.Response:
        """GET /bot/settings (backend/src/routes/bot-settings.ts): keys only for a bot that
        keeps them in memory, an ETag over the version and the keys, 304 when it matches."""
        if self.settings_body is not None:  # untagged, like a partial key read: never a 304
            return httpx.Response(200, json=self.settings_body)
        keys = dict(self.provider_keys) if headers.get("x-bwat-provider-keys") == "memory-only" else None
        tag = f'"settings-{self.settings_version}"'
        if keys is not None:
            digest = hashlib.sha256(json.dumps(keys).encode()).hexdigest()[:16]
            tag = f'"settings-{self.settings_version}-keys-{digest}"'
        if headers.get("if-none-match") == tag:
            return httpx.Response(304, headers={"etag": tag})
        body = {
            "dictionary": self.dictionary or {"state": "absent", "revision": None, "version": None, "payload": None},
            "settings": dict(self.settings_values),
            "settingsVersion": self.settings_version,
            "providerKeys": keys or {},
        }
        return httpx.Response(200, json=body, headers={"etag": tag, "cache-control": "no-store"})

    def _presence_image(self, headers: httpx.Headers) -> httpx.Response:
        """GET /bot/presence-image (backend/src/routes/presence-image.ts): 204 for the
        default; the picture with its sha256 as the ETag, or 304 when that matches."""
        if self.presence_image is None:
            return httpx.Response(204)
        content_type, picture = self.presence_image
        tag = f'"{hashlib.sha256(picture).hexdigest()}"'
        if headers.get("if-none-match") == tag:
            return httpx.Response(304, headers={"etag": tag})
        return httpx.Response(200, content=picture, headers={"etag": tag, "content-type": content_type})

    def _ready(self, bot_id: str, body: dict) -> httpx.Response:
        self.ready_bodies.append(body)
        ready = body.get("ready", True)
        self.ready[bot_id] = ready
        if ready:
            self._allocate()
        return httpx.Response(200, json={"bot_id": bot_id, "ready": ready})

    def _assignment(self, bot_id: str, _body: dict) -> httpx.Response:
        if self.assignment_body is not None:
            return httpx.Response(200, json=self.assignment_body)
        claim = self.held_by(bot_id)
        return httpx.Response(200, json=claim.view(self.highest, self.feed_key)) if claim else httpx.Response(200, **NULL)

    def _fenced(self, bot_id: str, body: dict) -> Claim | None:
        claim = self.claims.get(body.get("claim_id", ""))
        if (
            claim is None
            or claim.bot_id != bot_id
            or claim.state != "held"
            or claim.generation != body.get("generation")
            or not claim.lease_ok
        ):
            return None
        return claim

    def _heartbeat(self, bot_id: str, body: dict) -> httpx.Response:
        self.heartbeats.append(body)
        if ("claim_id" in body) != ("generation" in body):
            return httpx.Response(400, json={"error": "invalid_body"})
        if "claim_id" not in body:
            return httpx.Response(200, **NULL)
        claim = self._fenced(bot_id, body)
        if claim is None:
            return httpx.Response(409, json={"error": "stale_claim"})
        epoch = body.get("transcript_epoch")
        if epoch is not None:
            if epoch > MAX_TRANSCRIPT_EPOCH:
                return httpx.Response(400, json={"error": "invalid_body"})
            if not self._accept_epoch(claim, epoch):
                self.stale_epochs += 1
                return httpx.Response(409, json={"error": "stale_epoch"})
        if isinstance(self.heartbeat_body, bytes):  # a body that is not JSON at all
            return httpx.Response(200, content=self.heartbeat_body)
        if self.heartbeat_body is not None:
            return httpx.Response(200, json=self.heartbeat_body)
        return httpx.Response(200, json=claim.view(self.highest, self.feed_key))

    def _accept_epoch(self, claim: Claim, epoch: int) -> bool:
        if claim.occurrence_uuid is None:  # claim-local before promotion, stored as sent
            claim.epoch = epoch
            return True
        if epoch == claim.epoch:
            return True
        if epoch > self.highest.get(claim.occurrence_uuid, -1):
            claim.epoch = epoch
            self.highest[claim.occurrence_uuid] = epoch
            return True
        return False

    def _occurrence(self, bot_id: str, body: dict) -> httpx.Response:
        claim = self._fenced(bot_id, body)
        if claim is None:
            return httpx.Response(409, json={"error": "stale_claim"})
        occ = body.get("occurrence_uuid")
        if claim.occurrence_uuid == occ:  # the same occurrence again: answered, even once ended
            return httpx.Response(200, json=claim.view(self.highest, self.feed_key))
        if claim.occurrence_uuid is not None:
            return httpx.Response(409, json={"error": "occurrence_conflict"})
        if occ in self.ended_occurrences:
            claim.state, claim.reason = "done", "meeting_already_ended"
            return httpx.Response(409, json={"error": "meeting_already_ended"})
        claim.occurrence_uuid = occ
        # An epoch declared before promotion is kept only if above the occurrence's highest.
        if claim.epoch is not None and claim.epoch > self.highest.get(occ, -1):
            self.highest[occ] = claim.epoch
        else:
            claim.epoch = None
        return httpx.Response(200, json=claim.view(self.highest, self.feed_key))

    def _transcript(self, bot_id: str, occurrence: str, body: dict) -> httpx.Response:
        """POST /meetings/{occurrence}/transcript ("Pushing a transcript"): only the live
        claim on the occurrence, at its accepted epoch; idempotent on (epoch, seq)."""
        self.pushes.append(body)
        if self.push_refusals:
            status, error = self.push_refusals.pop(0)
            return httpx.Response(status, json={"error": error})
        if occurrence in self.deleted:
            return httpx.Response(409, json={"error": "meeting_deleted"})
        claim = next((c for c in self.claims.values() if c.state == "held"
                      and c.bot_id == bot_id and c.occurrence_uuid == occurrence), None)
        if claim is None or not claim.lease_ok or body.get("epoch") != claim.epoch:
            return httpx.Response(409, json={"error": "stale_epoch"})
        new = [s for s in body.get("segments", [])
               if (occurrence, body["epoch"], s["seq"]) not in self.stored]
        if new and occurrence in self.complete:
            return httpx.Response(409, json={"error": "transcript_complete"})
        for segment in new:
            self.stored[(occurrence, body["epoch"], segment["seq"])] = segment
        if body.get("complete"):
            self.complete.add(occurrence)
        return httpx.Response(204)

    def _join_token(self, bot_id: str, body: dict) -> httpx.Response:
        """POST /assignment/join-token (backend README, Zoom tokens): fenced like a beat."""
        if self._fenced(bot_id, body) is None:
            return httpx.Response(409, json={"error": "stale_claim"})
        return httpx.Response(200, json=self.join_tokens)

    def _chat_cards(self, bot_id: str, body: dict) -> httpx.Response:
        """POST /assignment/chat-cards (backend README): fenced like a beat."""
        if self._fenced(bot_id, body) is None:
            return httpx.Response(409, json={"error": "stale_claim"})
        listed = {"cards": self.chat_cards.get(body.get("list"), [])}
        if body.get("list") == "agenda":
            listed["summary"] = self.agenda_summary
        return httpx.Response(200, json=listed)

    def _release(self, bot_id: str, body: dict) -> httpx.Response:
        self.releases.append(body)
        reason = body.get("reason")
        if (body.get("requeue") and body.get("meeting_ended")) or (
            reason is not None and not REASON.fullmatch(reason)
        ):
            return httpx.Response(400, json={"error": "invalid_body"})
        claim = self._fenced(bot_id, body)
        if claim is None:
            return httpx.Response(409, json={"error": "stale_claim"})
        claim.reason = body.get("reason")
        if body.get("requeue"):
            self.ready[bot_id] = False
            self._requeue(claim)
            return httpx.Response(200, json={"status": "requeued"})
        if body.get("meeting_ended"):
            claim.state = "done"
            if claim.occurrence_uuid:
                self.ended_occurrences.add(claim.occurrence_uuid)
            return httpx.Response(200, json={"status": "released"})
        if claim.reason in REQUEUED_BY_REASON:
            self._requeue(claim)
            return httpx.Response(200, json={"status": "requeued"})
        claim.state = "done"
        return httpx.Response(200, json={"status": "released"})

    def _requeue(self, claim: Claim) -> None:
        claim.state, claim.bot_id, claim.epoch = "pending", None, None
        claim.generation += 1
        self._allocate()

    def _allocate(self) -> None:
        busy = {c.bot_id for c in self.claims.values() if c.state == "held"}
        free = iter([b for b, r in self.ready.items() if r and b not in busy])
        for claim in [c for c in self.claims.values() if c.state == "pending"]:
            bot = next(free, None)
            if bot is None:
                return
            claim.state, claim.bot_id = "held", bot
