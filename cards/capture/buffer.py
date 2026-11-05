"""Transcript lines per meeting, as the writer reads them.

The stored read and the bot feed both file lines here, so a line is kept once by
(epoch, seq) whichever path brings it first. A line is the backend's transcript segment
as GET /v1/meetings/{id}/transcript returns it.
"""

import threading


class Buffer:
    def __init__(self):
        self.lines = {}  # meeting_id -> {(epoch, seq): line}
        self.finished = set()
        self._lock = threading.Lock()

    def add(self, meeting_id, line):
        with self._lock:
            self.lines.setdefault(meeting_id, {}).setdefault((line["epoch"], line["seq"]), line)

    def finish(self, meeting_id):
        with self._lock:
            self.finished.add(meeting_id)

    def snapshot(self):
        """A copy of every meeting's lines and of the finished set, taken together."""
        with self._lock:
            return {m: dict(lines) for m, lines in self.lines.items()}, set(self.finished)

    def forget(self, meeting_id, seen):
        """Drops a finished meeting, unless it reopened or gained lines since its `seen`
        lines were read. True if it was dropped."""
        with self._lock:
            if meeting_id not in self.finished or len(self.lines.get(meeting_id, {})) != seen:
                return False
            self.lines.pop(meeting_id, None)
            self.finished.discard(meeting_id)
            return True

    def drop(self, meeting_id):
        """A deleted meeting: its lines go, unread or not."""
        with self._lock:
            self.lines.pop(meeting_id, None)
            self.finished.discard(meeting_id)

    def reopen(self, meeting_id):
        """An abandoned meeting can go live again (backend test/occurrence-state.test.ts)."""
        with self._lock:
            self.finished.discard(meeting_id)
