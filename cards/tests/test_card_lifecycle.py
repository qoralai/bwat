"""Drafts, implied acceptance and stale expiry (D187, D194).

The writer's cards start as drafts; a person's first action, or the clean-up after the
meeting, makes one live. The owner acting on a card accepts it. A live card nobody acts on
for the admin's days (10 in most tests) closes as no_response, and says how many days it has
left over its last 5; with Never (the default) none closes.
"""

import json
import threading
import time
import uuid
from datetime import UTC
from types import SimpleNamespace

import httpx
import psycopg
import pytest

from capture.buffer import Buffer
from tests import test_api_person as person
from tests import test_jev_hints as jev
from tests.acceptance.test_commitment_becomes_card import model_replying
from tests.test_api_backend import as_backend, merge_source
from tests.test_api_person import as_person, cards
from tests.test_smart_merge import pair
from tests.test_writer_board import claim, first_card
from writer.lifecycle import expire, go_live
from writer.limits import RECONCILIATION_ATTEMPTS
from writer.loop import WriterLoop, settings_of
from writer.reconcile import SUMMARY_PROMPT, apply_merge, candidates, reconcile
from writer.window import read_window

board = person.board
hinted = jev.hinted


def state(db, card_id):
    with db.connect("cards") as conn:
        return conn.execute(
            "SELECT status, live_at IS NOT NULL, accepted_at IS NOT NULL FROM cards.cards WHERE id = %s", [card_id]
        ).fetchone()


def card_sql(db, card_id, sets, params=()):
    with db.connect("cards") as conn:
        conn.execute(f"UPDATE cards.cards SET {sets} WHERE id = %s", [*params, card_id])


def revision(board):
    return cards(board)[0]["revision"]


def another_member(db):
    with db.connect("runtime") as backend:
        return str(backend.execute(
            "INSERT INTO bwat.members (email, display_name, activated_at) VALUES (%s, 'Sam', now()) RETURNING id",
            [f"sam-{uuid.uuid4().hex[:8]}@example.com"],
        ).fetchone()[0])


def act_as(board, member_id):
    """The person the fake backend signs the bearer in as from now on."""
    board["backend"].member_id = member_id
    board["client"].headers["Authorization"] = f"Bearer {person.TOKEN}"
    # The card service keeps who a bearer is for 60 s: move its clock past that.
    board["clock"].now += 61


def edit(board, note="On it"):
    return board["client"].patch(f"/v1/cards/{board['card']}", **as_person(json={"note": note, "revision": revision(board)}))


def set_owner(board, owner):
    return board["client"].put(f"/v1/cards/{board['card']}/owner",
                               **as_person(json={"owner_member_id": owner, "revision": revision(board)}))


# Drafts

def test_the_writer_makes_drafts(db, meeting):
    card_id, _ = first_card(db, meeting)
    assert state(db, card_id) == ("draft", False, False)


def test_a_persons_first_edit_makes_a_draft_live_and_records_it(db, board):
    card_sql(db, board["card"], "status = 'draft', live_at = NULL")
    assert cards(board)[0]["status"] == "draft"
    assert edit(board).status_code == 200
    assert state(db, board["card"]) == ("open", True, False)
    with db.connect("cards") as conn:
        change = conn.execute("SELECT before->>'status', after->>'status' FROM cards.card_events WHERE card_id = %s",
                              [board["card"]]).fetchone()
    assert change == ("draft", "open")


def test_closing_a_draft_closes_it_and_it_went_live(db, board):
    card_sql(db, board["card"], "status = 'draft', live_at = NULL")
    assert close(board, "done").status_code == 200
    assert state(db, board["card"]) == ("done", True, False)


def test_a_plugins_note_makes_a_draft_live(db, board):
    # QOR-4985: a plugin notes a person's act on the card in its product (filing it there).
    card_sql(db, board["card"], "status = 'draft', live_at = NULL")
    noted = board["client"].post(f"/v1/cards/{board['card']}/note", **as_backend(
        board["member"], json={"lead": "Sent to Probe", "text": "as PRB-1", "by_member_id": board["member"]}))
    assert noted.status_code == 200
    assert state(db, board["card"])[:2] == ("open", True)


def test_a_hand_off_makes_a_draft_live(db, board):
    card_sql(db, board["card"], "status = 'draft', live_at = NULL")
    routed = board["client"].post(f"/v1/cards/{board['card']}/routed", **as_backend(
        board["member"], json={"handoff_id": str(uuid.uuid4()), "by_member_id": board["member"]}))
    assert routed.status_code == 204
    assert state(db, board["card"])[:2] == ("open", True)


def test_the_meetings_drafts_go_live_after_its_clean_up_and_a_merged_one_stays(db, meeting, monkeypatch):
    old, new = pair(db, meeting)
    assert state(db, old)[0] == state(db, new)[0] == "draft"
    with db.connect("cards") as conn:
        conn.execute("""INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind)
                        VALUES (%s, %s, %s, 'merges')""", [meeting["id"], new, old])
        conn.execute("UPDATE cards.reconciliation_jobs SET completed_at = now()")
    buffer = Buffer()
    buffer.finished.add(str(meeting["id"]))
    monkeypatch.setattr("writer.reconcile.reconcile", lambda *args: 0)
    backend = httpx.Client(base_url="http://backend.test", transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={"base_url": "http://model.test", "model": "fake", "api_key": "k", "settings": {"cards_granularity": "balanced"}})))
    loop = WriterLoop(db.url("cards"), buffer, backend)
    loop._unread()
    loop._lifecycle()
    assert state(db, old)[0] == "draft"  # the meeting has ended, its clean-up has not run
    loop._reconcile_jobs()
    loop._lifecycle()
    assert state(db, old)[:2] == ("open", True)
    assert state(db, new)[:2] == ("draft", False)


def ended_with_drafts(db, meeting, key="k", attempts=None):
    """An ended meeting's two drafts, its clean-up job at `attempts` (None: no job), and a
    writer loop whose settings carry the writer's `key` (None: no key)."""
    old, new = pair(db, meeting)
    loop = WriterLoop(db.url("cards"), Buffer(), None)
    loop._read_settings = lambda: settings_of({"base_url": "http://model.test", "model": "fake", "api_key": key, "settings": {"cards_granularity": "balanced"}})
    if attempts is not None:
        loop._forget(str(meeting["id"]), 0)
        with db.connect("cards") as conn:
            conn.execute("UPDATE cards.reconciliation_jobs SET attempts = %s, completed_at = NULL WHERE meeting_id = %s",
                         [attempts, meeting["id"]])
    return old, new, loop


def test_drafts_go_live_when_the_clean_up_gives_up(db, meeting):
    old, new, loop = ended_with_drafts(db, meeting, attempts=RECONCILIATION_ATTEMPTS)
    loop._lifecycle()
    assert state(db, old)[0] == state(db, new)[0] == "open"


def test_drafts_wait_while_the_clean_up_still_has_attempts(db, meeting):
    old, _, loop = ended_with_drafts(db, meeting, attempts=RECONCILIATION_ATTEMPTS - 1)
    loop._lifecycle()
    assert state(db, old)[0] == "draft"


def test_drafts_go_live_when_the_clean_up_cannot_run_without_the_writers_key(db, meeting):
    old, new, loop = ended_with_drafts(db, meeting, key=None)
    loop._lifecycle()
    assert state(db, old)[0] == state(db, new)[0] == "open"


def test_a_live_meetings_drafts_stay_drafts_without_the_writers_key(db, meeting):
    old, _, loop = ended_with_drafts(db, meeting, key=None)
    jev.go_live(db, meeting["id"])
    loop._lifecycle()
    assert state(db, old)[0] == "draft"


# Implied acceptance

def test_setting_yourself_as_owner_accepts_the_card(db, board):
    assert set_owner(board, board["member"]).status_code == 200
    assert cards(board)[0]["accepted"] is True


def test_a_card_given_to_someone_waits_for_them_and_their_action_accepts_it(db, board):
    sam = another_member(db)
    given = set_owner(board, sam).json()
    assert (given["accepted"], given["owner_by"]) == (False, board["member"])
    act_as(board, sam)
    assert edit(board).json()["accepted"] is True
    # Given to someone else again, it waits for them.
    assert set_owner(board, board["member"]).json()["accepted"] is False


def test_the_owner_routing_the_card_accepts_it(db, board):
    card_sql(db, board["card"], "owner_member_id = %s", [board["member"]])
    routed = board["client"].post(f"/v1/cards/{board['card']}/routed", **as_backend(
        board["member"], json={"handoff_id": str(uuid.uuid4()), "by_member_id": board["member"]}))
    assert routed.status_code == 204
    assert cards(board)[0]["accepted"] is True


def test_someone_elses_action_does_not_accept_for_the_owner(db, board):
    card_sql(db, board["card"], "owner_member_id = %s", [another_member(db)])
    assert edit(board).json()["accepted"] is False


def test_the_room_giving_the_card_to_someone_else_clears_its_acceptance(db, meeting):
    card_id, display_id = first_card(db, meeting, owner=meeting["ada_name"])
    card_sql(db, card_id, "accepted_at = now()")
    lines, proposal = claim(meeting, display_id, version=2)
    read_window(db.url("cards"), meeting["id"], lines, model_replying([proposal]))
    with db.connect("cards") as conn:
        owner, accepted = conn.execute("SELECT owner_member_id, accepted_at FROM cards.cards WHERE id = %s",
                                       [card_id]).fetchone()
    assert (owner, accepted) == (meeting["marco"], None)


# Stale expiry

def aged(db, board, live_days, member_days=None, writer_days=None):
    card_sql(db, board["card"], "live_at = now() - %s * interval '1 day'", [live_days])
    with db.connect("cards") as conn:
        for kind, days in (("member", member_days), ("writer", writer_days)):
            if days is not None:
                conn.execute(
                    """INSERT INTO cards.card_events (card_id, meeting_id, at, action, actor_kind, actor_member_id)
                       VALUES (%s, %s, now() - %s * interval '1 day', 'card.edit', %s, %s)""",
                    [board["card"], board["meeting"], days, kind, board["member"] if kind == "member" else None])


def expired(db):
    with db.connect("cards") as conn:
        return expire(conn)


def test_a_live_card_nobody_acts_on_for_ten_days_closes_as_no_response(db, board):
    aged(db, board, 11)
    assert expired(db) == 1
    assert state(db, board["card"])[0] == "no_response"
    assert person.events(db, board["card"]) == [("card.expire", "system", None)]
    (card,) = cards(board)
    assert (card["status"], card["done"], card["archived"], card["expires_in_days"]) == ("no_response", False, False, None)
    assert expired(db) == 0


def test_a_persons_action_resets_the_clock(db, board):
    aged(db, board, 11, member_days=1)
    assert expired(db) == 0


def test_a_session_reading_a_hand_off_does_not_reset_the_clock(db, board):
    aged(db, board, 11, member_days=11)
    read = board["client"].post(f"/v1/cards/{board['card']}/handoff-read", **as_backend(
        board["member"], json={"handoff_id": str(uuid.uuid4()), "by_member_id": board["member"]}))
    assert read.status_code == 204
    assert expired(db) == 1


def test_the_writers_own_change_does_not_reset_the_clock(db, board):
    aged(db, board, 11, member_days=11, writer_days=1)
    assert expired(db) == 1


def test_a_draft_never_expires(db, board):
    card_sql(db, board["card"], "status = 'draft', live_at = NULL")
    with db.connect("cards") as conn:
        conn.execute("""INSERT INTO cards.card_events (card_id, meeting_id, at, action, actor_kind)
                        VALUES (%s, %s, now() - interval '30 days', 'card.create', 'writer')""",
                     [board["card"], board["meeting"]])
    assert expired(db) == 0


def test_from_day_five_a_live_card_says_how_many_days_it_has_left(db, board):
    aged(db, board, 1)
    assert cards(board)[0]["expires_in_days"] is None
    aged(db, board, 6)
    assert cards(board)[0]["expires_in_days"] == 4
    aged(db, board, 9, member_days=6)
    assert cards(board)[0]["expires_in_days"] == 4


# The admin chooses how long an untouched card stays open; Never is the default.
def test_with_never_no_card_closes_nor_warns_however_long_it_sits(db, board):
    board["close"]["days"] = None
    aged(db, board, 400)
    with db.connect("cards") as conn:
        assert expire(conn, None) == 0
    assert state(db, board["card"])[0] == "open"
    assert cards(board)[0]["expires_in_days"] is None
    aged(db, board, 0)  # the database is shared: a later test's expiry check must not close it


def test_a_card_closes_after_the_admins_days_and_warns_over_its_last_five(db, board):
    board["close"]["days"] = 20
    aged(db, board, 14)
    assert cards(board)[0]["expires_in_days"] is None
    aged(db, board, 16)
    assert cards(board)[0]["expires_in_days"] == 4
    with db.connect("cards") as conn:
        assert expire(conn, 20) == 0
    aged(db, board, 21)
    with db.connect("cards") as conn:
        assert expire(conn, 20) == 1


def test_setting_a_span_counts_old_cards_from_then_so_none_closes_unwarned(db, board):
    """Cards older than the new span (all of them, after Forever) start their clock when it was set."""
    from datetime import datetime, timedelta
    aged(db, board, 400)
    just_set = datetime.now(UTC)
    with db.connect("cards") as conn:
        assert expire(conn, 10, just_set) == 0
    assert state(db, board["card"])[0] == "open"
    with db.connect("cards") as conn:
        assert expire(conn, 10, just_set - timedelta(days=11)) == 1


def test_a_card_counts_its_days_left_from_when_the_span_was_set():
    from datetime import datetime, timedelta

    from writer.lifecycle import expires_in
    set_at = datetime.now(UTC) - timedelta(days=6.5)
    assert expires_in("open", False, 400, 10, set_at) == 4
    assert expires_in("open", False, 400, 10, datetime.now(UTC)) is None
    assert expires_in("open", False, 2, 10, set_at) is None


def test_the_writer_reads_when_the_span_was_set():
    body = {"base_url": "https://openrouter.ai/api/v1", "model": "m", "api_key": "k", "jev_api_key": None,
            "close_since": "2026-11-11T16:00:00.000Z",
            "settings": {"cards_granularity": "balanced", "cards_keep_open_forever": False, "cards_close_after_days": 10}}
    assert settings_of(body).close_since.isoformat() == "2026-11-11T16:00:00+00:00"


def test_a_span_shorter_than_the_warning_warns_from_the_start(db, board):
    board["close"]["days"] = 3
    aged(db, board, 1)
    assert cards(board)[0]["expires_in_days"] == 2


@pytest.mark.parametrize("served, days", [
    ({"cards_keep_open_forever": True, "cards_close_after_days": 10}, None),
    ({"cards_keep_open_forever": False, "cards_close_after_days": 30}, 30),
    ({}, None),
])
def test_the_writer_reads_the_close_after_days_from_its_settings(served, days):
    body = {"base_url": "https://openrouter.ai/api/v1", "model": "m", "api_key": "k", "jev_api_key": None,
            "settings": {"cards_granularity": "balanced", "jev_enabled": False, "jev_model": "j", "jev_threshold_pct": 50,
                         "jev_link_threshold_pct": 50, "jev_deadline_s": 5, **served}}
    assert settings_of(body).close_after_days == days


def keep(board, rev):
    return board["client"].post(f"/v1/cards/{board['card']}/keep", **as_person(json={"revision": rev}))


def close(board, outcome):
    return board["client"].post(f"/v1/cards/{board['card']}/archive",
                                **as_person(json={"revision": revision(board), "outcome": outcome}))


def test_keeping_a_card_holds_it_on_the_board_as_the_keeper(db, board):
    aged(db, board, 11)
    kept = keep(board, revision(board))
    assert kept.status_code == 200
    assert (kept.json()["status"], kept.json()["expires_in_days"]) == ("open", None)
    assert person.events(db, board["card"])[-1] == ("card.keep", "member", board["member"])
    assert expired(db) == 0


def age_the_keep(db, board, days):
    with db.connect("owner") as conn:  # the card login may not rewrite an event
        conn.execute("UPDATE cards.card_events SET at = now() - %s * interval '1 day' WHERE card_id = %s AND action = 'card.keep'",
                     [days, board["card"]])


def test_a_keep_names_the_revision_it_saw(db, board):
    aged(db, board, 6)
    stale = keep(board, revision(board) - 1)
    assert (stale.status_code, stale.json()["error"]) == (409, "stale_revision")
    assert person.events(db, board["card"]) == []


def test_a_kept_card_never_warns_nor_expires_however_long_it_sits(db, board):
    aged(db, board, 60)
    assert keep(board, revision(board)).status_code == 200
    age_the_keep(db, board, 50)
    assert cards(board)[0]["expires_in_days"] is None
    assert expired(db) == 0
    assert state(db, board["card"])[0] == "open"


def test_a_kept_card_closes_when_a_person_closes_it(db, board):
    assert keep(board, revision(board)).status_code == 200
    assert close(board, "done").status_code == 200
    assert state(db, board["card"])[0] == "done"


def test_a_merged_card_is_not_kept(db, board):
    merge_source(db, board)
    with db.connect("cards") as conn:
        rev = conn.execute("SELECT version FROM cards.cards WHERE id = %s", [board["card"]]).fetchone()[0]
    refused = keep(board, rev)
    assert (refused.status_code, refused.json()["error"]) == (409, "merged_card")


@pytest.mark.parametrize("sets", ["status = 'draft', live_at = NULL", "archived = true"])
def test_a_draft_or_archived_card_is_not_kept(db, board, sets):
    card_sql(db, board["card"], sets)
    refused = keep(board, revision(board))
    assert (refused.status_code, refused.json()["error"]) == (409, "not_open")
    assert person.events(db, board["card"]) == []


def test_a_closed_card_is_not_kept(db, board):
    aged(db, board, 11)
    assert expired(db) == 1
    refused = keep(board, revision(board))
    assert (refused.status_code, refused.json()["error"]) == (409, "not_open")
    assert [e[0] for e in person.events(db, board["card"])] == ["card.expire"]


def lifecycle_with(db, served):
    loop = WriterLoop(db.url("cards"), Buffer(), None)
    loop._read_settings = lambda: settings_of({"base_url": "http://model.test", "model": "fake", "api_key": "k",
                                               "settings": {"cards_granularity": "balanced", **served}})
    loop._lifecycle()


def test_the_writer_loop_runs_the_expiry_check_with_the_admins_days(db, board):
    aged(db, board, 11)
    lifecycle_with(db, {"cards_keep_open_forever": False, "cards_close_after_days": 10})
    assert state(db, board["card"])[0] == "no_response"


def test_the_writer_loop_closes_nothing_by_default(db, board):
    aged(db, board, 400)
    lifecycle_with(db, {})
    assert state(db, board["card"])[0] == "open"
    aged(db, board, 0)


# Merge now and Link now are a person's action

def actors(db, *card_ids, action):
    with db.connect("cards") as conn:
        return conn.execute("SELECT card_id::text, actor_kind, actor_member_id FROM cards.card_events "
                            "WHERE card_id = ANY(%s::uuid[]) AND action = %s ORDER BY card_id", [list(card_ids), action]).fetchall()


def test_merge_now_is_recorded_as_the_person_who_clicked_it(db, hinted):
    jev.checked(db, hinted.newer, (hinted.older, 0.9))
    assert jev.act(hinted, hinted.newer, hinted.older).status_code == 200
    marco = hinted.meeting["marco"]
    assert actors(db, hinted.older, hinted.newer, action="card.merge") == sorted(
        [(hinted.older, "member", marco), (hinted.newer, "member", marco)])


def test_link_now_is_recorded_as_the_person_who_clicked_it(db, hinted):
    jev.checked(db, hinted.question, None, (hinted.older, 0.9))
    assert jev.act(hinted, hinted.question, hinted.older, "related").status_code == 200
    marco = hinted.meeting["marco"]
    assert actors(db, hinted.older, hinted.question, action="card.relate") == sorted(
        [(hinted.older, "member", marco), (hinted.question, "member", marco)])


def test_the_clean_ups_own_merge_is_still_the_writers(db, meeting):
    old, new = pair(db, meeting)
    with db.connect("cards") as conn, conn.transaction():
        apply_merge(conn, {"older": old, "newer": new, "context": "Same work."}, candidates(conn, meeting["id"]))
    assert {kind for _, kind, _ in actors(db, old, new, action="card.merge")} == {"writer"}


def test_merge_now_by_the_owner_accepts_their_card(db, hinted):
    card_sql(db, hinted.older, "owner_member_id = %s", [hinted.meeting["marco"]])
    card_sql(db, hinted.newer, "owner_member_id = %s", [hinted.meeting["marco"]])
    jev.checked(db, hinted.older, (hinted.newer, 0.9))
    assert jev.act(hinted, hinted.older, hinted.newer).status_code == 200
    assert state(db, hinted.older)[2] is True


def test_merge_now_and_link_now_make_both_cards_of_the_pair_live(db, hinted):
    for card_id in (hinted.older, hinted.newer, hinted.question):
        card_sql(db, card_id, "status = 'draft', live_at = NULL")
    jev.checked(db, hinted.question, None, (hinted.older, 0.9))
    assert jev.act(hinted, hinted.question, hinted.older, "related").status_code == 200
    assert state(db, hinted.question)[:2] == state(db, hinted.older)[:2] == ("open", True)
    jev.checked(db, hinted.newer, (hinted.older, 0.9))
    assert jev.act(hinted, hinted.newer, hinted.older).status_code == 200
    assert state(db, hinted.newer)[:2] == ("open", True)


# Undoing a merge acts on both of its cards

def merged_into_owned_draft(db, board):
    """The board's card merged into a survivor the person owns, a draft not yet accepted."""
    survivor = merge_source(db, board)
    card_sql(db, survivor, "status = 'draft', live_at = NULL, owner_member_id = %s", [board["member"]])
    return survivor


def test_undoing_a_merge_from_the_duplicate_puts_the_survivor_live_and_accepts_it(db, board):
    survivor = merged_into_owned_draft(db, board)
    undone = board["client"].post(f"/v1/cards/{board['card']}/unmerge", **as_person(json={"revision": revision(board)}))
    assert undone.status_code == 200
    assert state(db, survivor) == ("open", True, True)


def test_a_hand_off_on_a_merged_card_undoes_the_merge_and_acts_on_the_survivor_too(db, board):
    survivor = merged_into_owned_draft(db, board)
    routed = board["client"].post(f"/v1/cards/{board['card']}/routed", **as_backend(
        board["member"], json={"handoff_id": str(uuid.uuid4()), "by_member_id": board["member"]}))
    assert routed.status_code == 204
    assert state(db, survivor) == ("open", True, True)


# The 30 s pass never races a person or the clean-up

def test_a_person_acting_while_the_expiry_check_waits_keeps_the_card_open(db, board):
    aged(db, board, 11)
    person_tx = psycopg.connect(db.url("cards"))
    person_tx.execute("UPDATE cards.cards SET title = 'Still on it' WHERE id = %s", [board["card"]])
    person_tx.execute("""INSERT INTO cards.card_events (card_id, meeting_id, action, actor_kind, actor_member_id)
                         VALUES (%s, %s, 'card.edit', 'member', %s)""", [board["card"], board["meeting"], board["member"]])
    check = threading.Thread(target=expired, args=(db,))
    check.start()
    time.sleep(0.5)  # the check reaches the locked card
    person_tx.commit()
    person_tx.close()
    check.join(10)
    assert state(db, board["card"])[0] == "open"
    assert expired(db) == 0


def test_drafts_wait_while_the_last_clean_up_attempt_runs(db, meeting):
    old, _, loop = ended_with_drafts(db, meeting, attempts=RECONCILIATION_ATTEMPTS)
    with psycopg.connect(db.url("cards"), autocommit=True) as clean_up:
        clean_up.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", [f"reconcile:{meeting['id']}"])
        loop._lifecycle()
        assert state(db, old)[0] == "draft"
    loop._lifecycle()
    assert state(db, old)[0] == "open"



def test_an_answered_question_never_expires_nor_warns(db, board):
    with db.connect("cards") as conn:
        asked, answer = (conn.execute(f"""INSERT INTO cards.cards (meeting_id, kind, display_number, title)
            VALUES (%s, '{kind}', nextval('cards.{kind}_numbers'), %s) RETURNING id::text""", [board["meeting"], title]).fetchone()[0]
            for kind, title in (("question", "Who owns it?"), ("decision", "Marco owns it")))
        conn.execute("INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) VALUES (%s, %s, %s, 'answers')",
                     [board["meeting"], answer, asked])
    card_sql(db, asked, "live_at = now() - interval '6 days'")
    assert next(c for c in cards(board) if c["id"] == asked)["expires_in_days"] is None
    card_sql(db, asked, "live_at = now() - interval '11 days'")
    with db.connect("cards") as conn:
        expire(conn)
    assert state(db, asked)[0] == "open"


def test_a_hint_names_a_draft_card_too(db, hinted):
    card_sql(db, hinted.older, "status = 'draft', live_at = NULL")
    jev.checked(db, hinted.newer, (hinted.older, 0.9))
    assert jev.board_card(hinted, hinted.newer)["hint"]["duplicate"]["card_id"] == hinted.older


# bwat never hides a card a person has acted on, and never leaves drafts waiting forever

def test_the_clean_up_never_merges_away_a_card_a_person_acted_on(db, meeting):
    old, new = pair(db, meeting)
    card_sql(db, new, "status = 'open', live_at = now()")
    with db.connect("cards") as conn, conn.transaction(), pytest.raises(ValueError):
        apply_merge(conn, {"older": old, "newer": new, "context": "Same work."}, candidates(conn, meeting["id"]))
    with db.connect("cards") as conn:
        assert conn.execute("SELECT count(*) FROM cards.card_links WHERE kind = 'merges' AND from_card_id = %s",
                            [new]).fetchone()[0] == 0


def ended_ago(db, meeting, minutes):
    with db.connect("owner") as conn:
        conn.execute("UPDATE bwat.meetings SET ended_at = now() - %s * interval '1 minute' WHERE id = %s",
                     [minutes, meeting["id"]])


def test_drafts_go_live_an_hour_after_the_meeting_while_the_clean_up_keeps_failing(db, meeting):
    old, _, loop = ended_with_drafts(db, meeting, attempts=0)
    ended_ago(db, meeting, 59)
    loop._lifecycle()
    assert state(db, old)[0] == "draft"
    ended_ago(db, meeting, 61)
    loop._lifecycle()
    assert state(db, old)[0] == "open"


def test_drafts_go_live_an_hour_after_the_clean_up_was_queued_with_no_recorded_end(db, meeting):
    old, _, loop = ended_with_drafts(db, meeting, attempts=0)
    with db.connect("owner") as conn:
        assert conn.execute("SELECT ended_at FROM bwat.meetings WHERE id = %s", [meeting["id"]]).fetchone()[0] is None
    for minutes, status in ((59, "draft"), (61, "open")):
        with db.connect("cards") as conn:
            conn.execute("UPDATE cards.reconciliation_jobs SET queued_at = now() - %s * interval '1 minute' "
                         "WHERE meeting_id = %s", [minutes, meeting["id"]])
        loop._lifecycle()
        assert state(db, old)[0] == status


def merging(older, newer):
    """The clean-up's model, proposing that `older` and `newer` are one card; `summaries`
    counts the merge summaries it was asked for."""
    model = SimpleNamespace(summaries=0)

    def complete(stable, data, usage):
        if stable == SUMMARY_PROMPT:
            model.summaries += 1
            return '{"context": "The same work."}'
        return json.dumps([{"older": older, "newer": newer}])
    model.complete = complete
    return model


@pytest.mark.parametrize("live", ["older", "newer"])
def test_the_clean_up_keeps_the_live_card_and_merges_the_draft_into_it(db, meeting, live):
    old, new = pair(db, meeting)
    kept, hidden = (old, new) if live == "older" else (new, old)
    card_sql(db, kept, "status = 'open', live_at = now()")
    assert reconcile(db.url("cards"), meeting["id"], merging(old, new)) == 1
    with db.connect("cards") as conn:
        assert conn.execute("SELECT from_card_id::text, to_card_id::text FROM cards.card_links WHERE kind = 'merges' "
                            "AND revoked_at IS NULL AND %s IN (from_card_id, to_card_id)", [old]).fetchall() == [(hidden, kept)]


def test_the_clean_up_merges_neither_of_two_live_cards(db, meeting):
    old, new = pair(db, meeting)
    for card_id in (old, new):
        card_sql(db, card_id, "status = 'open', live_at = now()")
    model = merging(old, new)
    assert reconcile(db.url("cards"), meeting["id"], model) == 0
    assert model.summaries == 0  # refused before any summary is paid for


def test_merge_now_keeps_the_live_card_when_the_older_one_is_a_draft(db, hinted):
    card_sql(db, hinted.older, "status = 'draft', live_at = NULL")
    jev.checked(db, hinted.newer, (hinted.older, 0.9))
    assert jev.act(hinted, hinted.newer, hinted.older).status_code == 200
    with db.connect("cards") as conn:
        assert conn.execute("SELECT from_card_id::text, to_card_id::text FROM cards.card_links "
                            "WHERE kind = 'merges' AND revoked_at IS NULL AND from_card_id = ANY(%s::uuid[])",
                            [[hinted.older, hinted.newer]]).fetchall() == [(hinted.older, hinted.newer)]


def test_going_live_never_takes_the_clean_up_lock_of_a_meeting_not_ready(db, meeting):
    first_card(db, meeting)  # a draft
    jev.go_live(db, meeting["id"])  # the meeting is live: its drafts are not ready
    key = f"reconcile:{meeting['id']}"
    with psycopg.connect(db.url("cards")) as pass_, psycopg.connect(db.url("cards"), autocommit=True) as other:
        go_live(pass_, True)  # its transaction is still open
        assert other.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", [key]).fetchone()[0] is True
        other.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", [key])


def test_the_expiry_check_never_locks_a_card_a_person_acted_on_lately(db, board):
    aged(db, board, 11, member_days=1)
    with psycopg.connect(db.url("cards")) as check, psycopg.connect(db.url("cards"), autocommit=True) as person_tx:
        check.execute("SELECT 1")  # an open transaction, so expire's locks outlive its call
        assert expire(check) == 0
        person_tx.execute("SELECT 1 FROM cards.cards WHERE id = %s FOR UPDATE NOWAIT", [board["card"]])


def test_going_live_never_takes_the_lock_of_a_meeting_whose_only_draft_is_merged_away(db, meeting):
    old, new = pair(db, meeting)
    card_sql(db, old, "status = 'open', live_at = now()")
    with db.connect("cards") as conn:
        conn.execute("""INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind)
                        VALUES (%s, %s, %s, 'merges')""", [meeting["id"], new, old])
    key = f"reconcile:{meeting['id']}"
    with psycopg.connect(db.url("cards")) as pass_, psycopg.connect(db.url("cards"), autocommit=True) as other:
        go_live(pass_, True)  # the meeting has ended and the clean-up cannot run; its transaction stays open
        assert other.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", [key]).fetchone()[0] is True
        other.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", [key])
    assert state(db, new)[0] == "draft"
