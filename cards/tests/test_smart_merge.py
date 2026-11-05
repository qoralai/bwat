import json
from types import SimpleNamespace

import pytest

from api.app import Cards
from tests.acceptance.test_commitment_becomes_card import commitment, model_replying, window
from tests.test_writer_board import first_card
from writer.window import read_window


def pair(db, meeting):
    old, _ = first_card(db, meeting)
    read_window(db.url('cards'), meeting['id'], window(meeting),
                model_replying([commitment(meeting, owner='Legal team') | {'title': 'Draft with screenshots'}]))
    with db.connect('cards') as conn:
        new = conn.execute('SELECT id FROM cards.cards WHERE meeting_id = %s AND id <> %s',
                           [meeting['id'], old]).fetchone()[0]
    return str(old), str(new)


def test_merge_keeps_old_title_adds_context_and_undo_preserves_later_human_note(db, meeting):
    from writer.reconcile import apply_merge, candidates, undo_merge
    old, new = pair(db, meeting)
    api = Cards(db.url('cards'))
    with db.connect('cards') as conn, conn.transaction():
        board = candidates(conn, meeting['id'])
        apply_merge(conn, {'older': old, 'newer': new, 'context': 'The draft includes screenshots.'}, board)
    survivor = api.one(old)
    assert survivor['title'] == 'Send the license draft to legal by Friday'
    assert 'The draft includes screenshots.' in survivor['detail_html']
    assert api.one(new)['merged_into']['id'] == old
    api.update(old, survivor['revision'], str(meeting['marco']), 'card.edit',
               lambda c: {'detail_html': c['detail_html'] + '<p>Human note after merge</p>'})
    with db.connect('cards') as conn, conn.transaction():
        undo_merge(conn, new, old, api.one(old)['revision'], str(meeting['marco']))
    assert api.one(new)['merged_into'] is None
    assert 'Human note after merge' in api.one(old)['detail_html']
    assert 'The draft includes screenshots.' not in api.one(old)['detail_html']
    with db.connect('cards') as conn, conn.transaction(), pytest.raises(ValueError):
        apply_merge(conn, {'older': old, 'newer': new, 'context': 'Again'}, candidates(conn, meeting['id']))


def test_merge_refuses_wrong_age_order_stale_cards_and_different_types(db, meeting):
    from writer.reconcile import apply_merge, candidates
    old, new = pair(db, meeting)
    with db.connect('cards') as conn:
        board = candidates(conn, meeting['id'])
    proposals = [{'older': new, 'newer': old, 'context': 'Reversed'}]
    for proposal in proposals:
        with db.connect('cards') as conn, conn.transaction(), pytest.raises(ValueError):
            apply_merge(conn, proposal, board)
    api = Cards(db.url('cards'))
    api.update(old, 1, str(meeting['marco']), 'card.edit', lambda c: {'title': 'Human edit'})
    with db.connect('cards') as conn, conn.transaction(), pytest.raises(ValueError):
        apply_merge(conn, {'older': old, 'newer': new, 'context': 'Stale'}, board)


def test_creation_cutoff_different_kind_and_owner_are_enforced(db, meeting):
    from writer.reconcile import apply_merge, candidates
    old, new = pair(db, meeting)
    with db.connect('owner') as conn:
        # The production role cannot forge creation time; the owner sets historical fixtures.
        conn.execute('ALTER TABLE cards.cards DISABLE TRIGGER cards_bump')
        try:
            conn.execute("UPDATE cards.cards SET created_at = now() - interval '121 hours' WHERE id = %s", [old])
        finally:
            conn.execute('ALTER TABLE cards.cards ENABLE TRIGGER cards_bump')
    with db.connect('cards') as conn:
        assert old not in candidates(conn, meeting['id'])
    # Updating recently must not make an old card eligible again.
    Cards(db.url('cards')).update(old, 1, str(meeting['marco']), 'card.edit', lambda c: {'title': 'Edited today'})
    with db.connect('cards') as conn:
        assert old not in candidates(conn, meeting['id'])
    with db.connect('cards') as conn:
        board = candidates(conn, meeting['id'])
        # A synthetic older candidate exercises the kind guard independently of age.
        board[old] = dict(board[new], id=old, created_at=board[new]['created_at'].replace(year=2020))
        board[new]['kind'] = 'risk'
        with pytest.raises(ValueError, match='different kinds'):
            apply_merge(conn, {'older': old, 'newer': new, 'context': 'Unsafe'}, board)
        board[new]['kind'] = board[old]['kind']
        board[new]['owner_name'] = 'Somebody else'
        with pytest.raises(ValueError, match='ownership'):
            apply_merge(conn, {'older': old, 'newer': new, 'context': 'Unsafe'}, board)


def test_cross_meeting_merge_retains_source_evidence_and_deletion_removes_added_context(db, meeting):
    from writer.reconcile import apply_merge, candidates
    old, _ = first_card(db, meeting)
    with db.connect('runtime') as conn:
        later = conn.execute("INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (%s, '123456789') RETURNING id",
                             ['later-' + str(old)]).fetchone()[0]
    read_window(db.url('cards'), later, window(meeting), model_replying([commitment(meeting, owner='Legal team')]))
    with db.connect('cards') as conn, conn.transaction():
        new = str(conn.execute('SELECT id FROM cards.cards WHERE meeting_id = %s', [later]).fetchone()[0])
        apply_merge(conn, {'older': str(old), 'newer': new, 'context': 'Later meeting context'}, candidates(conn, later))
    api = Cards(db.url('cards'))
    assert any(e.get('meeting_id') == str(later) for e in api.one(str(old))['evidence'])
    with db.connect('runtime') as conn:
        conn.execute('DELETE FROM bwat.meetings WHERE id = %s', [later])
    assert 'Later meeting context' not in api.one(str(old))['detail_html']
    assert not any(e.get('meeting_id') == str(later) for e in api.one(str(old))['evidence'])


def test_merging_a_revised_card_keeps_its_context_and_citations(db, meeting):
    from writer.reconcile import apply_merge, candidates
    from writer.revisions import add_context
    old, new = pair(db, meeting)
    with db.connect('cards') as conn, conn.transaction():
        add_context(conn, new, meeting['id'], 'Add annotated screenshots.',
                    [{'epoch': 0, 'seq': 60, 'speaker': 'Nora', 'quote': 'Include annotated screenshots.'}])
        board = candidates(conn, meeting['id'])
        assert any(c['summary'] == 'Add annotated screenshots.' for c in board[new]['contexts'])
        apply_merge(conn, {'older': old, 'newer': new, 'context': 'The room reaffirmed the draft.'}, board)
    survivor = Cards(db.url('cards')).one(old)
    assert 'Add annotated screenshots.' in survivor['detail_html']
    assert any(e['seq'] == 60 and e['meeting_id'] == str(meeting['id']) for e in survivor['evidence'])
    with db.connect('cards') as conn:
        assert any(c['summary'] == 'Add annotated screenshots.' for c in candidates(conn, meeting['id'])[old]['contexts'])


def test_cross_kind_relationship_does_not_retire_either_card(db, meeting):
    from writer.reconcile import apply_related, candidates
    old, _ = first_card(db, meeting)
    with db.connect('cards') as conn, conn.transaction():
        new = str(conn.execute("INSERT INTO cards.cards (meeting_id, kind, display_number, title) "
                               "VALUES (%s, 'risk', nextval('cards.risk_numbers'), 'Draft may be late') RETURNING id",
                               [meeting['id']]).fetchone()[0])
        apply_related(conn, {'older': str(old), 'newer': new}, candidates(conn, meeting['id']))
    api = Cards(db.url('cards'))
    assert api.one(str(old))['related'][0]['id'] == new
    assert api.one(new)['merged_into'] is None and api.one(new)['status'] == 'open'


def test_related_batch_refreshes_both_card_versions(db, meeting):
    from writer.reconcile import reconcile
    old, new = pair(db, meeting)
    with db.connect('cards') as conn:
        risk = str(conn.execute("INSERT INTO cards.cards (meeting_id, kind, display_number, title) "
                               "VALUES (%s, 'risk', nextval('cards.risk_numbers'), 'Draft may be late') RETURNING id",
                               [meeting['id']]).fetchone()[0])
    model = SimpleNamespace(complete=lambda *args: json.dumps([
        {'older': old, 'newer': risk, 'relationship': 'related'},
        {'older': new, 'newer': risk, 'relationship': 'related'},
    ]))
    reconcile(db.url('cards'), meeting['id'], model)
    assert {c['id'] for c in Cards(db.url('cards')).one(risk)['related']} == {old, new}


@pytest.mark.parametrize('fields', [{'title': 'Hidden edit'}, {'archived': True}, {'archived': False},
                                    {'owner_name': 'Someone else'}])
def test_merged_card_changes_require_unmerge(db, meeting, fields):
    from api.app import Refused
    from writer.reconcile import apply_merge, candidates
    old, new = pair(db, meeting)
    with db.connect('cards') as conn, conn.transaction():
        apply_merge(conn, {'older': old, 'newer': new, 'context': 'Same draft'}, candidates(conn, meeting['id']))
    api = Cards(db.url('cards'))
    before = api.one(new)
    with pytest.raises(Refused) as caught:
        api.update(new, before['revision'], str(meeting['marco']), 'card.edit', lambda c: fields)
    assert caught.value.status == 409
    assert caught.value.extra['message'] == 'Unmerge this card before changing it'
    assert api.one(new) == before


def test_reconciliation_contexts_show_newest_first(db, meeting):
    from writer.reconcile import candidates
    from writer.revisions import add_context
    old, _ = first_card(db, meeting)
    with db.connect('cards') as conn:
        for i in range(10):
            add_context(conn, old, meeting['id'], f'Context {i}', [])
        contexts = candidates(conn, meeting['id'])[str(old)]['contexts']
    assert [c['summary'] for c in contexts[:8]] == [f'Context {i}' for i in range(9, 1, -1)]
