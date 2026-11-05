"""The bot's claim lifecycle against the bwat backend (T067, T019).

Idle: register, report readiness, poll GET /assignment. Holding a claim: declare a fresh
transcript epoch, join through the bridge, heartbeat to keep the lease, and act on meeting
events. Once joined, the meeting's audio is transcribed into segments and pushed to the
backend; when the meeting ends, the last push says the transcript is complete before the
claim is released. Losing the claim (`409 stale_claim`: a recall or another holder; or a lease that
lapses without a renewal) means leave at once. Stopping (SIGTERM, D82): withdraw, leave,
and hand the claim back with `requeue`, the only case that sets it.

It posts in the meeting chat, unless the admin turned chat posts off, and never speaks
(D125): on joining, once per claim, unless the admin turned the agenda off, a summary of
what is still open from the meeting's previous occurrence (QOR-4966); with a scheduled end,
the five-minute warning with the open questions nobody owns, then an alarm clock at the end.

Logs name events and claim ids only, never a meeting number, passcode, occurrence or token.
"""
import asyncio
import contextlib
import io
import ipaddress
import itertools
import logging
import random
import re
import socket
import time
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

from bwat_bot import __version__, presence
from bwat_bot.audio import QUEUE_SEGMENTS, Segment, put_dropping_oldest, transcribe_audio
from bwat_bot.backend import BackendClient, BackendError, Claim, Settings
from bwat_bot.bridge import (
    Alone,
    Bridge,
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
from bwat_bot.feed import CLAIM_OVER, LEASE_EXPIRED, Binding, FeedServer, transcript_frame
from bwat_bot.push import LINGER_SECONDS, TRANSIENT, Pusher
from bwat_bot.settings import SettingsPoller

log = logging.getLogger("bwat_bot")

LEASE_SECONDS = 90.0  # the backend's LEASE_SECONDS (backend/src/claims.ts)
HEARTBEAT_SECONDS = 15.0
BACKOFF_CAP_SECONDS = 20.0  # below the backend's 45 s staleness
BRIDGE_CALL_SECONDS = 10.0
# The final push after Zoom's end, bounded well inside the lease: no heartbeat runs meanwhile.
FINAL_SECONDS = 30.0
# Why a bot that waited too long to be let in gives the meeting back (D155); how long is
# the admin's waiting_room_min and wait_for_start_min.
WAITS = {WaitingRoom: "waiting_room_timeout", WaitingForHost: "waiting_for_host_timeout"}
DRAIN_SECONDS = 15.0  # from SIGTERM, inside the container's 20 s stop grace period
IN_FLIGHT_SECONDS = 1.0  # a call already running when SIGTERM lands gets this long
STOP_REASON = "bot_stopping"  # ignored by the backend on a requeue; sent for the record
FAILURES = (BackendError, httpx.RequestError)
# The backend's release reason format; anything else is refused with 400.
REASON = re.compile(r"[a-z][a-z0-9_]{0,63}")
# Heartbeat outcomes: the backend renewed the lease; the claim is no longer this bot's; or
# no answer, so ownership is unknown.
RENEWED, LOST, UNSURE = "renewed", "lost", "unsure"
DEFAULT = "default"  # the presence frame holds the bundled logo
# Backend error codes a log line may carry; anything else is logged as "other", since an
# error body is the backend's text and could carry anything.
KNOWN_CODES = frozenset({
    "stale_claim", "stale_epoch", "occurrence_conflict", "meeting_already_ended",
    "transcript_complete", "meeting_deleted", "unregistered_bot", "unauthorized",
    "invalid_body", "not_found", "unavailable", "unreadable_body", "malformed_claim",
    "malformed_registration", "no_token", "malformed_settings", "not_configured",
    "secret_unavailable", "malformed_join_token", "malformed_chat_cards",
})
WARNING_SECONDS = 300.0  # the five-minute warning
TIME_UP = "\u23f0"  # a bare alarm clock at the scheduled end
HELLO = "bwat is here and taking notes. Nothing carried over from last time."
# Each kind of card, in the order the agenda's count names them, and the word for one
# (QOR-4966).
KIND_WORDS = {"todo": "to-do", "question": "question", "risk": "risk", "decision": "decision"}
# What one chat post may hold of a list. Zoom refuses a message too long to build, and the
# whole list is on the board anyway.
CHAT_LIST_CHARS = 1000


@dataclass(frozen=True)
class Idle:
    """Nothing said for the admin's idle_leave_min (QOR-4893). The bot notices it itself;
    no bridge reports it."""


# How each end of the meeting is released: none of them is retried.
ENDINGS = {Ended: "meeting_ended", Alone: "left_alone", Idle: "idle"}


class Bot:
    def __init__(
        self,
        config: Config,
        bridge: Bridge,
        *,
        transcription_ready: Callable[[], Awaitable[bool]],
        transcribe: Callable[[bytes], Awaitable[str]] | None = None,
        transcription_error: Callable[[], str | None] = lambda: None,
        clear_transcription_error: Callable[[], None] = lambda: None,
        settings: SettingsPoller | None = None,
        inner_transport: httpx.AsyncBaseTransport | None = None,
        tick_seconds: float = 2.0,
        heartbeat_seconds: float = HEARTBEAT_SECONDS,
        lease_seconds: float = LEASE_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        push_linger_seconds: float = LINGER_SECONDS,
        final_seconds: float = FINAL_SECONDS,
        feed: FeedServer | None = None,
        feed_host: Callable[[], str | None] | None = None,
    ) -> None:
        self._backend = BackendClient(config, inner_transport)
        self._bridge = bridge
        self._transcription_ready = transcription_ready
        self._transcribe = transcribe
        self._transcription_error = transcription_error
        self._clear_transcription_error = clear_transcription_error
        self._audio: asyncio.Task | None = None
        self._pusher: Pusher | None = None
        self._push_linger = push_linger_seconds
        self._final_seconds = final_seconds
        self._recorded: str | None = None  # the occurrence the backend recorded for the claim
        self._final: asyncio.Timeout | None = None  # the final push's bound, while it runs
        self._feed = feed
        self._find_feed_host = feed_host or (lambda: discover_feed_host(config.backend_host))
        self._feed_host: str | None = None  # found once it can be dialled
        self._feed_token: str | None = None  # the current claim's, from its view
        self._bot_id: str | None = None
        # What was said in the current claim's meeting, in order, for the transcript push.
        # Memory only; a fresh queue for each claim.
        self.segments: asyncio.Queue[Segment] = asyncio.Queue()
        self._settings = settings
        self._tick = tick_seconds
        self._heartbeat_every = heartbeat_seconds
        self._lease_seconds = lease_seconds
        self._clock = clock
        self._stopping = asyncio.Event()
        self._reported: tuple[bool, str | None] | None = None
        self._failures = 0
        # Unconfirmed claims in a row. A successful poll resets _failures, so the backoff
        # before re-trying a claim whose heartbeat keeps failing needs a count of its own.
        self._claim_failures = 0
        self._left: set[tuple[str, int]] = set()  # claims this process let go of
        self._epoch = 0
        self._status: dict = {}
        self._lease_deadline = 0.0
        self._next_beat = 0.0
        self._occurrence: str | None = None  # reported by Zoom, not yet recorded
        self._meeting_title: str | None = None
        self._next_promote = 0.0
        self._credential_rejected = False  # the fleet credential was refused for good
        self._bridge_stuck = False  # a leave never completed: the bridge may still be in
        # What presence.FRAME_PATH holds: the admin's picture by its ETag, DEFAULT, or None.
        self._presence_shown: str | None = None
        self._stop_deadline = float("inf")
        self._config = config
        self._waiting: tuple[float, str] | None = None  # until when, and the reason after
        self._chat_armed = False  # the claim's chat posts are set up: once per claim
        self._warn_at: float | None = None  # when the five-minute warning is due, by self._clock
        self._time_up_at: float | None = None  # and the alarm clock
        self._posts: set[asyncio.Task] = set()  # chat posts under way, beside the claim loop

    def stop(self) -> None:
        """Asks the bot to stop; `run` finishes the drain within DRAIN_SECONDS of now. Calls
        already in flight are cut short, so the drain spends its budget on leaving."""
        if self._stopping.is_set():
            return
        # The flag first: nothing below may ever swallow the stop itself.
        self._stop_deadline = self._clock() + DRAIN_SECONDS
        self._stopping.set()
        now = asyncio.get_running_loop().time()
        # A call already running gets a share of the budget, so leaving always has time.
        in_flight = min(IN_FLIGHT_SECONDS, DRAIN_SECONDS / 4)
        if self._final is not None:  # a final push gets the same share as a call
            self._final.reschedule(min(self._final.when(), now + in_flight))
        try:
            self._backend.stop_by(now + DRAIN_SECONDS, now + in_flight)
        except Exception as exc:  # noqa: BLE001 - shortening calls is best effort
            log.warning("bot.stop_by_failed", extra={"error": type(exc).__name__})

    @property
    def credential_rejected(self) -> bool:
        """Registration was refused in a way no retry fixes (a wrong or revoked fleet
        credential). `run` then returns, so the process exits and an operator sees it."""
        return self._credential_rejected

    @property
    def bridge_stuck(self) -> bool:
        """A leave was never confirmed. `run` then withdraws and returns, so the process can
        exit and be restarted with a fresh bridge (and SDK process)."""
        return self._bridge_stuck

    async def run(self) -> None:
        try:
            await self._register()
            while not (self._stopping.is_set() or self._bridge_stuck
                       or self._credential_rejected):
                claim = await self._poll()
                if claim is None or claim.key in self._left:
                    self._claim_failures = 0  # no unconfirmed claim left to back off from
                if (claim is not None and not self._bridge_stuck
                        and claim.key not in self._left):
                    if self._stopping.is_set():
                        # The poll answered after SIGTERM: hand the claim back unjoined
                        # rather than join a meeting only to leave it again.
                        await self._hand_back(claim)
                        break
                    await self._attend(claim)
                # Always pause before the next poll, backing off after failures, so an
                # unconfirmed claim is never retried in a tight loop.
                await self._sleep(self._next_wait())
            if not self._credential_rejected:  # never registered: nothing to withdraw
                await self._withdraw("bridge_stuck" if self._bridge_stuck else "stopping")
        finally:
            await self._backend.aclose()

    # Idle --------------------------------------------------------------------------

    async def _register(self) -> None:
        """Registers with the fleet credential, retrying transient failures. A refusal no
        retry can change (400, 401, 403) sets `credential_rejected` instead. If a register
        succeeds but its reply is lost, the retry registers again: the first bot row stays
        unready and shows in /fleet as stale, which is harmless."""
        while not self._stopping.is_set():
            try:
                bot_id = await self._backend.register(__version__)
            except FAILURES as exc:
                if isinstance(exc, BackendError) and exc.status in (400, 401, 403):
                    self._credential_rejected = True
                    log.error("bot.credential_rejected", extra={"error": _code(exc)})
                    return
                self._failed("bot.register_failed", exc)
                await self._sleep(self._next_wait())
                continue
            self._failures, self._reported, self._bot_id = 0, None, bot_id
            log.info("bot.registered", extra={"bot_id": bot_id})
            return

    async def _poll(self) -> Claim | None:
        await self._refresh_settings()
        try:
            await self._sync_ready()
            claim = await self._backend.assignment()
        except FAILURES as exc:
            self._failed("bot.poll_failed", exc)
            if isinstance(exc, BackendError) and exc.status == 401:
                # The token is no longer known (e.g. a reset store). Keep the backoff: if the
                # 401 persists, re-registering on every tick would mint a bot row each time.
                failures = self._failures
                await self._register()
                self._failures = failures
            return None
        self._failures = 0
        return claim

    async def _sync_ready(self) -> None:
        if not self._bridge.is_up():
            await self._report_ready(False, "bridge_down")
        elif not await self._transcription_ready():
            await self._report_ready(False, "transcription_unavailable")
        else:
            await self._report_ready(True, None)

    async def _refresh_settings(self) -> None:
        """Reads GET /bot/settings when due. A failure keeps the last good settings (and
        keys) until the next read. Only while idle: a change reaches a bot in a meeting
        once it leaves (Track 4 decides whether to read during a meeting)."""
        if self._settings is None:
            return
        try:
            await self._settings.refresh(self._backend)
        except FAILURES as exc:
            log.warning("bot.settings_failed", extra={"error": _code(exc)})

    async def _report_ready(self, ready: bool, reason: str | None) -> None:
        if self._reported == (ready, reason):
            return
        await self._backend.ready(ready, reason)
        self._reported = (ready, reason)
        log.info("bot.ready" if ready else "bot.not_ready", extra={"reason": reason})

    async def _withdraw(self, reason: str) -> bool:
        """Reports not ready; whether the backend has it. A failure is logged, never raised
        (shutdown paths call it)."""
        try:
            await self._report_ready(False, reason)
        except FAILURES as exc:
            self._failed("bot.ready_failed", exc)
            return False
        return True

    # Holding a claim ---------------------------------------------------------------

    async def _attend(self, claim: Claim) -> None:
        log.info("claim.received", extra={"claim_id": claim.claim_id})
        # An error from an earlier meeting is not this one's: credit may have been added since.
        self._clear_transcription_error()
        # Restart rule: a new transcript stream always starts above the claim's epoch, even
        # when GET /assignment hands back a claim this process (or its predecessor) held.
        self._epoch = claim.next_epoch
        self._status = {"state": "joining", "joined": False}
        self._waiting = None
        self._occurrence = None
        self._meeting_title = None
        self._next_promote = 0.0  # no backoff carries over from an earlier claim
        self._chat_armed, self._warn_at, self._time_up_at = False, None, None
        self._recorded = claim.occurrence_uuid
        self._feed_token = claim.feed_token
        self.segments = asyncio.Queue(QUEUE_SEGMENTS)
        self._heard_at: float | None = None  # in the meeting, when anything was last said
        self._seqs = self._heard()  # one numbering for the meeting's speech and chat
        self._joined_at = self._clock()
        # Only a heartbeat the backend accepted makes the claim this bot's: GET /assignment
        # renews nothing and can return a claim whose lease already lapsed.
        outcome = await self._beat(claim)
        self._claim_failures = self._claim_failures + 1 if outcome == UNSURE else 0
        if outcome == LOST:
            self._left.add(claim.key)
        if outcome != RENEWED:
            if outcome == UNSURE and self._stopping.is_set():
                # SIGTERM cut the first heartbeat short: hand the claim back unjoined
                # rather than leave it to wait out its lease.
                await self._hand_back(claim)
            return
        if not await self._join(claim):
            self._left.add(claim.key)
            return
        self._pusher = Pusher(self._backend, self.segments, on_stored=self._publish,
                              linger_seconds=self._push_linger)
        if self._recorded is not None:  # the first heartbeat registered the epoch
            self._pusher.start(self._recorded, self._epoch)
        event = asyncio.ensure_future(self._bridge.next_event())
        try:
            while True:
                finished, consumed = await self._step(claim, event)
                if finished:
                    break
                if consumed:
                    event = asyncio.ensure_future(self._bridge.next_event())
        finally:
            event.cancel()
            for post in self._posts:
                post.cancel()
            if self._audio is not None:
                self._audio.cancel()
                self._audio = None
            self._pusher.cancel()
            self._pusher = None
            if self._feed is not None:
                self._feed.unbind(CLAIM_OVER)
            self._left.add(claim.key)

    async def _join(self, claim: Claim) -> bool:
        """Starts the join; False when it did not complete. A stop cuts the wait short and
        hands the claim back for requeue; a join that times out on its own is a failure."""
        options = self._join_options(await self._presence_frame())
        join = asyncio.ensure_future(self._bridge.join(
            claim.meeting_number, claim.passcode, lambda: self._backend.join_token(claim),
            options))
        await self._wait_or_stop(join, self._bridge_budget())
        if join.done():
            if join.exception() is None:
                return True
            exc = join.exception()
            log.error("bridge.join_failed", extra={"error": _code(exc)})
            # The backend could not mint the Zoom tokens (no Zoom app configured, or its
            # secrets unreadable): another bot would fare no better until it is fixed. Any
            # other 503 is an outage: a failed join like any other.
            unminted = isinstance(exc, BackendError) and exc.code in {"not_configured", "secret_unavailable"}
            await self._release(claim, "sdk_auth_failed" if unminted else "zoom_join_failed")
            return False
        join.cancel()
        if self._stopping.is_set():
            # A removal or failure Zoom already reported outranks the requeue, even while
            # the join itself never returned.
            if not await self._drain_events(claim):
                await self._hand_back(claim)
        else:
            await self._release(claim, "zoom_join_failed")
        return False

    async def _step(self, claim: Claim, event: asyncio.Future) -> tuple[bool, bool]:
        """One turn: whether the claim ended and whether this event was consumed. A meeting
        event that already happened (a removal, a failure) outranks a stop, so a SIGTERM
        never turns it into a requeue."""
        if not self._stopping.is_set():
            await self._wait_or_stop(event, self._tick)
        else:
            await asyncio.sleep(0)  # let an event already queued resolve
        # An event may arrive during a later heartbeat/promotion await. Keep it for
        # the next turn unless this turn actually handled it.
        consumed = event.done()
        if consumed and await self._on_event(claim, _outcome(event)):
            return True, consumed
        if self._stopping.is_set():
            # Every event already queued is acted on first: a removal or failure behind a
            # Joined must still win over the requeue.
            if not (event.done() and await self._drain_events(claim)):
                await self._hand_back(claim)
            return True, consumed
        if self._pusher.deleted:
            await self._release(claim, "meeting_deleted")
            return True, consumed
        if self._waiting is not None and self._clock() >= self._waiting[0]:
            await self._release(claim, self._waiting[1])
            return True, consumed
        if self._heard_at is not None and self._clock() >= self._heard_at + self._idle_seconds():
            return await self._on_event(claim, Idle()), consumed
        if self._clock() >= self._lease_deadline:
            log.warning("claim.lease_expired", extra={"claim_id": claim.claim_id})
            if self._feed is not None:
                self._feed.unbind(LEASE_EXPIRED)
            await self._leave()
            return True, consumed
        self._due_posts(claim)
        if (self._occurrence is not None and self._clock() >= self._next_promote
                and await self._promote(claim)):
            return True, consumed
        return self._clock() >= self._next_beat and await self._beat_or_leave(claim), consumed

    async def _wait_or_stop(self, future: asyncio.Future, timeout: float) -> None:
        """Waits for `future` up to `timeout`, waking at once on a stop: the drain budget
        runs from the signal."""
        stop = asyncio.ensure_future(self._stopping.wait())
        try:
            await asyncio.wait({future, stop}, timeout=timeout,
                               return_when=asyncio.FIRST_COMPLETED)
        finally:
            stop.cancel()

    async def _drain_events(self, claim: Claim) -> bool:
        """Acts on the events already queued; True when one of them ended the claim."""
        while True:
            event = asyncio.ensure_future(self._bridge.next_event())
            await asyncio.sleep(0)
            if not event.done():
                event.cancel()
                return False
            if await self._on_event(claim, _outcome(event)):
                return True

    async def _beat(self, claim: Claim, *, retry_epoch: bool = True) -> str:
        """Heartbeats the claim: RENEWED, LOST (no longer this bot's) or UNSURE."""
        started = self._clock()
        self._next_beat = started + self._heartbeat_every
        try:
            token = await self._backend.heartbeat(claim, self._epoch, {
                **self._status, **self._feed_address(), **self._error()})
        except BackendError as exc:
            if exc.code == "stale_claim":
                log.info("claim.stale", extra={"claim_id": claim.claim_id})
                return LOST
            if exc.code == "stale_epoch" and retry_epoch:
                return await self._declare_above_current(claim)
            self._failed("claim.heartbeat_failed", exc)
            return UNSURE
        except httpx.RequestError as exc:
            self._failed("claim.heartbeat_failed", exc)
            return UNSURE
        # The backend renewed the lease when it handled the request, no earlier than this.
        self._failures = 0
        self._lease_deadline = started + self._lease_seconds
        self._feed_token = token or self._feed_token
        if self._pusher is not None and self._recorded is not None:
            self._pusher.start(self._recorded, self._epoch)  # the epoch is registered
            self._serve_feed(claim)
        return RENEWED

    async def _beat_or_leave(self, claim: Claim) -> bool:
        """Heartbeats the claim and leaves the meeting if it is no longer this bot's; True
        when it is gone."""
        if await self._beat(claim) == LOST:
            await self._leave()
            return True
        return False

    async def _declare_above_current(self, claim: Claim) -> str:
        """The occurrence already used this epoch: start a new stream above its highest."""
        try:
            current = await self._backend.assignment()
        except FAILURES as exc:
            self._failed("claim.heartbeat_failed", exc)
            return UNSURE
        if current is None or current.claim_id != claim.claim_id:
            return LOST
        self._epoch = current.next_epoch
        return await self._beat(claim, retry_epoch=False)

    async def _on_event(self, claim: Claim, event) -> bool:
        """Acts on a meeting event; True when the bot is done with this claim."""
        match event:
            case Joined():
                self._joined_at = self._heard_at = self._clock()
                self._status = {"state": "in_meeting", "joined": True}
                if self._feed is not None:
                    await self._feed.admitted(datetime.now(UTC).isoformat())
                self._waiting = None
                if not self._stopping.is_set():
                    self._listen()
                # While stopping, events are read only for their outcome: no new backend
                # call may spend the drain budget before the bot leaves.
                if not self._stopping.is_set() and await self._beat_or_leave(claim):
                    return True
                if not (self._stopping.is_set() or self._chat_armed):
                    self._arm_chat(claim)
            case WaitingRoom() | WaitingForHost():
                self._status = {"state": "waiting_room" if isinstance(event, WaitingRoom) else "waiting_for_host", "joined": False}
                reason = WAITS[type(event)]
                served = self._served()
                minutes = (served.waiting_room_min if isinstance(event, WaitingRoom)
                           else served.wait_for_start_min)
                if minutes == 0:
                    self._waiting = None  # the admin set no limit on this wait
                elif self._waiting is None or self._waiting[1] != reason:  # a new wait
                    self._waiting = self._clock() + minutes * 60.0, reason
            case OccurrenceKnown(occurrence_uuid=occurrence, meeting_title=title):
                self._occurrence = occurrence
                self._meeting_title = title
            case ChatMessage(sender=sender, text=text):
                at = int((self._clock() - self._joined_at) * 1000)
                put_dropping_oldest(self.segments,
                                    Segment(next(self._seqs), sender, text, at, at, "chat"))
            case Failed(reason=reason):
                await self._release(claim, reason if REASON.fullmatch(reason) else "bridge_failed")
                return True
            case Removed():
                await self._release(claim, "removed_by_host")
                return True
            case Ended() | Alone() | Idle() | Left():
                now = self._clock()
                await self._push_rest(min(self._final_seconds, self._stop_deadline - now,
                                          self._lease_deadline - now - BRIDGE_CALL_SECONDS),
                                      complete=isinstance(event, Ended | Alone))
                # Left alone, the bot's leave is what lets Zoom end the meeting (QOR-4887).
                # Idle, or taken out by Zoom for a reason that does not say the meeting is
                # over, people may still be in it: Zoom's meeting.ended ends it (QOR-4893,
                # QOR-5113).
                reason = event.reason if isinstance(event, Left) else ENDINGS[type(event)]
                await self._release(claim, reason, meeting_ended=isinstance(event, Ended))
                return True
        return False

    async def _publish(self, epoch: int, segments: list) -> None:
        """Stored segments go out on the feed, in seq order (persistence first).
        The feed is a latency layer over the stored transcript, so its failure never stops
        the push."""
        if self._feed is None:
            return
        try:
            for segment in segments:
                await self._feed.publish(transcript_frame(self._recorded, epoch, segment))
        except Exception as exc:  # noqa: BLE001 - capture reads the stored transcript anyway
            log.error("feed.publish_failed", extra={"error": type(exc).__name__})

    def _arm_chat(self, claim: Claim) -> None:
        """On joining, once per claim, so a reconnect posts nothing again: the agenda, or the
        hello line when nothing carried over, and when the timed posts are due, if the
        meeting has a scheduled end. One whose time has passed is never posted late. With the
        admin's chat posts off, none; with the agenda off, nothing on joining, not even the
        hello, which would claim nothing carried over (QOR-4966)."""
        self._chat_armed = True
        if not self._served().chat_posts_enabled:
            return
        if claim.scheduled_end is not None:
            left = (claim.scheduled_end - datetime.now(UTC)).total_seconds()
            now = self._clock()
            self._warn_at = now + left - WARNING_SECONDS if left > WARNING_SECONDS else None
            self._time_up_at = now + left if left > 0 else None
        if self._served().chat_agenda_enabled:
            self._in_background(self._agenda(claim))

    def _due_posts(self, claim: Claim) -> None:
        if self._warn_at is not None and self._clock() >= self._warn_at:
            self._warn_at = None
            self._in_background(self._warning(claim))
        if self._time_up_at is not None and self._clock() >= self._time_up_at:
            self._time_up_at = None
            self._in_background(self._post(TIME_UP))

    def _in_background(self, post: Awaitable[None]) -> None:
        """A chat post runs beside the claim loop, so a slow card service or chat send never
        holds up a heartbeat or the transcript. The claim's end cancels any still running."""
        async def unless_claim_lost() -> None:
            with contextlib.suppress(ClaimLost):
                await post

        task = asyncio.ensure_future(unless_claim_lost())
        self._posts.add(task)
        task.add_done_callback(self._posts.discard)

    async def _agenda(self, claim: Claim) -> None:
        """One post on joining: the card service's summary of what carried over, or the count
        of each kind when it has none, or a hello when nothing did. Nothing when the backend
        cannot say, since a hello would claim nothing carried over."""
        agenda = await self._chat_cards(claim, "agenda")
        if agenda is None:
            return
        # A card service from before the kinds sends none: no count, and no hello either.
        said = (agenda.get("summary") or agenda_count(agenda["cards"])) if agenda["cards"] else HELLO
        if said:
            await self._post(said)

    async def _warning(self, claim: Claim) -> None:
        questions = await self._chat_cards(claim, "questions")
        await self._post(warning(questions["cards"] if questions else []))

    async def _chat_cards(self, claim: Claim, kind: str) -> dict | None:
        """What a post says (BackendClient.chat_cards), or None when the backend cannot say.
        Once the claim is no longer this bot's, ClaimLost: the post is dropped."""
        try:
            return await self._backend.chat_cards(claim, kind)
        except FAILURES as exc:
            if isinstance(exc, BackendError) and exc.code == "stale_claim":
                raise ClaimLost from exc
            log.warning("chat.cards_failed", extra={"error": _code(exc), "list": kind})
            return None

    async def _stop_posts(self) -> None:
        """Ends the chat posts under way, first thing when the bot sets out to leave: none may
        go out once the claim is over."""
        for post in self._posts:
            post.cancel()
        await asyncio.gather(*self._posts, return_exceptions=True)

    async def _post(self, text: str) -> None:
        """One chat post. A post that fails is logged, never retried: it never costs the
        meeting."""
        try:
            await asyncio.wait_for(self._bridge.send_chat(text), self._bridge_budget())
        except Exception as exc:  # noqa: BLE001 - a chat post never ends the claim
            log.warning("chat.post_failed", extra={"error": type(exc).__name__})
            return
        log.info("chat.handed_to_bridge")  # Zoom's answer is logged when it comes (zoom.chat_sent)

    def _serve_feed(self, claim: Claim) -> None:
        """The occurrence is recorded and the epoch registered: the feed serves the claim, if
        the backend issued a token and capture can dial this task (a private IPv4 address;
        found once). A new token (a key rotation) closes the open feed."""
        if self._feed is None or self._feed_token is None:  # a backend with no feed
            return
        if self._feed_host is None:  # found once; a failed lookup is tried again
            host = self._find_feed_host()
            if dialable(host):
                self._feed_host = host
            else:
                log.warning("feed.unreportable")
        if self._feed_host:
            first = self._feed.binding is None
            self._feed.bind(Binding(self._bot_id, claim.claim_id, claim.generation,
                                    self._recorded, self._epoch, self._feed_token))
            if first:  # tell the backend where to dial now, not a heartbeat interval later
                self._next_beat = self._clock()

    def _error(self) -> dict:
        """The transcription error for the heartbeat (a machine code), only while there is
        one: the backend stores each report whole, so leaving it out clears it."""
        error = self._transcription_error()
        return {} if error is None else {"error": error}

    def _feed_address(self) -> dict:
        """feed_host and feed_port for the heartbeat, only while the feed serves the claim."""
        if self._feed is None or self._feed.binding is None:
            return {}
        return {"feed_host": self._feed_host, "feed_port": self._feed.port}

    async def _push_rest(self, bound: float, *, complete: bool) -> None:
        """Pushes everything queued within `bound` seconds, the last push with `complete`.
        At the meeting's end (complete) the rest of its audio is transcribed first, and once
        complete: true is stored the feed says meeting_ended; on a stop the audio is cut off.
        A stop arriving meanwhile cuts the push short like a call in flight. The meeting's
        end is bounded by FINAL_SECONDS and the lease, since no heartbeat runs meanwhile."""
        await self._stop_posts()
        if self._pusher is None:  # the join never completed: nothing was heard
            return
        if not complete and self._audio is not None:
            self._audio.cancel()
        try:
            async with asyncio.timeout(max(0.0, bound)) as self._final:
                if self._audio is not None:
                    await asyncio.wait({self._audio})
                await self._pusher.finish(complete=complete)
                if complete and self._pusher.completed and self._feed is not None:
                    # Only after complete: true is stored, and before the release.
                    await self._feed.publish({"type": "meeting_ended",
                                              "occurrence_id": self._recorded})
        except TimeoutError:
            self._pusher.cancel()  # the bound covers the whole drain, retries included
            log.warning("transcript.final_timed_out")
        except Exception as exc:  # noqa: BLE001 - a broken push must not keep the bot in
            log.error("transcript.final_failed", extra={"error": type(exc).__name__})
        finally:
            self._final = None

    def _listen(self) -> None:
        """Starts transcribing the meeting's audio, once per claim. A failure there ends
        the audio only, never the claim."""
        if self._transcribe is None or self._audio is not None:
            return
        self._audio = asyncio.create_task(
            transcribe_audio(self._bridge.audio(), self._transcribe, self.segments,
                             self._seqs, correct=self._correct_segment))
        self._audio.add_done_callback(_audio_done)

    def _heard(self) -> Iterator[int]:
        """The meeting's segment numbers: each one taken is something said, which puts off
        the idle leave."""
        for seq in itertools.count():
            self._heard_at = self._clock()
            yield seq

    def _served(self) -> Settings:
        """What the backend serves every bot, or the defaults without a settings poller."""
        return (self._settings.current if self._settings else None) or Settings()

    def _idle_seconds(self) -> float:
        return self._served().idle_leave_min * 60.0

    def _correct_segment(self, segment: Segment) -> Segment:
        return self._settings.current.dictionary.correct(segment) if self._settings else segment

    def _join_options(self, presence_frame: str | None) -> JoinOptions:
        """The served name; unmuted, as bwat never speaks, with its picture as its video;
        per-participant audio always on (QOR-5121)."""
        return JoinOptions(self._served().display_name, presence_frame=presence_frame)

    async def _presence_frame(self) -> str | None:
        """The frame this join shows (D196). BWAT_BOT_PRESENCE_IMAGE wins, rendered at start
        (__main__). Otherwise the admin's picture, fetched once per join and rendered only
        when it changed; with none, or when it cannot be fetched or used, the bundled logo.
        The picture is cosmetic: nothing here stops the join."""
        if self._config.presence_image:
            return presence.FRAME_PATH
        etag = self._presence_shown if self._presence_shown != DEFAULT else None
        try:
            status, body, tag = await self._backend.presence_image(etag)
            if status == 304:
                return presence.FRAME_PATH
            if status == 200:
                # Rendering takes a moment: off the event loop, so heartbeats keep going.
                await asyncio.to_thread(presence.write_frame, io.BytesIO(body), presence.FRAME_PATH)
                self._presence_shown = tag
                return presence.FRAME_PATH
        except FAILURES as exc:
            log.warning("presence.fetch_failed", extra={"error": _code(exc)})
            # A blip keeps the admin's picture already shown; only with none is it the logo.
            if self._presence_shown not in (None, DEFAULT):
                return presence.FRAME_PATH
        except (OSError, ValueError) as exc:
            log.error("bot.presence_image_invalid", extra={"error": str(exc)})
        if self._presence_shown != DEFAULT:
            try:
                await asyncio.to_thread(presence.write_frame, presence.DEFAULT_IMAGE, presence.FRAME_PATH)
            except (OSError, ValueError) as exc:
                log.error("bot.presence_image_invalid", extra={"error": str(exc)})
                self._presence_shown = None
                return None
            self._presence_shown = DEFAULT
        return presence.FRAME_PATH

    async def _promote(self, claim: Claim) -> bool:
        """Records the occurrence Zoom reported; True when that ends the claim. A transport
        failure keeps it pending, so the next turn tries again."""
        try:
            view = await self._backend.occurrence(claim, self._occurrence, self._meeting_title)
        except BackendError as exc:
            if exc.code in ("stale_claim", "meeting_already_ended"):
                # The backend has ended the claim; there is nothing to hand back.
                log.info("claim.ended_by_backend",
                         extra={"claim_id": claim.claim_id, "error": exc.code})
                await self._leave()
                return True
            if exc.code == "occurrence_conflict":
                # A claim's occurrence never changes: this meeting is over for this claim. Not
                # meeting_ended: the bot may be in another occurrence that is still running.
                await self._release(claim, "occurrence_conflict")
                return True
            self._failed("claim.occurrence_failed", exc)
            if exc.status < 500 and exc.status not in TRANSIENT:
                self._occurrence = None  # a refusal that will not change on a retry
            self._next_promote = self._clock() + self._next_wait()
            return False
        except httpx.RequestError as exc:
            self._failed("claim.occurrence_failed", exc)
            self._next_promote = self._clock() + self._next_wait()
            return False
        self._recorded, self._occurrence = self._occurrence, None
        if view.transcript_epoch is not None and view.transcript_epoch > self._epoch:
            # The epoch declared before promotion was below the occurrence's highest.
            self._epoch = view.transcript_epoch + 1
        # Always confirm with a heartbeat. A highest equal to the declared epoch looks the same
        # whether the claim kept it or another holder used it first; if it was dropped, this
        # beat gets stale_epoch and re-declares at once, before any transcript is pushed.
        return await self._beat_or_leave(claim)

    async def _release(self, claim: Claim, reason: str, *, meeting_ended: bool = False,
                       requeue: bool = False) -> None:
        """Leaves, then hands the claim back, retrying until the backend answers or the
        lease would have lapsed anyway (the backend then ends the claim itself). Never
        after a leave that did not complete while the meeting may still be running: the
        bot may still be in it, and a release would send a second bot in. Once Zoom said
        the meeting itself is over (meeting_ended), no second bot can join it, so the
        release goes out regardless (QOR-5113), but only once the bot is withdrawn, so it
        is not handed a new claim before it exits for a fresh bridge; and its retries are
        cut short, so it exits soon."""
        if not await self._leave() and not (meeting_ended and await self._withdraw("bridge_stuck")):
            return
        # A stuck bot retries for one backoff at most: it must exit for a fresh bridge.
        stuck_until = self._clock() + BACKOFF_CAP_SECONDS if self._bridge_stuck else float("inf")
        while True:
            try:
                await self._backend.release(claim, reason, meeting_ended=meeting_ended,
                                            requeue=requeue)
            except BackendError as exc:
                if exc.status in (400, 409):  # settled: refused, or no longer this bot's
                    self._failed("claim.release_refused", exc)
                    return
                self._failed("claim.release_failed", exc)
            except httpx.RequestError as exc:
                self._failed("claim.release_failed", exc)
            else:
                self._failures = 0
                log.info("claim.released", extra={"claim_id": claim.claim_id, "reason": reason})
                return
            if self._clock() >= min(self._lease_deadline, self._stop_deadline, stuck_until):
                return
            wait = self._next_wait()
            if self._stopping.is_set():
                await asyncio.sleep(min(wait, max(0.0, self._stop_deadline - self._clock())))
            else:
                await self._sleep(wait)  # a stop wakes it, so the drain starts at once

    async def _hand_back(self, claim: Claim) -> None:
        """SIGTERM drain, first part (D82), within DRAIN_SECONDS of the signal: push what is
        queued, leave the meeting, then requeue the claim (which also withdraws the bot),
        then withdraw explicitly. Each backend call is bounded by the drain deadline."""
        # The requeue may be retried until the drain deadline. The lease deadline must not
        # end the retries first; it is stale when no heartbeat for this claim got through.
        self._lease_deadline = max(self._lease_deadline, self._clock() + self._lease_seconds)
        # What was heard but not pushed goes out first, in half the budget: leaving and the
        # requeue keep the rest.
        await self._push_rest((self._stop_deadline - self._clock()) / 2, complete=False)
        try:
            async with asyncio.timeout(max(0.0, self._stop_deadline - self._clock())):
                await self._release(claim, STOP_REASON, requeue=True)
                await self._withdraw("stopping")
        except TimeoutError:
            log.warning("claim.drain_timed_out", extra={"claim_id": claim.claim_id})

    async def _leave(self) -> bool:
        """Leaves the meeting; False when the bridge did not confirm it, by timing out or
        raising. The bot then takes no more meetings (it reports not ready) until the
        bridge is replaced, since it may still be in the meeting. The feed closes first:
        the claim is over for capture as soon as the bot sets out to leave."""
        await self._stop_posts()
        if self._feed is not None:
            self._feed.unbind(CLAIM_OVER)
        try:
            await asyncio.wait_for(self._bridge.leave(), self._bridge_budget())
        except Exception as exc:  # noqa: BLE001 - any failure leaves the bridge unconfirmed
            self._bridge_stuck = True
            log.error("bridge.leave_failed", extra={"error": type(exc).__name__})
            await self._withdraw("bridge_stuck")
            return False
        # Only the bridge's confirmation proves departure. A lost acknowledgement
        # leaves the board's bounded cooldown in place, but must not strand the bot.
        if self._stopping.is_set():
            return True  # keep the shutdown budget for releasing the claim
        try:
            async with asyncio.timeout(min(1.0, self._bridge_budget())):
                await self._backend.idle()
        except (TimeoutError, *FAILURES) as exc:
            log.warning("bot.idle_report_failed", extra={"error": type(exc).__name__})
        return True

    def _bridge_budget(self) -> float:
        """How long a bridge call may take: BRIDGE_CALL_SECONDS, or less once stopping."""
        return min(BRIDGE_CALL_SECONDS, max(0.0, self._stop_deadline - self._clock()))

    # Pacing ------------------------------------------------------------------------

    def _failed(self, event: str, exc: Exception) -> None:
        self._failures += 1
        log.warning(event, extra={"error": _code(exc)})

    def _next_wait(self) -> float:
        return next_wait(self._tick, max(self._failures, self._claim_failures))

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopping.wait(), seconds)
        except TimeoutError:
            pass


def warning(questions: list[dict]) -> str:
    """The five-minute warning: then the open questions nobody owns, a line each, as many as
    fit in CHAT_LIST_CHARS."""
    heading = "Open questions with no owner:"
    lines = ["Five minutes left."] + ([heading] if questions else [])
    size, listed = len(heading) if questions else 0, 0
    for card in questions:
        line = f"{card.get('display_id', '')} {card.get('title', '')}".strip()
        if listed and size + len(line) > CHAT_LIST_CHARS:
            break
        lines.append(line)
        size, listed = size + len(line), listed + 1
    if listed < len(questions):
        lines.append(f"and {len(questions) - listed} more on the board")
    return "\n".join(lines)


def agenda_count(cards: list[dict]) -> str | None:
    """"Open from last time: 1 to-do, 2 questions." for the cards, or None for none."""
    counts = [(word, sum(c.get("kind") == kind for c in cards)) for kind, word in KIND_WORDS.items()]
    named = [f"{n} {word if n == 1 else word + 's'}" for word, n in counts if n]
    return f"Open from last time: {', '.join(named)}." if named else None


def _outcome(event: asyncio.Future):
    """A completed bridge event, or Failed("bridge_failed") when reading it raised (the
    bridge went away), so a broken bridge releases the claim instead of killing the bot."""
    exc = event.exception()
    if exc is None:
        return event.result()
    log.error("bridge.event_failed", extra={"error": type(exc).__name__})
    return Failed("bridge_failed")


class ClaimLost(Exception):
    """The claim is no longer this bot's: a chat post under way is dropped."""


def discover_feed_host(backend_host: str) -> str | None:
    """This task's own address toward the backend (a UDP connect sends nothing)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect((backend_host, 443))
            return probe.getsockname()[0]
    except OSError:
        return None


RFC1918 = tuple(ipaddress.IPv4Network(n) for n in ("10.0.0.0/8", "172.16.0.0/12",
                                                       "192.168.0.0/16"))


def dialable(host: str | None) -> bool:
    """An RFC 1918 IPv4 address, as capture and the backend require."""
    try:
        address = ipaddress.IPv4Address(host or "")
    except ValueError:
        return False
    return any(address in network for network in RFC1918)


def _audio_done(task: asyncio.Task) -> None:
    if task.cancelled() or (exc := task.exception()) is None:
        return
    # The audio runs in a TaskGroup, so name what failed inside it, not the group.
    causes = exc.exceptions if isinstance(exc, BaseExceptionGroup) else (exc,)
    log.error("audio.failed", extra={"error": ",".join(type(c).__name__ for c in causes)})


def next_wait(tick: float, failures: int) -> float:
    """The idle tick with ±20 % jitter, or after failures an exponential backoff with full
    jitter capped at BACKOFF_CAP_SECONDS, so a fleet does not retry in step."""
    if failures == 0:
        return tick * random.uniform(0.8, 1.2)
    ceiling = min(BACKOFF_CAP_SECONDS, tick * 2 ** min(failures, 10))
    return random.uniform(tick, max(tick, ceiling))


def _code(exc: Exception) -> str:
    """An error's machine code for a log line: never its message, which may carry a URL."""
    if isinstance(exc, BackendError):
        known = isinstance(exc.code, str) and exc.code in KNOWN_CODES
        return f"{exc.status}:{exc.code if known else 'other'}"
    return type(exc).__name__
