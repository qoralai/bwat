"""The open list and one card on its own (QOR-4830): GET /v1/cards?status=open and
GET /v1/cards/{id}, what a plugin's product and the board's Open to-dos read.

Same server and fake backend as test_api_person. The test database is shared by every test
in the session, so a test that counts reads its own fresh member's cards (owner=me); one
that lists everyone's looks only for its own cards in the list.
"""

import base64
import json
import uuid

import pytest

from api import app
from tests import test_api_person as person
from tests.test_api_person import TOKEN, as_person, junk

board = person.board


def card(db, board, *, kind="todo", meeting=None, owner="me", title="Ship it", status="open", archived=False,
         detail="<p>Said.</p>", count=1):
    """`count` cards of one INSERT (so one created_at), owned by the board's member M unless
    `owner` names another (None: nobody); their ids, in insert order."""
    owner = board["member"] if owner == "me" else owner
    numbers = {"todo": "todo_numbers", "question": "question_numbers", "decision": "decision_numbers"}[kind]
    with db.connect("cards") as conn:
        return [str(row[0]) for row in conn.execute(
            f"""INSERT INTO cards.cards (meeting_id, kind, display_number, title, detail_html, owner_member_id, status, archived)
                SELECT %s, %s, nextval('cards.{numbers}'), %s, %s, %s, %s, %s FROM generate_series(1, %s)
                RETURNING id""",
            [meeting or board["meeting"], kind, title, detail, owner, status, archived, count],
        ).fetchall()]


def link(db, board, from_card, to_card, kind, meeting=None):
    with db.connect("cards") as conn:
        conn.execute("INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES (%s, %s, %s, %s)",
                     [meeting or board["meeting"], from_card, to_card, kind])


def meeting(db, title, started_at):
    with db.connect("runtime") as backend:
        return str(backend.execute(
            "INSERT INTO bwat.meetings (occurrence_uuid, meeting_number, title, started_at) VALUES (%s, '987654321', %s, %s) RETURNING id",
            [f"occ-open-{uuid.uuid4().hex[:8]}", title, started_at],
        ).fetchone()[0])


def member(db):
    with db.connect("runtime") as backend:
        tag = uuid.uuid4().hex[:8]
        return str(backend.execute(
            "INSERT INTO bwat.members (email, display_name, activated_at) VALUES (%s, %s, now()) RETURNING id",
            [f"o-{tag}@example.com", f"O {tag}"],
        ).fetchone()[0])


def get(board, query="status=open&owner=me", token=TOKEN, path="/v1/cards"):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return board["client"].get(f"{path}?{query}" if query is not None else path, headers=headers)


def ids(response):
    assert response.status_code == 200, response.text
    return [c["id"] for c in response.json()["cards"]]


def test_each_open_card_comes_as_a_meetings_card_list_has_it_plus_its_meeting(db, board):
    retro = meeting(db, "Retro", "2026-10-01T16:30:00+00:00")
    (here,) = card(db, board, title="Write the notes")
    (there,) = card(db, board, meeting=retro, title="Book the room")
    body = get(board).json()
    assert [c["id"] for c in body["cards"]] == [there, here]
    assert (body["next"], body["total"]) == (None, 2)
    listed = {c["id"]: c for c in body["cards"]}
    assert listed[there]["meeting"] == {"id": retro, "title": "Retro", "starts_at": "2026-10-01T16:30:00+00:00"}
    assert listed[here]["meeting"]["id"] == board["meeting"]
    assert listed[here]["meeting"]["title"] is None
    # Exactly the object GET /v1/occurrences/{id}/cards answers, plus `meeting`.
    by_meeting = {c["id"]: c for c in person.cards(board)}
    assert {k: v for k, v in listed[here].items() if k != "meeting"} == by_meeting[here]


def test_every_member_sees_every_meetings_open_cards_as_a_meetings_cards_are_seen(db, board):
    # D148: any member reads any meeting, so a meeting's cards and the open list follow one
    # rule. Someone else's card in a meeting M was never in is in M's list, and only in Mine
    # for its owner.
    someone = member(db)
    elsewhere = meeting(db, "Their 1:1", "2026-10-02T09:00:00+00:00")
    (theirs,) = card(db, board, meeting=elsewhere, owner=someone, title="Their to-do")
    (nobodys,) = card(db, board, owner=None, title="Anyone's")
    everyone = get(board, "status=open&limit=200")
    assert {theirs, nobodys, board["card"]} <= set(ids(everyone))
    assert theirs in [c["id"] for c in person.cards({**board, "elsewhere": elsewhere}, "elsewhere")]
    (mine,) = card(db, board)
    assert ids(get(board)) == [mine]


def test_without_a_bearer_or_with_one_that_signs_nobody_in_nothing_is_listed(board):
    for token in (None, junk(1)):
        response = get(board, token=token)
        assert response.status_code == 401
        assert response.json() == {"error": "unauthorized"}
    assert board["client"].get(f"/v1/cards/{board['card']}").status_code == 401


def test_only_cards_still_open_on_the_board_are_listed(db, board):
    (draft,) = card(db, board, status="draft", title="A draft is on the board")
    closed = [
        *card(db, board, status="done", archived=True),
        *card(db, board, status="wont_do", archived=True),
        *card(db, board, status="no_response"),
        *card(db, board, archived=True),  # archived with no outcome: off the board all the same
    ]
    merged, superseded = card(db, board, count=2)
    (survivor,) = card(db, board, title="The card the merge kept")
    link(db, board, merged, survivor, "merges")
    (later,) = card(db, board, title="Replaces one")
    link(db, board, later, superseded, "supersedes")
    (question,) = card(db, board, kind="question", title="Who owns it?")
    (answer,) = card(db, board, kind="decision", title="Ada owns it")
    link(db, board, answer, question, "answers")
    (clarified,) = card(db, board, kind="question", detail='<p>Asked.</p><p data-clarify="x"><b>Answered</b> by M</p>')
    (unanswered,) = card(db, board, kind="question", title="Still open")
    listed = ids(get(board, "status=open&owner=me&limit=200"))
    assert set(listed) == {draft, survivor, later, answer, unanswered}
    assert not {*closed, merged, superseded, question, clarified} & set(listed)
    assert get(board).json()["total"] == 5


def test_a_question_whose_note_names_the_answer_mark_stays_open_until_it_is_answered(db, board):
    # Only clarify()'s own <p data-clarify="…"> paragraph answers a question: a person's note
    # (escaped) or the writer's detail holding the words data-clarify= does not.
    (worded,) = card(db, board, kind="question", detail="<p>Is data-clarify= set on the form?</p>")
    (noted,) = card(db, board, kind="question", title="Noted")
    for note in ('data-clarify="x" is the field', '<p data-clarify="x">fake answer</p>'):
        revision = board["client"].get(f"/v1/cards/{noted}", **as_person()).json()["revision"]
        edited = board["client"].patch(f"/v1/cards/{noted}", **as_person(json={"revision": revision, "note": note}))
        assert edited.status_code == 200, edited.text
    assert {worded, noted} <= set(ids(get(board, "status=open&owner=me&limit=200")))
    revision = board["client"].get(f"/v1/cards/{noted}", **as_person()).json()["revision"]
    answered = board["client"].post(f"/v1/cards/{noted}/clarify", **as_person(
        json={"revision": revision, "answer": "Ada", "request_id": str(uuid.uuid4())}))
    assert answered.status_code == 200, answered.text
    listed = set(ids(get(board, "status=open&owner=me&limit=200")))
    assert worded in listed and noted not in listed


def test_a_revoked_link_takes_nothing_off_the_list(db, board):
    (superseded, later) = card(db, board, count=2)
    link(db, board, later, superseded, "supersedes")
    with db.connect("cards") as conn:
        conn.execute("UPDATE cards.card_links SET revoked_at = now() WHERE from_card_id = %s", [later])
    assert superseded in ids(get(board))


def test_mine_is_the_cards_whose_owner_member_is_the_person_not_a_name(db, board):
    (named,) = card(db, board, owner=None, title="Owner said aloud")
    with db.connect("cards") as conn:
        # A spoken owner that happens to be M's display name is not M's card.
        conn.execute("UPDATE cards.cards SET owner_name = (SELECT display_name FROM bwat.v_cards_members WHERE member_id = %s) "
                     "WHERE id = %s", [board["member"], named])
    (someone_elses,) = card(db, board, owner=member(db))
    (own,) = card(db, board)
    mine = ids(get(board))
    assert mine == [own]
    assert named not in mine and someone_elses not in mine


def test_pages_go_newest_first_ties_by_id_and_next_reads_on_to_the_end(db, board):
    first = card(db, board, count=2)  # one INSERT: one created_at, so id decides
    second = card(db, board, count=3)
    expected = [*sorted(second, reverse=True), *sorted(first, reverse=True)]
    seen, cursor, pages = [], None, 0
    while True:
        response = get(board, "status=open&owner=me&limit=2" + (f"&cursor={cursor}" if cursor else ""))
        seen += ids(response)
        # Counted on the first page only: a later page never recounts.
        if cursor is None:
            assert response.json()["total"] == 5
        else:
            assert "total" not in response.json()
        pages += 1
        cursor = response.json()["next"]
        if cursor is None:
            break
    assert (seen, pages) == (expected, 3)


def test_a_card_added_while_paging_neither_repeats_nor_moves_the_rest(db, board):
    older = card(db, board, count=3)
    page = get(board, "status=open&owner=me&limit=2").json()
    card(db, board, title="Newer than the cursor")
    rest = ids(get(board, f"status=open&owner=me&limit=2&cursor={page['next']}"))
    assert [c["id"] for c in page["cards"]] + rest == sorted(older, reverse=True)


def test_a_page_is_100_cards_unless_asked_and_200_at_most(db, board):
    many = card(db, board, count=201)
    default = get(board).json()
    assert (len(default["cards"]), default["total"]) == (100, 201)
    assert default["next"] is not None
    widest = get(board, "status=open&owner=me&limit=200").json()
    assert len(widest["cards"]) == 200 and widest["next"] is not None
    last = get(board, f"status=open&owner=me&limit=200&cursor={widest['next']}").json()
    assert (ids_of(last), last["next"]) == ([min(many)], None)


def ids_of(body):
    return [c["id"] for c in body["cards"]]


def test_total_counts_up_to_1000(db, board):
    card(db, board, count=1001)
    body = get(board, "status=open&owner=me&limit=1").json()
    assert (len(body["cards"]), body["total"]) == (1, 1000)


def cursor(raw):
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


@pytest.mark.parametrize("query", [
    None, "", "status=closed", "status=OPEN", "owner=me", "status=open&status=open", "status=open&owner=you",
    "status=open&owner=", "status=open&owner=me&owner=me", "status=open&limit=0", "status=open&limit=201",
    "status=open&limit=01", "status=open&limit=-1", "status=open&limit=ten", "status=open&limit=", "status=open&limit=1.5",
    "status=open&cursor=", "status=open&cursor=***", f"status=open&cursor={cursor('[1, 2]')}",
    f"status=open&cursor={cursor(json.dumps(['2026-10-01T00:00:00', str(uuid.uuid4())]))}",
    f"status=open&cursor={cursor(json.dumps(['2026-10-01T00:00:00+00:00', 'not-a-card']))}",
    "status=open&kind=task", "status=open&meeting=x",
])
def test_anything_but_the_four_parameters_as_given_is_400(board, query):
    response = get(board, query)
    assert response.status_code == 400, query
    assert response.json() == {"error": "bad_request"}


def test_a_cursor_longer_than_any_real_one_is_400_before_it_is_decoded(board):
    deep = cursor("[" * 40_000)  # ~53k: fits http.server's 64 KiB request line; json.loads would recurse
    for raw in ("x" * 257, deep):
        response = get(board, f"status=open&cursor={raw}")
        assert response.status_code == 400, len(raw)
        assert response.json() == {"error": "bad_request"}


def test_a_cursor_that_nests_too_deep_is_400_not_a_server_error(monkeypatch):
    # Under the cap a cursor can't nest deep enough to recurse; should the cap ever grow, the
    # decoder's RecursionError is still a 400.
    def recurse(_):
        raise RecursionError("maximum recursion depth exceeded")

    monkeypatch.setattr(app.json, "loads", recurse)
    with pytest.raises(app.Refused) as refused:
        app.after_cursor(cursor("[[["))
    assert (refused.value.status, refused.value.error) == (400, "bad_request")


def test_one_card_comes_with_its_meeting(db, board):
    retro = meeting(db, "Retro", "2026-10-01T16:30:00+00:00")
    (there,) = card(db, board, meeting=retro)
    response = board["client"].get(f"/v1/cards/{there}", **as_person())
    assert response.status_code == 200
    assert response.json()["meeting"] == {"id": retro, "title": "Retro", "starts_at": "2026-10-01T16:30:00+00:00"}
    assert response.json()["id"] == there


def test_one_card_closed_or_archived_comes_too_with_what_closed_it(db, board):
    (done,) = card(db, board, status="done", archived=True)
    (merged, survivor) = card(db, board, count=2)
    link(db, board, merged, survivor, "merges")
    body = board["client"].get(f"/v1/cards/{done}", **as_person()).json()
    assert (body["status"], body["archived"], body["done"]) == ("done", True, True)
    assert board["client"].get(f"/v1/cards/{merged}", **as_person()).json()["merged_into"]["id"] == survivor


@pytest.mark.parametrize("card_id", [str(uuid.uuid4()), "not-a-card", "settings"])
def test_a_card_nobody_may_read_or_that_does_not_exist_is_404_never_403(board, card_id):
    response = board["client"].get(f"/v1/cards/{card_id}", **as_person())
    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


def counts(board, token=TOKEN):
    return get(board, None, token, "/v1/cards/counts")


def test_counts_each_meetings_cards_on_the_board_as_the_board_counts_them(db, board):
    """The week picker's numbers, without reading every meeting's cards. A meeting's
    count is its list less the archived cards (GET /v1/occurrences/{id}/cards), closed and
    merged ones too; a meeting with none is not listed."""
    retro = meeting(db, "Retro", "2026-10-01T16:30:00+00:00")
    empty = meeting(db, "Nothing said", "2026-10-02T16:30:00+00:00")
    gone = meeting(db, "All archived", "2026-10-03T16:30:00+00:00")
    card(db, board, meeting=retro, count=2)
    card(db, board, meeting=retro, status="done")
    card(db, board, meeting=retro, status="done", archived=True)
    (merged, survivor) = card(db, board, meeting=retro, count=2)
    link(db, board, merged, survivor, "merges", meeting=retro)
    card(db, board, meeting=gone, archived=True)
    response = counts(board)
    assert response.status_code == 200, response.text
    listed = {m["meeting_id"]: m["cards"] for m in response.json()["meetings"]}
    shown = board["client"].get(f"/v1/occurrences/{retro}/cards", **as_person()).json()
    assert listed[retro] == 5 == len([c for c in shown if not c["archived"]])
    assert empty not in listed and gone not in listed


def test_counts_need_a_person(board):
    assert counts(board, token=None).status_code == 401
    assert counts(board, token=junk(0)).status_code == 401


def test_counts_are_one_query_for_every_board_for_a_few_seconds(db, board):
    """Every open board asks for the counts on each poll: they share one count a window."""
    retro = meeting(db, "Retro", "2026-10-04T16:30:00+00:00")
    assert retro not in {m["meeting_id"] for m in counts(board).json()["meetings"]}
    card(db, board, meeting=retro)
    board["clock"].now += app.COUNTS_TTL_S - 1
    assert retro not in {m["meeting_id"] for m in counts(board).json()["meetings"]}
    board["clock"].now += 1
    assert {m["meeting_id"]: m["cards"] for m in counts(board).json()["meetings"]}[retro] == 1


def test_a_meetings_cards_version_moves_with_any_change_to_its_cards_archived_ones_too(db, board):
    """What a board keys a week's cards on: it reads them again only when this moves."""
    retro = meeting(db, "Retro", "2026-10-05T16:30:00+00:00")
    (kept, closed) = card(db, board, meeting=retro, count=2)
    card(db, board, meeting=retro, archived=True)
    first = version(board, retro)
    assert version(board, retro) == first
    touch(db, kept, title="Ship it Monday")
    edited = version(board, retro)
    assert edited != first
    touch(db, closed, archived=True)
    archived = version(board, retro)
    assert archived != edited
    touch(db, closed, title="Edited while archived")
    assert version(board, retro) != archived


def test_a_change_that_commits_after_a_newer_one_still_moves_the_cards_version(db, board):
    """A transaction that changed a card first but commits last is not hidden by the other."""
    retro = meeting(db, "Retro", "2026-10-06T16:30:00+00:00")
    (first, second) = card(db, board, meeting=retro, count=2)
    with db.connect("cards") as slow, slow.transaction():
        slow.execute("UPDATE cards.cards SET title = 'Slow' WHERE id = %s", [first])
        touch(db, second, title="Fast")
        before = version(board, retro)
    assert version(board, retro) != before


def version(board, meeting_id):
    board["clock"].now += app.COUNTS_TTL_S
    return {m["meeting_id"]: m["cards_version"] for m in counts(board).json()["meetings"]}[meeting_id]


def touch(db, card_id, **fields):
    sets = ", ".join(f"{name} = %s" for name in fields)
    with db.connect("cards") as conn:
        conn.execute(f"UPDATE cards.cards SET {sets} WHERE id = %s", [*fields.values(), card_id])


def test_a_count_that_fails_answers_the_last_one_for_another_few_seconds(db, monkeypatch):
    """A database that stops answering costs one attempt a window, not one per board in a queue."""
    clock = person.Clock()
    cards = app.Cards(db.url("cards"), clock)
    first = cards.counts()
    attempts = []

    def down(*args, **kwargs):
        attempts.append(1)
        raise app.psycopg.OperationalError("connection timeout expired")

    monkeypatch.setattr(app.psycopg, "connect", down)
    clock.now += app.COUNTS_TTL_S
    assert cards.counts() == first
    assert cards.counts() == first
    assert len(attempts) == 1
    clock.now += app.COUNTS_TTL_S
    assert cards.counts() == first
    assert len(attempts) == 2


def test_a_first_count_that_fails_is_tried_once_a_window_and_refused_at_once_meanwhile(db, monkeypatch):
    clock = person.Clock()
    cards = app.Cards(db.url("cards"), clock)
    attempts = []
    connect = app.psycopg.connect

    def down(*args, **kwargs):
        attempts.append(1)
        raise app.psycopg.OperationalError("connection timeout expired")

    monkeypatch.setattr(app.psycopg, "connect", down)
    for _ in range(3):
        with pytest.raises(app.Refused) as refused:
            cards.counts()
        assert (refused.value.status, refused.value.error) == (503, "counts_unavailable")
    assert len(attempts) == 1
    monkeypatch.setattr(app.psycopg, "connect", connect)
    clock.now += app.COUNTS_TTL_S
    assert "meetings" in cards.counts()
