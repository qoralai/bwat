"""The writer loop: each meeting's buffered lines past the saved position, read as one
window (slice C5, QOR-4658).

A meeting's first window is read at once, so the first card lands within seconds of the
first words; after that a meeting is read when 30 lines are waiting, 60 s after its last
read if fewer are, or at once when the meeting has finished (its last window). A window
holds at most 200 lines, so a backlog (after a restart) is read in turns rather than as
one prompt too long to answer. Each window comes with the 60 lines before it on the
meeting's timeline, to read but never to cite (QOR-4722), so a commitment said across two
windows is seen whole: the buffer keeps a live meeting's read lines, so they are taken
from there, and after a restart the stored read fills it from the first line again.
After a failed window, whatever failed (the model, its reply, or the database), the
meeting waits the 60 s before it is tried again, so a missing or refused model key is
not paid for on every tick, and the other meetings are still read. The position lives in
cards.capture_positions and moves only with the cards it produced (read_window); the
loop holds no position of its own. A finished meeting with nothing left to read leaves
the buffer. Behaviour reference: the prototype's agent.py tick and run_pass; nothing is
copied from it.

The buffer is capture.buffer.Buffer: lines per meeting (a str UUID), the finished set, a
locked snapshot of both, and forget(), which drops a finished meeting only if nothing
arrived since the snapshot (the stored read runs in another thread).

The model's address, model and key come from the backend's GET /v1/cards/settings under
the card service's credential (D179): {"base_url", "model", "api_key"}, the key already
chosen by the backend for that address (null: none, or withheld because no endpoint of
the model keeps no data). They are read every 30 s with the last answer's ETag, so an
unchanged answer is a 304, and a failed read keeps the last good settings (QOR-4769).

A model call answered 404 means the model is gone for good: the writer pauses
rather than paying for the same answer on every window. Every meeting with lines waiting
shows "paused" on the board with the error model_unavailable, and the card API serves the
pause to the backend for the admin panel. Any new settings answer ends it: an admin's save,
another address or model, a key served or withheld, a ZDR verdict that flipped (the backend's
ETag covers all of it, so only a change is a new answer). The next pass tells whether the
model now answers. Nothing retries on a timer: by decision, a model-gone 404 waits for a
person, and the new-answer rule is the one safety net.

When Jev is available for a meeting (QOR-4769: Use Jev on, the backend found every
endpoint of its model on OpenRouter's zero-data-retention list, and a key for it), the
meeting is not read on the cadence above. It is read on its first window, at its end, when
more than 200 lines wait (in 200-line windows), when its oldest unread line has waited the
deadline (by the line's created_at, else the time it arrived here), or when Jev scores the
new lines at the threshold or above. Jev is asked inline, at most every 5 s per meeting and
only when lines arrived since it was last asked, never when one of the other rules reads
the meeting anyway, and for at most 4 s a tick (the meetings left are asked on the next); no two reads of a meeting are less than 5 s apart, and a failed
window's 60 s wait still wins. Any Jev failure puts the meeting on the cadence for 30 s.
"""

import functools
import logging
import threading
import time
from datetime import datetime
from types import SimpleNamespace

import httpx
import psycopg
from psycopg.types.json import Jsonb

from writer import jev as jev_state
from writer import lifecycle
from writer.limits import BACKOFF, LEASE, RECONCILE_LOCK, RECONCILIATION_ATTEMPTS, TRY_LOCK, UNLOCK
from writer.model import (
    MODEL_UNAVAILABLE,
    OUT_OF_CREDIT,
    JevClient,
    ModelError,
    model_http,
    writer_model,
)
from writer.window import board_digest, read_window

EVERY_S = 60
EVERY_LINES = 30
WINDOW_LINES = 200
CONTEXT_LINES = 60
# How long the board shows a pass's phase before it reads as idle.
ACTIVITY_TTL_S = 60
SETTINGS_EVERY_S = 30  # between settings reads; an unchanged answer is a 304
JEV_EVERY_S = 5  # at most one Jev check per meeting in this long
MIN_GAP_S = 5  # between two reads of a meeting while Jev paces it
JEV_HOLD_S = 30  # the cadence paces a meeting this long after a Jev failure
JEV_TICK_BUDGET_S = 4  # Jev time a tick may spend; past it the meetings left are not asked (QOR-4769)

log = logging.getLogger("cards.writer")


# What a failed settings read raises: the backend down or refusing, or an answer that is not
# the settings (bad JSON, a missing key, a wrong type).
SETTINGS_UNAVAILABLE = (httpx.HTTPError, ValueError, KeyError, TypeError)

class WriterLoop:
    def __init__(self, dsn, buffer, backend, model_transport=None, clock=time.monotonic, wall=time.time):
        self._dsn = dsn
        self._buffer = buffer
        self._backend = backend
        self._model_transport = model_transport
        self._clock = clock
        self._settings = None
        self._etag = None
        self._settings_due = float("-inf")
        # The tick and the reconciliation thread share this reader (QOR-4769).
        self._settings_lock = threading.Lock()
        self._last_pass = {}
        self._failed = set()
        self._reconcile_outages = {}
        self._wall = wall
        # Jev pacing (QOR-4769), per meeting: when Jev may be asked again after a failure,
        # when it was last asked and the newest line it saw, and when each unread line
        # first arrived here. The board as Jev reads it, with its watermark.
        self._jev_hold = {}
        self._jev_asked = {}
        self._arrived = {}
        self._board = None
        self._jev_spent = 0.0
        # {meeting_id: what its last pass did}, read by the card API for the board's
        # activity word (GET /v1/occurrences/{id}/activity). Phases only, never text.
        self.activity = {}
        # The pause on a gone model, {"model", "error"}, for GET /v1/writer/status; a new
        # settings answer clears it (_read_settings_locked).
        self.paused = None

    def tick(self):
        if self.paused is not None:
            # Read while paused even with no meeting waiting, so a save ends the pause at once.
            try:
                self._read_settings()
            except SETTINGS_UNAVAILABLE:
                pass
        unread = self._unread()
        if not unread:
            return
        try:
            settings = self._read_settings()
        except SETTINGS_UNAVAILABLE as err:
            # The backend is down or has no settings yet: these meetings wait 60 s too.
            due = self._due(unread)
            for meeting_id in due:
                self._last_pass[meeting_id] = self._clock()
                self._failed.add(meeting_id)
            if due:
                log.warning("card settings unavailable: %s", type(err).__name__)
            return
        if self.paused is not None:
            for meeting_id in unread:
                self._show(meeting_id, "paused", MODEL_UNAVAILABLE)
            return
        with model_http(settings, self._model_transport) as http:
            jev = settings.jev and JevClient(http, settings.jev.model, settings.jev.api_key, self._clock)
            due = self._due(unread, jev, settings.jev)
            model = writer_model(http, settings, cache_rules=True)
            for meeting_id, (window, context) in due.items():
                self._show(meeting_id, "extracting")
                usage = {}
                try:
                    result = read_window(self._dsn, meeting_id, window, model, context, settings.granularity, usage)
                except Exception as err:  # noqa: BLE001
                    result = {"error": type(err).__name__}
                self._last_pass[meeting_id] = self._clock()
                # One line per answered call, numbers only (QOR-5079): what it spent, and what the
                # cache saved of it. A call that failed before an answer (transport, HTTP) has none.
                if usage:
                    log.info("window usage meeting=%s in=%r out=%r cache_read=%r cache_write=%r cost=%r",
                             meeting_id, *(usage.get(k) for k in ("in", "out", "cache_read", "cache_write", "cost")))
                if result.get("error") == MODEL_UNAVAILABLE and self._pause(settings):
                    self._failed.add(meeting_id)
                    self._show(meeting_id, "paused", MODEL_UNAVAILABLE)
                    break
                self._show(meeting_id, "failed" if "error" in result else "complete",
                           OUT_OF_CREDIT if result.get("error") == OUT_OF_CREDIT else None)
                if "error" in result:
                    self._failed.add(meeting_id)
                    log.warning("window failed meeting=%s lines=%d: %s", meeting_id, len(window), result["error"])
                else:
                    self._failed.discard(meeting_id)
                    log.info("window read meeting=%s lines=%d cards=%d updated=%d refused=%d",
                             meeting_id, len(window), result["cards"], result["updated"], len(result["refused"]))

    def _pause(self, settings):
        """Pauses on the gone model of `settings`, unless a newer settings answer arrived during
        the call (another thread's read): that answer may name a model that works. True when it paused."""
        with self._settings_lock:
            if settings is not self._settings:
                return False
            # MODEL_UNAVAILABLE is only ever a 404 (writer.model.failure).
            self.paused = {"model": settings.model, "error": "not found (404)"}
        log.warning("model not found, the writer pauses until the settings change: model=%s", settings.model)
        return True

    def _show(self, meeting_id, phase, error=None):
        # No pass id: the board would poll every 2 s after each pass waiting for a feed
        # that names it, and bwat's feed names none. Its 15 s poll shows the new cards.
        # `error` is a machine code the board explains (QOR-4738: the model key is out of
        # credit); the next pass that succeeds writes the phase without it.
        self.activity[meeting_id] = {"phase": phase, "expires_at": self._wall() + ACTIVITY_TTL_S}
        if error is not None:
            self.activity[meeting_id]["error"] = error

    def _show_jev(self, meeting_id, word):
        # Jev's part beside the last pass's phase on the board's activity entry (QOR-4769):
        # "waiting" (asked, not due yet) or "unavailable" (failed; on the cadence for 30 s).
        entry = self.activity.get(meeting_id) or {"phase": "stale", "expires_at": self._wall() + ACTIVITY_TTL_S}
        self.activity[meeting_id] = {**entry, "jev": word}

    def _unread(self):
        """{meeting_id: (its lines in order, the index of each unread one, finished)} for
        each meeting with lines past its position."""
        meetings, finished_ones = self._buffer.snapshot()
        # Finished with no lines at all (a meeting where nothing was said).
        for meeting_id in finished_ones - meetings.keys():
            self._forget(meeting_id, 0)
        if not meetings:
            return {}
        with psycopg.connect(self._dsn) as conn:
            positions = {
                (meeting_id, epoch): last_seq
                for meeting_id, epoch, last_seq in conn.execute(
                    "SELECT meeting_id::text, epoch, last_seq FROM cards.capture_positions WHERE meeting_id = ANY(%s::uuid[])",
                    [list(meetings)],
                )
            }
        wall = self._wall()
        found = {}
        for meeting_id, lines in meetings.items():
            ordered = [lines[key] for key in sorted(lines)]
            unread_at = [i for i, f in enumerate(ordered) if f["seq"] > positions.get((meeting_id, f["epoch"]), -1)]
            finished = meeting_id in finished_ones
            arrived = self._arrived.get(meeting_id, {})
            self._arrived[meeting_id] = {key: arrived.get(key, wall)
                                         for key in ((ordered[i]["epoch"], ordered[i]["seq"]) for i in unread_at)}
            if not unread_at:
                if finished:
                    self._forget(meeting_id, len(lines))
                continue
            found[meeting_id] = (ordered, unread_at, finished)
        return found

    def _due(self, meetings, jev=None, jev_settings=None):
        """{meeting_id: (the lines past its position, the lines just before them)} for each
        of `meetings` (from _unread) due a window now: with Jev while it is available for
        the meeting, else on the cadence."""
        now = self._clock()
        board = functools.cache(self._jev_board)  # built at most once a tick, for every meeting
        self._jev_spent = 0.0
        due = {}
        for meeting_id, (ordered, unread_at, finished) in meetings.items():
            unread = [ordered[i] for i in unread_at]
            start = unread_at[0]
            window, context = unread[:WINDOW_LINES], ordered[max(0, start - CONTEXT_LINES) : start]
            if jev and self._jev_hold.get(meeting_id, float("-inf")) <= now:
                ready = self._jev_due(meeting_id, unread, window, context, finished, now, jev, jev_settings, board)
            else:
                ready = self._cadence_due(meeting_id, unread, finished, now)
            if ready:
                due[meeting_id] = (window, context)
        return due

    def _cadence_due(self, meeting_id, unread, finished, now):
        waited = now - self._last_pass.get(meeting_id, now - EVERY_S)
        urgent = len(unread) >= EVERY_LINES or finished
        return waited >= EVERY_S or (urgent and meeting_id not in self._failed)

    def _jev_due(self, meeting_id, unread, window, context, finished, now, jev, jev_settings, board):
        waited = now - self._last_pass.get(meeting_id, now - EVERY_S)
        if meeting_id in self._failed:
            return waited >= EVERY_S
        if waited < MIN_GAP_S:
            return False
        if (meeting_id not in self._last_pass or finished or len(unread) > WINDOW_LINES
                or self._waited(meeting_id, unread[0]) >= jev_settings.deadline_s):
            return True
        newest = (unread[-1]["epoch"], unread[-1]["seq"])
        asked_at, seen = self._jev_asked.get(meeting_id, (float("-inf"), None))
        if seen == newest or now - asked_at < JEV_EVERY_S:
            return False
        # Past the tick's budget the meeting is not asked yet: no hold, it is asked next tick (QOR-4769).
        if self._jev_spent >= JEV_TICK_BUDGET_S:
            return False
        # The lines count as seen only once Jev answers: after a failure's hold they are asked again.
        self._jev_asked[meeting_id] = (now, None)
        started = self._clock()
        try:
            # The budget counts the board's read too, the first time a tick builds it.
            score = jev.score(jev_state.state(window, context, board()), jev_state.STATEMENT)
            self._jev_asked[meeting_id] = (now, newest)
        except (ModelError, psycopg.Error) as err:
            self._jev_hold[meeting_id] = self._clock() + JEV_HOLD_S
            self._show_jev(meeting_id, "unavailable")
            log.warning("jev unavailable meeting=%s hold_seconds=%d: %s", meeting_id, JEV_HOLD_S, err)
            return self._cadence_due(meeting_id, unread, finished, now)
        finally:
            self._jev_spent += self._clock() - started
        if score >= jev_settings.threshold_pct / 100:
            return True
        self._show_jev(meeting_id, "waiting")
        return False

    def _waited(self, meeting_id, line):
        """Seconds the line has waited: since its created_at, else since it arrived here."""
        try:
            since = datetime.fromisoformat(line["created_at"]).timestamp()
        except (KeyError, TypeError, ValueError):
            since = self._arrived[meeting_id][(line["epoch"], line["seq"])]
        return self._wall() - since

    def _jev_board(self):
        """The board as Jev reads it, built again only when a card changed (QOR-4769)."""
        with psycopg.connect(self._dsn, connect_timeout=5) as conn:
            mark = conn.execute("SELECT max(updated_at), count(*) FROM cards.cards").fetchone()
            if self._board is None or self._board[0] != mark:
                self._board = (mark, jev_state.board_cards(board_digest(conn)))
        return self._board[1]

    def _forget(self, meeting_id, seen):
        # The stored reader has drained the final transcript. Queue before forgetting so
        # a crash cannot lose the post-meeting pass. Empty meetings need no model call.
        with psycopg.connect(self._dsn) as conn:
            position = conn.execute('SELECT epoch, last_seq FROM cards.capture_positions '
                                    'WHERE meeting_id = %s ORDER BY epoch', [meeting_id]).fetchall()
            if position:
                conn.execute('''INSERT INTO cards.reconciliation_jobs (meeting_id, position) VALUES (%s, %s)
                     ON CONFLICT (meeting_id) DO UPDATE SET position = EXCLUDED.position,
                       completed_at = NULL, retry_at = now(), attempts = 0, queued_at = now()
                     WHERE cards.reconciliation_jobs.position <> EXCLUDED.position''',
                             [meeting_id, Jsonb(position)])
        if self._buffer.forget(meeting_id, seen):
            self._last_pass.pop(meeting_id, None)
            self._failed.discard(meeting_id)
            for pacing in (self._jev_hold, self._jev_asked, self._arrived):
                pacing.pop(meeting_id, None)

    def _reconcile_jobs(self):
        from writer.reconcile import reconcile
        # Paused on a gone model: no attempt is spent on it, as no window is.
        if self.paused is not None:
            return
        # Session advisory lock covers the model call, without holding a row transaction.
        # A second writer cannot run the same job; a crash releases it automatically.
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            jobs = conn.execute('''SELECT j.meeting_id::text, j.position FROM cards.reconciliation_jobs j
                JOIN bwat.v_cards_occurrences o USING (meeting_id)
                WHERE j.completed_at IS NULL AND j.retry_at <= now() AND j.attempts < %s
                  AND o.occurrence_state <> 'live'
                ORDER BY j.retry_at LIMIT 1''', [RECONCILIATION_ATTEMPTS]).fetchall()
            for meeting_id, position in jobs:
                lock = RECONCILE_LOCK + meeting_id
                if not conn.execute(TRY_LOCK, [lock]).fetchone()[0]:
                    continue
                reading_settings = True
                try:
                    # Reserve an attempt before spending, so crashes cannot retry forever. A fresh
                    # connection can finish bookkeeping even if the lock session dies.
                    claimed = self._reconciliation_write(f'''UPDATE cards.reconciliation_jobs
                        SET attempts = attempts + 1, retry_at = now() + {LEASE}
                        WHERE meeting_id = %s AND position = %s AND completed_at IS NULL
                          AND attempts < %s AND retry_at <= now() RETURNING retry_at''',
                        [meeting_id, Jsonb(position), RECONCILIATION_ATTEMPTS])
                    if not claimed:
                        continue
                    lease = claimed[0]
                    settings = self._read_settings()
                    reading_settings = False
                    with model_http(settings, self._model_transport) as http:
                        client = writer_model(http, settings)
                        def complete(*args, meeting_id=meeting_id, position=position, client=client):
                            nonlocal lease
                            # A pass may need several summaries. Renew before each paid
                            # call, and stop if another worker has replaced this lease.
                            renewed = self._reconciliation_write(f'''UPDATE cards.reconciliation_jobs
                                SET retry_at = now() + {LEASE}
                                WHERE meeting_id = %s AND position = %s AND retry_at = %s
                                  AND completed_at IS NULL RETURNING retry_at''',
                                [meeting_id, Jsonb(position), lease])
                            if not renewed:
                                raise psycopg.OperationalError('reconciliation lease unavailable')
                            lease = renewed[0]
                            return client.complete(*args)
                        count = reconcile(self._dsn, meeting_id, SimpleNamespace(complete=complete))
                    completed = self._reconciliation_write(
                        'UPDATE cards.reconciliation_jobs SET completed_at = now() '
                        'WHERE meeting_id = %s AND position = %s AND retry_at = %s RETURNING meeting_id',
                        [meeting_id, Jsonb(position), lease])
                    self._reconcile_outages.pop(meeting_id, None)
                    if completed:
                        log.info('meeting reconciled meeting=%s merged=%d', meeting_id, count)
                except Exception as err:  # noqa: BLE001
                    if isinstance(err, ModelError) and str(err) == MODEL_UNAVAILABLE:
                        self._pause(settings)
                    # Settings and provider availability can recover without a new transcript.
                    # Refund this reservation only for a known availability failure.
                    cause = err.__cause__ if isinstance(err, ModelError) else err
                    repairable_status = (isinstance(cause, httpx.HTTPStatusError) and
                                         (cause.response.status_code in (401, 402, 403, 404, 408, 429)
                                          or cause.response.status_code >= 500))
                    unavailable = (reading_settings or isinstance(cause, (httpx.TransportError, psycopg.OperationalError))
                                   or repairable_status or (isinstance(err, ModelError) and str(err) == OUT_OF_CREDIT))
                    if unavailable:
                        prior_position, failures = self._reconcile_outages.get(meeting_id, (None, 0))
                        failures = failures if prior_position == position else 0
                        delay = min(3600, 60 * 2 ** failures)
                        changed = self._reconciliation_write('''UPDATE cards.reconciliation_jobs SET
                            attempts = attempts - 1, retry_at = now() + %s * interval '1 second'
                            WHERE meeting_id = %s AND position = %s AND completed_at IS NULL
                              AND attempts <= %s AND retry_at = %s RETURNING meeting_id''',
                            [delay, meeting_id, Jsonb(position), RECONCILIATION_ATTEMPTS, lease])
                        if changed:
                            self._reconcile_outages[meeting_id] = (position, min(failures + 1, 6))
                            log.warning('reconciliation unavailable meeting=%s retry_seconds=%d: %s',
                                        meeting_id, delay, type(err).__name__)
                        continue
                    self._reconcile_outages.pop(meeting_id, None)
                    failed = self._reconciliation_write(f'''UPDATE cards.reconciliation_jobs SET
                        retry_at = now() + {BACKOFF}
                        WHERE meeting_id = %s AND position = %s AND completed_at IS NULL
                          AND attempts <= %s AND retry_at = %s RETURNING attempts''',
                        [meeting_id, Jsonb(position), RECONCILIATION_ATTEMPTS, lease])
                    if failed:
                        state = 'exhausted' if failed[0] == RECONCILIATION_ATTEMPTS else 'failed'
                        log.warning('reconciliation %s meeting=%s attempts=%d: %s',
                                    state, meeting_id, failed[0], type(err).__name__)
                finally:
                    if not conn.closed:
                        try:
                            conn.execute(UNLOCK, [lock])
                        except psycopg.Error:
                            log.warning('reconciliation lock connection lost meeting=%s', meeting_id)

    def _hint_checks(self):
        """Jev's duplicate hints (QOR-4770), while Jev is available: queue a check for each
        card's new content, then score one batch."""
        from writer import hints
        settings = self._read_settings()
        if not settings.jev:
            return
        with psycopg.connect(self._dsn) as conn:
            hints.enqueue(conn)
        with model_http(settings, self._model_transport) as http:
            hints.check(self._dsn, JevClient(http, settings.jev.model, settings.jev.api_key, self._clock),
                        settings.jev.link_threshold_pct)

    def _lifecycle(self):
        """Closes the live cards nobody has acted on for 10 days as no response (D194), then
        puts live the drafts of ended meetings whose clean-up is over (writer.lifecycle)."""
        try:
            keyless = not self._read_settings().api_key
        # No settings yet and the backend down: whether the clean-up can run is unknown.
        except SETTINGS_UNAVAILABLE:
            keyless = False
        with psycopg.connect(self._dsn) as conn:
            count = lifecycle.expire(conn)
            lifecycle.go_live(conn, keyless)
        if count:
            log.info("cards closed with no response: %d", count)

    def _reconciliation_write(self, sql, params):
        # Do not reuse the idle lock connection after a potentially long model call.
        # On database outage, the persisted lease delays a new paid attempt after recovery.
        try:
            with psycopg.connect(self._dsn) as conn:
                return conn.execute(sql, params).fetchone()
        except psycopg.Error as err:
            log.warning('reconciliation bookkeeping unavailable: %s', type(err).__name__)
            return None

    def _read_settings(self):
        """The writer's settings from the backend (D179), read again at most every 30 s
        (QOR-4769): an unchanged answer is a 304, and a failed read keeps the last good
        settings and waits the 30 s. With none yet, a failed read raises. One caller at
        a time, so a second never gets no settings while a first read is in flight."""
        with self._settings_lock:
            return self._read_settings_locked()

    def _read_settings_locked(self):
        if self._clock() >= self._settings_due:
            self._settings_due = self._clock() + SETTINGS_EVERY_S
            headers = {"If-None-Match": self._etag} if self._etag else {}
            try:
                response = self._backend.get("/v1/cards/settings", headers=headers)
                if response.status_code != 304:
                    response.raise_for_status()
                    self._settings = settings_of(response.json())
                    self._etag = response.headers.get("etag")
                    # Only a changed answer is a 200: it ends a pause on a gone model.
                    self.paused = None
            except SETTINGS_UNAVAILABLE as err:
                if self._settings is None:
                    # Nothing to keep: the next caller reads again (its own back-off paces it).
                    self._settings_due = float("-inf")
                    raise
                log.warning("card settings unavailable, the last are kept: %s", type(err).__name__)
        return self._settings


def settings_of(body):
    """GET /v1/cards/settings as the writer uses it. `jev` is None unless Jev may be asked:
    Use Jev on, every endpoint of its model keeps no data (zdr.jev), and a key for it."""
    jev = body.get("settings") or {}
    available = (jev.get("jev_enabled") is True and (body.get("zdr") or {}).get("jev") is True
                 and body.get("jev_api_key"))
    return SimpleNamespace(
        base_url=body["base_url"], model=body["model"], api_key=body.get("api_key"),
        # Off only for a model an admin saved past the no-ZDR warning.
        zdr=not body.get("zdr_waived"),
        granularity=jev["cards_granularity"],
        jev=SimpleNamespace(model=jev["jev_model"], api_key=body["jev_api_key"],
                            threshold_pct=int(jev["jev_threshold_pct"]),
                            link_threshold_pct=int(jev["jev_link_threshold_pct"]),
                            deadline_s=int(jev["jev_deadline_s"]))
        if available else None)
