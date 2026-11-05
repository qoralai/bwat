"""The stored read: every live meeting's transcript, read from the backend into the buffer.

This is how the writer gets its lines when no bot feed is bound, and the feed falls back
to it on every connect and drop (D178). The card login reads only two views of the
backend's data (migration 0010), so the transcript itself comes over HTTP under the card
service's credential (D152). Behaviour reference: the prototype's agent.py pass loop;
nothing is copied from it.

A meeting is read while the view says it is live. Once it is not, it gets one last read
and is marked finished, once.
"""

import base64
import json
import logging

import httpx
import psycopg

from writer.limits import RECENT_HOURS, RECONCILIATION_ATTEMPTS

log = logging.getLogger("cards.stored")


def encode_cursor(epoch, seq):
    """The backend's transcript cursor: base64url of the JSON [epoch, seq] read after."""
    return base64.urlsafe_b64encode(json.dumps([epoch, seq], separators=(",", ":")).encode()).decode().rstrip("=")


class StoredRead:
    def __init__(self, dsn, http, buffer):
        self._dsn = dsn
        self._http = http
        self._buffer = buffer
        self._tracked = set()
        self._drained = set()
        # Per meeting, the last (epoch, seq) this read stored. Not the buffer's highest line:
        # the feed may have filed a later line while earlier ones are still only stored.
        self._cursor = {}

    def poll(self):
        with psycopg.connect(self._dsn) as conn:
            rows = conn.execute(
                """SELECT meeting_id::text, occurrence_state FROM bwat.v_cards_occurrences
                    WHERE occurrence_state = 'live' OR meeting_id = ANY(%s::uuid[])
                       OR (started_at >= now() - %s * interval '1 hour'
                           AND EXISTS (SELECT 1 FROM cards.capture_positions p
                                       WHERE p.meeting_id = v_cards_occurrences.meeting_id)
                           AND NOT EXISTS (SELECT 1 FROM cards.reconciliation_jobs j
                                           WHERE j.meeting_id = v_cards_occurrences.meeting_id
                                             AND (j.completed_at IS NOT NULL OR j.attempts >= %s)))
                    ORDER BY meeting_id""",
                [list(self._tracked), RECENT_HOURS, RECONCILIATION_ATTEMPTS],
            ).fetchall()
        # A tracked meeting the view no longer lists was deleted, and its transcript with it:
        # its lines leave memory too, and nothing more is read.
        for meeting_id in self._tracked - {meeting_id for meeting_id, _ in rows}:
            self._tracked.discard(meeting_id)
            self._cursor.pop(meeting_id, None)
            self._buffer.drop(meeting_id)
        for meeting_id, state in rows:
            if state != 'live' and meeting_id in self._drained:
                continue
            # One meeting's failed read (deleted between the query and the GET, a backend
            # error) is logged and retried next poll; the others are still read.
            try:
                self.read(meeting_id)
            except (httpx.HTTPError, ValueError, KeyError) as err:
                log.warning("stored read of meeting %s failed: %s", meeting_id, type(err).__name__)
                continue
            if state == "live":
                self._drained.discard(meeting_id)
                self._tracked.add(meeting_id)
                self._buffer.reopen(meeting_id)
            else:
                self._drained.add(meeting_id)
                self._tracked.discard(meeting_id)
                self._buffer.finish(meeting_id)

    def read(self, meeting_id):
        """Every stored line after the last one this read stored, page by page. A cursor is
        enough: the bot pushes one batch at a time in seq order (persistence
        first), so no line is ever stored below one already read."""
        last = self._cursor.get(meeting_id)
        params = {"cursor": encode_cursor(*last)} if last else {}
        while True:
            response = self._http.get(
                f"/v1/meetings/{meeting_id}/transcript",
                params=params,
            )
            response.raise_for_status()
            body = response.json()
            for segment in body["segments"]:
                self._buffer.add(meeting_id, segment)
                self._cursor[meeting_id] = (segment["epoch"], segment["seq"])
            if not body["next_cursor"]:
                return
            params = {"cursor": body["next_cursor"]}
