"""The transcript push (persistence first; Track 3).

What was said goes to POST /meetings/{occurrence}/transcript in batches of up to BATCH
segments or about LINGER_SECONDS, one push in flight, in seq order, at the claim's epoch.
Nothing is pushed until the backend has recorded the occurrence and a heartbeat has
registered the epoch. A timeout or a 5xx retries the same batch; a 409 that settles the
epoch or the claim (stale_epoch, stale_claim, meeting_deleted) drops what is queued and ends
the push for the claim. Segments wait only in memory, in the claim's bounded queue.

Logs carry event names and counts only, never the words.
"""
import asyncio
import logging
from collections.abc import Awaitable, Callable

import httpx

from bwat_bot.audio import Segment, put_dropping_oldest
from bwat_bot.backend import BackendClient, BackendError

log = logging.getLogger("bwat_bot")

BATCH = 20
LINGER_SECONDS = 1.0
RETRY_SECONDS = 1.0
SETTLED = frozenset({"stale_epoch", "stale_claim", "meeting_deleted"})
# 4xx answers a retry can change, as the lifecycle treats them: an expired token, a
# timeout, a rate limit.
TRANSIENT = frozenset({401, 408, 429})

Stored = Callable[[int, list[Segment]], Awaitable[None]]


class Pusher:
    def __init__(self, backend: BackendClient, segments: asyncio.Queue, *,
                 on_stored: Stored | None = None,
                 linger_seconds: float = LINGER_SECONDS) -> None:
        self._backend = backend
        self._segments = segments
        self._epoch = 0
        self._on_stored = on_stored
        self._linger = linger_seconds
        self._occurrence: str | None = None
        self._ready = asyncio.Event()
        self._task = asyncio.create_task(self._run())
        self._complete = True
        self.deleted = False  # the backend deleted the meeting: release the claim
        self.completed = False  # the push with complete: true was stored

    def start(self, occurrence: str, epoch: int) -> None:
        """The backend recorded `occurrence` for the claim and accepted a heartbeat at
        `epoch`: pushing may begin, at that epoch for the whole claim. Called again, it
        changes nothing; if the epoch changes later, its pushes are refused (stale_epoch)
        and the push ends."""
        if self._occurrence is None:
            self._occurrence, self._epoch = occurrence, epoch
            self._ready.set()

    def cancel(self) -> None:
        self._task.cancel()

    async def finish(self, *, complete: bool = True) -> None:
        """Pushes everything queued, the last push with `complete` (when false and nothing
        is left, no last push is made). The caller stops adding segments first."""
        self._complete = complete
        if not self._ready.is_set():
            self._task.cancel()  # no occurrence recorded: nothing can be pushed
            return
        put_dropping_oldest(self._segments, None)
        await asyncio.shield(self._task)

    async def _run(self) -> None:
        await self._ready.wait()
        while True:
            batch, last = await self._batch()
            final = last and self._complete
            if (batch or final) and not await self._push(batch, complete=final):
                return
            if last:
                return

    async def _batch(self) -> tuple[list[Segment], bool]:
        """Up to BATCH segments: the first awaited, the rest for up to the linger. True
        when the end marker was reached."""
        item = await self._segments.get()
        if item is None:
            return [], True
        batch = [item]
        deadline = asyncio.get_running_loop().time() + self._linger
        while len(batch) < BATCH:
            try:
                async with asyncio.timeout_at(deadline):
                    item = await self._segments.get()
            except TimeoutError:
                break
            if item is None:
                return batch, True
            batch.append(item)
        return batch, False

    async def _push(self, batch: list[Segment], *, complete: bool) -> bool:
        """Pushes one batch until the backend settles it; False when the push is over."""
        epoch = self._epoch
        while True:
            try:
                stored = await self._backend.transcript(self._occurrence, epoch, batch, complete)
            except BackendError as exc:
                if exc.code in SETTLED:
                    self._abandon(exc.code, len(batch))
                    return False
                if exc.status < 500 and exc.status not in TRANSIENT:  # e.g. transcript_complete
                    log.error("transcript.refused", extra={"error": f"{exc.status}"})
                    return True
                log.warning("transcript.push_failed", extra={"error": f"{exc.status}"})
            except httpx.RequestError as exc:
                log.warning("transcript.push_failed", extra={"error": type(exc).__name__})
            else:
                self.completed = complete
                if self._on_stored is not None:
                    await self._on_stored(epoch, stored if stored is not None else batch)
                return True
            await asyncio.sleep(RETRY_SECONDS)

    def _abandon(self, code: str, count: int) -> None:
        while not self._segments.empty():
            if self._segments.get_nowait() is not None:
                count += 1
        self.deleted = code == "meeting_deleted"
        event = "transcript.deleted" if self.deleted else "transcript.abandoned"
        log.warning(event, extra={"error": code, "count": count})
