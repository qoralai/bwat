"""The card routes only the backend calls, under BWAT_CARDS_BACKEND_TOKEN (slice C4b,
QOR-4667, D162). Each bearer is refused on the other's routes.
"""

import re
import uuid
from datetime import UTC, datetime

import httpx
import pytest

from api.app import make_server
from tests import test_api_person as person

board = person.board


def as_backend(member_id, **kwargs):
    return {"headers": {"Authorization": f"Bearer {person.BACKEND_TOKEN}", "X-Bwat-Member-Id": member_id}, **kwargs}


def routed_events(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute(
            "SELECT actor_kind, actor_member_id::text, after->>'handoff_id', at FROM cards.card_events "
            "WHERE card_id = %s AND action = 'card.routed'",
            [card_id],
        ).fetchall()


def test_the_brief_holds_the_title_the_detail_and_the_quotes(board):
    response = board["client"].get(f"/v1/cards/{board['card']}/brief", **as_backend(board["member"]))
    assert response.status_code == 200
    brief = response.json()
    assert "Ship it" in brief["subject"]
    assert "Ship it on Friday." in brief["body"] and "<p>" not in brief["body"]
    assert '"ship it on friday"' in brief["body"] and '"and the docs"' in brief["body"]


def test_routed_records_the_hand_off_once_as_the_member_the_backend_names(db, board):
    handoff = str(uuid.uuid4())
    for _ in range(2):
        response = board["client"].post(
            f"/v1/cards/{board['card']}/routed",
            **as_backend(board["member"], json={"handoff_id": handoff, "by_member_id": board["member"], "at": "2026-10-03T12:00:00Z"}),
        )
        assert response.status_code == 204
        assert "content-length" not in response.headers and "content-type" not in response.headers
    (card,) = board["client"].get(f"/v1/occurrences/{board['meeting']}/cards", **person.as_person()).json()
    ((routed),) = card["routed"]
    assert (routed["handoff_id"], routed["by_member_id"]) == (handoff, board["member"])
    assert routed["at"].endswith("+00:00")
    ((kind, actor, recorded, at),) = routed_events(db, board["card"])
    assert (kind, actor, recorded) == ("member", board["member"], handoff)
    # Recorded when the card service received it, whatever the body says.
    assert abs((datetime.now(UTC) - at).total_seconds()) < 60
    # Every reader of the card sees it was queued, once, and by whom.
    assert len(re.findall(r"<p><b>Queued</b> by M \w+ at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ</p>", card["detail_html"])) == 1


def test_routed_on_an_unknown_card_is_404(board):
    response = board["client"].post(
        f"/v1/cards/{uuid.uuid4()}/routed",
        **as_backend(board["member"], json={"handoff_id": str(uuid.uuid4()), "by_member_id": board["member"], "at": "2026-10-03T12:00:00Z"}),
    )
    assert response.status_code == 404


def test_a_long_detail_never_pushes_the_quotes_out_of_the_brief(db, board):
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET detail_html = %s WHERE id = %s", ["<p>" + "word " * 3900 + "</p>", board["card"]])
    brief = board["client"].get(f"/v1/cards/{board['card']}/brief", **as_backend(board["member"])).json()
    assert len(brief["body"].encode("utf-16-le")) // 2 <= 9000
    assert '"ship it on friday"' in brief["body"] and '"and the docs"' in brief["body"]


def test_a_person_token_is_refused_on_the_backend_routes(board):
    headers = {"Authorization": f"Bearer {person.TOKEN}", "X-Bwat-Member-Id": board["member"]}
    assert board["client"].get(f"/v1/cards/{board['card']}/brief", headers=headers).status_code == 401
    routed = board["client"].post(f"/v1/cards/{board['card']}/routed", headers=headers, json={"handoff_id": str(uuid.uuid4())})
    assert routed.status_code == 401


def test_the_backend_token_is_refused_on_a_persons_route(board):
    response = board["client"].get(f"/v1/occurrences/{board['meeting']}/cards", **as_backend(board["member"]))
    assert response.status_code == 401
    assert board["backend"].me_calls == 0


def test_the_brief_needs_the_acting_member(board):
    response = board["client"].get(
        f"/v1/cards/{board['card']}/brief", headers={"Authorization": f"Bearer {person.BACKEND_TOKEN}"}
    )
    assert response.status_code == 400


def test_the_service_does_not_start_without_the_backend_token(db):
    with pytest.raises(ValueError):
        make_server(db.url("cards"), httpx.Client(base_url="http://backend.test"), "", port=0)


def test_the_listen_backlog_holds_a_boards_burst_of_connections():
    server = make_server("postgresql://nobody@127.0.0.1:1/none", httpx.Client(base_url="http://backend.test"),
                         "token", port=0, host="127.0.0.1")
    server.server_close()
    assert server.request_queue_size >= 128


def routed_as(board, header_member, body_member):
    return board["client"].post(
        f"/v1/cards/{board['card']}/routed",
        **as_backend(header_member, json={"handoff_id": str(uuid.uuid4()), "by_member_id": body_member, "at": "2026-10-03T12:00:00Z"}),
    )


def test_routed_names_one_member_in_the_header_and_the_body(db, board):
    assert routed_as(board, str(uuid.uuid4()), board["member"]).status_code == 400
    assert routed_events(db, board["card"]) == []


def test_routed_for_someone_who_is_not_a_member_is_400_not_500(db, board):
    stranger = str(uuid.uuid4())
    assert routed_as(board, stranger, stranger).status_code == 400
    assert routed_events(db, board["card"]) == []


def test_a_long_quote_never_pushes_the_card_reference_out_of_the_brief(db, board):
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.cards SET title = 'x' WHERE id = %s", [board["card"]])
        conn.execute(
            """INSERT INTO cards.evidence (card_id, meeting_id, epoch, seq, speaker_label, text, source)
               VALUES (%s, %s, 3, 0, 'Marco', %s, 'asr')""",
            [board["card"], board["meeting"], "word " * 3000],
        )
    brief = board["client"].get(f"/v1/cards/{board['card']}/brief", **as_backend(board["member"])).json()
    assert len(brief["body"].encode("utf-16-le")) // 2 <= 9000
    assert board["card"] in brief["body"]


def test_routed_compares_the_member_ids_not_their_spelling(db, board):
    assert routed_as(board, board["member"].upper(), board["member"]).status_code == 204


# QOR-4985: what a plugin reads of a card to file it elsewhere, and the line it adds once it has.
def content(board, member=None):
    return board["client"].get(f"/v1/cards/{board['card']}/content", **as_backend(member or board["member"]))


def note(board, body, member=None):
    member = member or board["member"]
    return board["client"].post(f"/v1/cards/{board['card']}/note", **as_backend(member, json={"by_member_id": member, **body}))


def test_a_cards_content_is_its_title_its_note_as_text_and_its_quotes(board):
    response = content(board)
    assert response.status_code == 200
    assert response.json() == {
        "title": "Ship it",
        "note": "Ship it on Friday.",
        "quotes": [{"speaker": "Marco", "quote": "ship it on friday"}, {"speaker": "Ada", "quote": "and the docs"}],
    }


def test_a_note_adds_one_line_naming_the_member_and_the_time_and_is_a_persons_act(db, board):
    response = note(board, {"lead": "Sent to Probe", "text": "as PRB-1 <b>"})
    assert response.status_code == 200
    assert response.json() == {"revision": 2}
    (card,) = person.cards(board)
    assert card["revision"] == 2
    assert len(re.findall(r"<p><b>Sent to Probe</b> as PRB-1 &lt;b&gt; by M \w+ at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ</p>", card["detail_html"])) == 1
    assert ("card.note", "member", board["member"]) in person.events(db, board["card"])
    # The note is the card's: its content reads it back as text.
    assert "Sent to Probe as PRB-1 <b> by" in content(board).json()["note"]


def test_a_note_names_one_member_and_takes_a_short_lead_and_text(board):
    stranger = str(uuid.uuid4())
    response = board["client"].post(
        f"/v1/cards/{board['card']}/note",
        **as_backend(board["member"], json={"by_member_id": stranger, "lead": "Sent", "text": "x"}),
    )
    assert response.status_code == 400
    assert note(board, {"lead": "", "text": "x"}).status_code == 400
    assert note(board, {"lead": "x" * 61, "text": "x"}).status_code == 400
    assert note(board, {"lead": "Sent", "text": "x" * 301}).status_code == 400
    assert note(board, {"lead": "Sent", "text": 3}).status_code == 400
    assert note(board, {"lead": "Sent" + chr(10) + "to", "text": "x"}).status_code == 400
    # Blank, or a line separator of any kind: not a one-line receipt.
    assert note(board, {"lead": "   ", "text": "x"}).status_code == 400
    assert note(board, {"lead": "Sent", "text": "a" + chr(0x2028) + "b"}).status_code == 400
    assert note(board, {"lead": "Sent", "text": "a" + chr(0x85) + "b"}).status_code == 400
    # A trailing line break, or a control character Postgres cannot even store (NUL).
    assert note(board, {"lead": "Sent" + chr(10), "text": "x"}).status_code == 400
    assert note(board, {"lead": "Sent", "text": "x" + chr(13) + chr(10)}).status_code == 400
    assert note(board, {"lead": "Sent" + chr(0), "text": "x"}).status_code == 400
    assert note(board, {"lead": "Sent", "text": "x" + chr(0)}).status_code == 400
    # A member the install does not have.
    ghost = str(uuid.uuid4())
    assert note(board, {"lead": "Sent", "text": "x"}, member=ghost).status_code == 400
    (card,) = person.cards(board)
    assert card["revision"] == 1


def test_a_note_with_a_request_id_is_added_once_however_often_it_is_retried(db, board):
    first = note(board, {"lead": "Sent to Probe", "text": "as PRB-1", "request_id": "probe:PRB-1"})
    again = note(board, {"lead": "Sent to Probe", "text": "as PRB-1", "request_id": "probe:PRB-1"})
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json() == {"revision": 2}
    (card,) = person.cards(board)
    assert len(re.findall(r"<b>Sent to Probe</b>", card["detail_html"])) == 1
    assert person.events(db, board["card"]).count(("card.note", "member", board["member"])) == 1
    assert note(board, {"lead": "Sent to Probe", "text": "as PRB-2", "request_id": "probe:PRB-2"}).json() == {"revision": 3}
    assert note(board, {"lead": "Sent", "text": "x", "request_id": "has space"}).status_code == 400


def test_a_note_restores_a_card_merged_after_its_content_was_read(db, board):
    assert content(board).status_code == 200
    merge_source(db, board)
    assert content(board).status_code == 409
    assert note(board, {"lead": "Sent to Probe", "text": "as PRB-1"}).status_code == 200
    source = next(c for c in person.cards(board) if c["id"] == board["card"])
    assert source["merged_into"] is None
    assert "<b>Sent to Probe</b> as PRB-1" in source["detail_html"]
    assert ("card.unmerge", "member", board["member"]) in person.events(db, board["card"])


def test_content_and_note_of_a_card_that_is_not_there_are_404(board):
    missing = str(uuid.uuid4())
    assert board["client"].get(f"/v1/cards/{missing}/content", **as_backend(board["member"])).status_code == 404
    assert board["client"].post(
        f"/v1/cards/{missing}/note", **as_backend(board["member"], json={"by_member_id": board["member"], "lead": "Sent", "text": "x"})
    ).status_code == 404


def merge_source(db, board):
    with db.connect('cards') as conn:
        target = conn.execute("""INSERT INTO cards.cards (meeting_id, kind, display_number, title)
            VALUES (%s, 'todo', nextval('cards.todo_numbers'), 'Survivor') RETURNING id""", [board['meeting']]).fetchone()[0]
        conn.execute("INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES (%s, %s, %s, 'merges')",
                     [board['meeting'], board['card'], target])
    return str(target)


@pytest.mark.parametrize('endpoint', ['brief', 'content'])
def test_merged_source_cannot_prepare_an_external_action(db, board, endpoint):
    merge_source(db, board)
    response = board['client'].get(f"/v1/cards/{board['card']}/{endpoint}", **as_backend(board['member']))
    assert response.status_code == 409
    assert response.json()['error'] == 'merged_card'


@pytest.mark.parametrize('endpoint', ['brief', 'content'])
def test_external_receipt_restores_a_source_merged_after_preparation(db, board, endpoint):
    response = board['client'].get(f"/v1/cards/{board['card']}/{endpoint}", **as_backend(board['member']))
    assert response.status_code == 200
    merge_source(db, board)
    if endpoint == 'brief':
        handoff = str(uuid.uuid4())
        response = board['client'].post(f"/v1/cards/{board['card']}/routed",
            **as_backend(board['member'], json={'handoff_id': handoff, 'by_member_id': board['member']}))
        assert response.status_code == 204
        assert routed_events(db, board['card'])[0][2] == handoff
    else:
        response = note(board, {'lead': 'Sent to Probe', 'text': 'as PRB-42'})
        assert response.status_code == 200
    cards = person.cards(board)
    source = next(c for c in cards if c['id'] == board['card'])
    assert source['merged_into'] is None
    assert ('card.unmerge', 'member', board['member']) in person.events(db, board['card'])
    assert board['client'].get(f"/v1/cards/{board['card']}/{endpoint}", **as_backend(board['member'])).status_code == 200


def test_receipt_relocks_when_merge_wins_before_source_lock(db, board):
    from api.app import Cards

    class MergeBeforeLock:
        def __init__(self, conn):
            self.conn = conn
            self.merged = False

        def transaction(self):
            return self.conn.transaction()

        def execute(self, sql, params=None):
            result = self.conn.execute(sql, params)
            if not self.merged and sql.startswith('SELECT to_card_id::text'):
                self.merged = True
                merge_source(db, board)
            return result

    with db.connect('cards') as conn, conn.transaction():
        measured = MergeBeforeLock(conn)
        Cards(db.url('cards'))._receipt_lock(measured, board['card'], board['member'])
        assert measured.merged
    assert next(c for c in person.cards(board) if c['id'] == board['card'])['merged_into'] is None


def test_delayed_duplicate_receipt_does_not_undo_a_later_merge(db, board):
    handoff = str(uuid.uuid4())

    def receipt():
        return board['client'].post(f"/v1/cards/{board['card']}/routed",
            **as_backend(board['member'], json={'handoff_id': handoff, 'by_member_id': board['member']}))

    assert receipt().status_code in (200, 204)
    target = merge_source(db, board)
    before = person.events(db, board['card'])
    assert receipt().status_code in (200, 204)
    source = next(c for c in person.cards(board) if c['id'] == board['card'])
    assert source['merged_into']['id'] == target
    assert person.events(db, board['card']) == before


def handoff_read_as(board, handoff):
    return board["client"].post(
        f"/v1/cards/{board['card']}/handoff-read",
        **as_backend(board["member"], json={"handoff_id": handoff, "by_member_id": board["member"], "at": "2026-10-21T12:00:00Z"}),
    )


def test_a_hand_off_marked_read_shows_read_on_the_card_once_after_queued(db, board):
    """The card said "Queued" forever; once the session marks the hand-off read it says so."""
    handoff = str(uuid.uuid4())
    queued = board["client"].post(
        f"/v1/cards/{board['card']}/routed",
        **as_backend(board["member"], json={"handoff_id": handoff, "by_member_id": board["member"], "at": "2026-10-21T11:00:00Z"}),
    )
    assert queued.status_code == 204
    (before,) = board["client"].get(f"/v1/occurrences/{board['meeting']}/cards", **person.as_person()).json()
    for _ in range(2):
        response = handoff_read_as(board, handoff)
        assert response.status_code == 204
    (card,) = board["client"].get(f"/v1/occurrences/{board['meeting']}/cards", **person.as_person()).json()
    stamp = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"
    assert re.search(rf"<p><b>Queued</b> by M \w+ at {stamp}</p><p><b>Read</b> by M \w+ at {stamp}</p>", card["detail_html"])
    assert len(re.findall(r"<b>Read</b>", card["detail_html"])) == 1
    # The hand-off itself says when, so the board's badge can say Read for every viewer.
    assert before["routed"][0]["read_at"] is None
    ((routed),) = card["routed"]
    assert routed["handoff_id"] == handoff and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00", routed["read_at"])
    # A new revision, so the board takes it and a stale edit is refused.
    assert card["revision"] > before["revision"]
    with db.connect("cards") as conn:
        events = conn.execute(
            "SELECT actor_kind, actor_member_id::text, after->>'handoff_id' FROM cards.card_events "
            "WHERE card_id = %s AND action = 'card.handoff_read'",
            [board["card"]],
        ).fetchall()
    assert events == [("system", board["member"], handoff)]


def test_handoff_read_names_one_member_in_the_header_and_the_body(db, board):
    response = board["client"].post(
        f"/v1/cards/{board['card']}/handoff-read",
        **as_backend(board["member"], json={"handoff_id": str(uuid.uuid4()), "by_member_id": str(uuid.uuid4())}),
    )
    assert response.status_code == 400
    (card,) = board["client"].get(f"/v1/occurrences/{board['meeting']}/cards", **person.as_person()).json()
    assert "<b>Read</b>" not in card["detail_html"]


def test_facts_name_the_cards_merged_into_each_card(db, board):
    # QOR-4985: a plugin's record of a card that was merged away belongs to the card it was merged into.
    target = merge_source(db, board)
    facts = board["client"].post("/v1/cards/facts", **as_backend(board["member"], json={"card_ids": [target, board["card"]]})).json()["cards"]
    by_id = {f["id"]: f for f in facts}
    assert by_id[target]["merged_from"] == [board["card"]]
    assert by_id[board["card"]]["merged_from"] == []


def test_facts_name_cards_by_id_or_by_series_with_no_content(db, board):
    with db.connect("cards") as conn:
        closed = conn.execute(
            """INSERT INTO cards.cards (meeting_id, kind, display_number, title, status, archived)
               VALUES (%s, 'risk', nextval('cards.risk_numbers'), 'Gone', 'done', true) RETURNING id""",
            [board["meeting"]],
        ).fetchone()[0]
        conn.execute(
            """INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, actor_member_id)
               VALUES (%s, %s, 'card.archive', 'member', %s)""",
            [closed, board["meeting"], board["member"]],
        )
    by_id = board["client"].post("/v1/cards/facts", **as_backend(board["member"], json={"card_ids": [board["card"]]}))
    assert by_id.status_code == 200
    ((fact,),) = [by_id.json()["cards"]]
    assert set(fact) == {"id", "meeting_id", "meeting_number", "kind", "open", "created_at", "closed_at", "merged_from"}
    assert fact["merged_from"] == []
    assert (fact["id"], fact["meeting_number"], fact["kind"], fact["open"], fact["closed_at"]) == (board["card"], "123456789", "task", True, None)
    by_series = board["client"].post("/v1/cards/facts", **as_backend(board["member"], json={"meeting_numbers": ["123456789"]})).json()["cards"]
    gone = next(f for f in by_series if f["id"] == str(closed))
    assert gone["open"] is False and gone["closed_at"] is not None
    assert board["client"].post("/v1/cards/facts", **person.as_person(json={"card_ids": [board["card"]]})).status_code == 401
