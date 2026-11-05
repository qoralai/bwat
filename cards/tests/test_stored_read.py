"""The stored read: a live meeting's transcript, read from the backend, fills the line buffer
(slice C3a, QOR-4653).

Which meetings are live comes from the real view (bwat.v_cards_occurrences) as the card
service's login; the transcript comes from a fake backend that answers the GET the way
backend/src/routes/meetings.ts does.
"""

import base64
import json
import secrets
import uuid

import httpx
import pytest

from capture.buffer import Buffer
from capture.stored import StoredRead
from tests.acceptance.test_commitment_becomes_card import line

CREDENTIAL = "bwc_test"


def cursor(epoch, seq):
    return base64.urlsafe_b64encode(json.dumps([epoch, seq]).encode()).decode().rstrip("=")


def decoded(value):
    return json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))


class FakeBackend:
    """GET /v1/meetings/{id}/transcript, paged two at a time, after the cursor."""

    def __init__(self, meeting_id, segments, state="live"):
        self.meeting_id = meeting_id
        self.segments = segments
        self.state = state
        self.reads = []

    def handle(self, request):
        assert request.headers["authorization"] == f"Bearer {CREDENTIAL}"
        if request.url.path != f"/v1/meetings/{self.meeting_id}/transcript":
            # Recovery may discover prior tests' ended meetings in the shared test DB.
            return httpx.Response(404)
        after = request.url.params.get("cursor")
        self.reads.append(after and tuple(decoded(after)))
        rest = [s for s in self.segments if not after or (s["epoch"], s["seq"]) > tuple(decoded(after))]
        page = rest[:2]
        return httpx.Response(
            200,
            json={
                "meeting_id": self.meeting_id,
                "occurrence_state": self.state,
                "complete": False,
                "segments": page,
                "next_cursor": cursor(page[-1]["epoch"], page[-1]["seq"]) if len(rest) > 2 else None,
            },
        )


@pytest.fixture
def live_meeting(db):
    """A meeting with an open claim: live in the view."""
    tag = uuid.uuid4().hex[:8]
    number = str(secrets.randbelow(9 * 10**8) + 10**8)
    with db.connect("owner") as owner:
        meeting_id = owner.execute(
            "INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (%s, %s) RETURNING id",
            [f"occ-{tag}", number],
        ).fetchone()[0]
        owner.execute(
            "INSERT INTO bwat.claims (meeting_number, occurrence_uuid, state) VALUES (%s, %s, 'pending')",
            [number, f"occ-{tag}"],
        )
    meeting = {"id": str(meeting_id), "occurrence": f"occ-{tag}"}
    yield meeting
    # Ended, so the next test's read sees only its own live meeting.
    end(db, meeting)


def end(db, meeting):
    with db.connect("owner") as owner:
        owner.execute(
            "UPDATE bwat.claims SET state = 'done', meeting_ended_at = now() WHERE occurrence_uuid = %s",
            [meeting["occurrence"]],
        )


def stored_read(db, backend):
    http = httpx.Client(transport=httpx.MockTransport(backend.handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    buffer = Buffer()
    return StoredRead(db.url("cards"), http, buffer), buffer


def seqs(buffer, meeting_id):
    return sorted(seq for (_, seq) in buffer.lines.get(meeting_id, {}))


def test_a_live_meetings_stored_transcript_fills_the_buffer_once(db, live_meeting):
    backend = FakeBackend(live_meeting["id"], [line(seq, "Marco", f"line {seq}") for seq in range(5)])
    reader, buffer = stored_read(db, backend)

    reader.poll()
    assert seqs(buffer, live_meeting["id"]) == [0, 1, 2, 3, 4]
    assert buffer.lines[live_meeting["id"]][(0, 3)]["text"] == "line 3"
    assert backend.reads == [None, (0, 1), (0, 3)]

    backend.reads.clear()
    reader.poll()
    assert backend.reads == [(0, 4)]
    assert seqs(buffer, live_meeting["id"]) == [0, 1, 2, 3, 4]
    assert live_meeting["id"] not in buffer.finished


def test_a_later_line_from_the_feed_does_not_hide_earlier_stored_lines(db, live_meeting):
    backend = FakeBackend(live_meeting["id"], [line(seq, "Marco", f"line {seq}") for seq in range(5)])
    reader, buffer = stored_read(db, backend)
    buffer.add(live_meeting["id"], line(3, "Marco", "line 3"))

    reader.poll()
    assert seqs(buffer, live_meeting["id"]) == [0, 1, 2, 3, 4]


def test_an_abandoned_meeting_that_goes_live_again_is_no_longer_finished(db, live_meeting):
    backend = FakeBackend(live_meeting["id"], [line(0, "Marco", "line 0")])
    reader, buffer = stored_read(db, backend)
    reader.poll()
    with db.connect("owner") as owner:
        owner.execute("UPDATE bwat.claims SET state = 'abandoned' WHERE occurrence_uuid = %s", [live_meeting["occurrence"]])
    reader.poll()
    assert buffer.finished == {live_meeting["id"]}

    with db.connect("owner") as owner:
        owner.execute(
            "INSERT INTO bwat.claims (meeting_number, occurrence_uuid, state) "
            "SELECT meeting_number, occurrence_uuid, 'pending' FROM bwat.meetings WHERE id = %s",
            [live_meeting["id"]],
        )
    backend.segments.append(line(1, "Marco", "back again"))
    reader.poll()
    assert buffer.finished == set()
    assert seqs(buffer, live_meeting["id"]) == [0, 1]


def test_a_meeting_that_ends_gets_one_last_read_and_is_finished_once(db, live_meeting):
    backend = FakeBackend(live_meeting["id"], [line(seq, "Marco", f"line {seq}") for seq in range(3)])
    reader, buffer = stored_read(db, backend)
    reader.poll()

    backend.segments.append(line(3, "Marco", "the last words"))
    backend.state = "ended"
    end(db, live_meeting)
    reader.poll()
    assert seqs(buffer, live_meeting["id"]) == [0, 1, 2, 3]
    assert buffer.finished == {live_meeting["id"]}

    backend.reads.clear()
    # Even with a saved extraction position and pending reconciliation, do not poll
    # an ended meeting again in this process after the successful final read.
    with db.connect('cards') as conn:
        conn.execute('INSERT INTO cards.capture_positions (meeting_id, epoch, last_seq) VALUES (%s, 0, 3)',
                     [live_meeting['id']])
    reader.poll()
    assert backend.reads == []


@pytest.fixture
def second_live_meeting(db):
    yield from live_meeting.__wrapped__(db)


def test_a_meeting_whose_read_fails_does_not_hold_up_the_others(db, live_meeting, second_live_meeting):
    # The poll reads in meeting id order: the failing one goes first.
    failing, other = sorted([live_meeting["id"], second_live_meeting["id"]])
    good = FakeBackend(other, [line(0, "Marco", "still read")])

    def handle(request):
        if failing in request.url.path:
            return httpx.Response(404, json={"error": "not_found"})
        return good.handle(request)

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="http://backend.test", headers={"Authorization": f"Bearer {CREDENTIAL}"})
    buffer = Buffer()
    StoredRead(db.url("cards"), http, buffer).poll()
    assert seqs(buffer, other) == [0]


def test_a_meeting_deleted_while_tracked_is_dropped_with_its_lines(db, live_meeting):
    backend = FakeBackend(live_meeting["id"], [line(0, "Marco", "line 0")])
    reader, buffer = stored_read(db, backend)
    reader.poll()
    with db.connect("owner") as owner:
        owner.execute("DELETE FROM bwat.claims WHERE occurrence_uuid = %s", [live_meeting["occurrence"]])
        owner.execute("DELETE FROM bwat.meetings WHERE id = %s", [live_meeting["id"]])

    backend.reads.clear()
    reader.poll()
    reader.poll()
    # Its transcript is gone from the backend, so it is gone from memory too.
    assert live_meeting["id"] not in buffer.lines and live_meeting["id"] not in buffer.finished
    assert backend.reads == []


def test_parked_ended_meeting_is_not_reloaded_but_live_meeting_is(db, live_meeting):
    from writer.loop import RECONCILIATION_ATTEMPTS
    backend = FakeBackend(live_meeting['id'], [line(0, 'Marco', 'old words')])
    with db.connect('cards') as conn:
        conn.execute('INSERT INTO cards.capture_positions (meeting_id, epoch, last_seq) VALUES (%s, 0, 0)',
                     [live_meeting['id']])
        conn.execute("INSERT INTO cards.reconciliation_jobs (meeting_id, position, attempts) VALUES (%s, '[[0,0]]', %s)",
                     [live_meeting['id'], RECONCILIATION_ATTEMPTS])
    end(db, live_meeting)
    reader, buffer = stored_read(db, backend)
    reader.poll()
    assert backend.reads == []
    with db.connect('owner') as conn:
        conn.execute("INSERT INTO bwat.claims (meeting_number, occurrence_uuid, state) "
                     "SELECT meeting_number, occurrence_uuid, 'pending' FROM bwat.meetings WHERE id = %s",
                     [live_meeting['id']])
    backend.segments.append(line(1, 'Marco', 'new words'))
    reader.poll()
    assert seqs(buffer, live_meeting['id']) == [0, 1]
    end(db, live_meeting)
    backend.segments.append(line(2, 'Marco', 'final words'))
    reader.poll()
    assert seqs(buffer, live_meeting['id']) == [0, 1, 2]
    assert live_meeting['id'] in buffer.finished
