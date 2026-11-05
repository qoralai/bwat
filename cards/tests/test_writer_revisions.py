import json

import httpx
import pytest

from api.app import Cards
from tests.acceptance.test_commitment_becomes_card import commitment, line, model_replying
from tests.test_writer_board import first_card
from writer.model import ModelClient
from writer.window import StaleVersion, read_window


def revision(meeting, display, version=1):
    frames = [line(30, meeting['marco_name'], 'Include the screenshots in the draft.', meeting['marco'])]
    return frames, {'op': 'revise', 'card_id': display, 'expected_version': version,
                    'title': 'Send the license draft with screenshots', 'context': 'Include screenshots.',
                    'evidence': [{'epoch': 0, 'seq': 30, 'quote': 'Include the screenshots in the draft.'}]}


def test_new_context_revises_a_card_without_creating_a_duplicate(db, meeting):
    cid, display = first_card(db, meeting)
    frames, proposal = revision(meeting, display)
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    assert result['updated'] == 1 and result['cards'] == 0
    card = Cards(db.url('cards')).one(str(cid))
    assert card['title'] == proposal['title']
    assert 'Include screenshots.' in card['detail_html']
    assert any(e['seq'] == 30 for e in card['evidence'])
    # Still a draft: the writer's own revision is no person's action.
    assert card['status'] == 'draft' and card['owner_name'] == 'Legal team'


@pytest.mark.parametrize('title', [None, '', '   '])
def test_optional_empty_title_keeps_valid_new_context(db, meeting, title):
    cid, display = first_card(db, meeting)
    frames, proposal = revision(meeting, display)
    proposal['title'] = title
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    card = Cards(db.url('cards')).one(str(cid))
    assert result['updated'] == 1
    assert card['title'] == 'Send the license draft to legal by Friday'
    assert 'Include screenshots.' in card['detail_html']


def test_human_title_and_notes_survive_automatic_revision(db, meeting):
    cid, display = first_card(db, meeting)
    api = Cards(db.url('cards'))
    api.update(str(cid), 1, str(meeting['marco']), 'card.edit',
               lambda c: {'title': 'My title', 'detail_html': c['detail_html'] + '<p>My note</p>'})
    frames, proposal = revision(meeting, display, 2)
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    card = api.one(str(cid))
    assert result['updated'] == 1
    assert card['title'] == 'My title'
    assert 'My note' in card['detail_html'] and 'Include screenshots.' in card['detail_html']


def test_revision_refuses_stale_version_and_fabricated_evidence(db, meeting):
    cid, display = first_card(db, meeting)
    frames, proposal = revision(meeting, display, 20)
    assert read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))['refused']
    proposal['expected_version'] = 1
    proposal['evidence'][0]['quote'] = 'invented'
    assert read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))['refused']
    assert Cards(db.url('cards')).one(str(cid))['revision'] == 1


def test_deleting_later_meeting_removes_its_context_without_leaking_title_or_event_text(db, meeting):
    cid, display = first_card(db, meeting)
    with db.connect('runtime') as conn:
        later = conn.execute("INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) "
                             "VALUES (%s, '123456789') RETURNING id", ['later-' + str(cid)]).fetchone()[0]
    frames, proposal = revision(meeting, display)
    read_window(db.url('cards'), later, frames, model_replying([proposal]))
    api = Cards(db.url('cards'))
    assert api.one(str(cid))['title'] == 'Send the license draft to legal by Friday'
    assert 'Include screenshots.' in api.one(str(cid))['detail_html']
    with db.connect('runtime') as conn:
        conn.execute('DELETE FROM bwat.meetings WHERE id = %s', [later])
    assert 'Include screenshots.' not in api.one(str(cid))['detail_html']
    with db.connect('cards') as conn:
        events = str(conn.execute('SELECT before, after FROM cards.card_events WHERE card_id = %s', [cid]).fetchall())
        assert proposal['title'] not in events


def changing_during_the_call(db, card_id, cards):
    """A model that replies with `cards` after a person edits the card mid-call."""
    def handle(request):
        with db.connect('cards') as conn:
            conn.execute("UPDATE cards.cards SET detail_html = detail_html || '<p>edit</p>' WHERE id = %s", [card_id])
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(cards)}, 'finish_reason': 'stop'}]})

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url='https://models.example.com/v1')
    return ModelClient(http=http, model='test-model', api_key='k-test')


@pytest.mark.parametrize('op', ['revise', 'update'])
def test_a_card_changed_since_the_board_was_read_aborts_the_window(db, meeting, op):
    # QOR-4769: the whole window is read again next run, against the board as it is then.
    cid, display = first_card(db, meeting)
    frames, proposal = revision(meeting, display)
    if op == 'update':
        proposal = {'op': 'update', 'card_id': display, 'expected_version': 1, 'owner': meeting['marco_name'],
                    'evidence': [{'epoch': 0, 'seq': 30, 'speaker': meeting['marco_name'], 'quote': "I'll take it"}]}
        frames = [line(30, meeting['marco_name'], "Include me, I'll take it.", meeting['marco'])]
    other = commitment(meeting, quote=frames[0]['text'], seq=30)
    with db.connect('cards') as conn:
        before = conn.execute('SELECT count(*) FROM cards.cards').fetchone()[0]
    with pytest.raises(StaleVersion):
        read_window(db.url('cards'), meeting['id'], frames, changing_during_the_call(db, cid, [other, proposal]))
    with db.connect('cards') as conn:
        assert conn.execute('SELECT count(*) FROM cards.cards').fetchone()[0] == before
        assert conn.execute('SELECT last_seq FROM cards.capture_positions WHERE meeting_id = %s',
                            [meeting['id']]).fetchone()[0] == 9


@pytest.mark.parametrize('version', ['1', None, 1.5, [1]])
def test_a_malformed_expected_version_is_refused_and_the_rest_of_the_window_lands(db, meeting, version):
    _cid, display = first_card(db, meeting)
    frames, proposal = revision(meeting, display, version)
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    assert result['refused'] and result['updated'] == 0
    with db.connect('cards') as conn:
        assert conn.execute('SELECT last_seq FROM cards.capture_positions WHERE meeting_id = %s',
                            [meeting['id']]).fetchone()[0] == 30


def test_two_ops_on_one_card_in_a_window_refuse_the_second_and_the_rest_lands(db, meeting):
    # QOR-4769: the window's own write moves the version; that is not someone else's edit.
    _cid, display = first_card(db, meeting)
    frames = [line(30, meeting['marco_name'], "I'll take it, and include the screenshots.", meeting['marco']),
              line(31, meeting['marco_name'], "I'll book the room by Friday", meeting['marco'])]
    update = {'op': 'update', 'card_id': display, 'expected_version': 1, 'owner': meeting['marco_name'],
              'evidence': [{'epoch': 0, 'seq': 30, 'speaker': meeting['marco_name'], 'quote': "I'll take it"}]}
    _, revise = revision(meeting, display)
    revise['evidence'] = [{'epoch': 0, 'seq': 30, 'quote': 'include the screenshots'}]
    other = {**commitment(meeting, quote="I'll book the room by Friday", seq=31), 'title': 'Book the room by Friday'}
    with db.connect('cards') as conn:
        before = conn.execute('SELECT count(*) FROM cards.cards').fetchone()[0]
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([update, revise, other]))
    assert result['updated'] == 1 and len(result['refused']) == 1 and result['cards'] == 1
    with db.connect('cards') as conn:
        assert conn.execute('SELECT count(*) FROM cards.cards').fetchone()[0] == before + 1
        assert conn.execute('SELECT last_seq FROM cards.capture_positions WHERE meeting_id = %s',
                            [meeting['id']]).fetchone()[0] == 31
