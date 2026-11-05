import json
from types import SimpleNamespace

import pytest

from api.app import Cards
from tests.test_smart_merge import pair
from writer.reconcile import SUMMARY_PROMPT, reconcile


def scripted(proposals, before=None):
    def complete(stable, data, usage):
        if stable == SUMMARY_PROMPT:
            index = 1 if json.loads(data)['title'] == 'Second task detail' else 0
            return json.dumps({'context': proposals[index]['context']})
        if before:
            before()
        return json.dumps(proposals)
    return SimpleNamespace(complete=complete)


def test_concurrent_edit_requests_retry_and_preserves_human_title(db, meeting):
    old, new = pair(db, meeting)
    api = Cards(db.url('cards'))
    proposal = {'older': old, 'newer': new, 'context': 'Include screenshots.'}

    def edit_during_model_call():
        api.update(old, api.one(old)['revision'], str(meeting['marco']), 'card.edit',
                   lambda c: {'title': 'My corrected title'})

    with pytest.raises(ValueError, match='stale reconciliation'):
        reconcile(db.url('cards'), meeting['id'], scripted([proposal], edit_during_model_call))
    assert api.one(new)['merged_into'] is None
    assert reconcile(db.url('cards'), meeting['id'], scripted([proposal])) == 1
    assert api.one(old)['title'] == 'My corrected title'


def test_valid_merge_commits_before_stale_retry_without_duplicate_context(db, meeting):
    old, new = pair(db, meeting)
    with db.connect('cards') as conn:
        # Drafts, as the writer makes them: the clean-up merges away only a draft.
        extra = [str(conn.execute('''INSERT INTO cards.cards (meeting_id, kind, display_number, title, status, live_at)
            VALUES (%s, 'todo', nextval('cards.todo_numbers'), %s, 'draft', NULL) RETURNING id''',
            [meeting['id'], title]).fetchone()[0]) for title in ('Second task', 'Second task detail')]
    api = Cards(db.url('cards'))
    proposals = [{'older': old, 'newer': new, 'context': 'First merge context.'},
                 {'older': extra[0], 'newer': extra[1], 'context': 'Second merge context.'}]

    def edit_during_model_call():
        api.update(extra[0], api.one(extra[0])['revision'], str(meeting['marco']), 'card.edit',
                   lambda c: {'title': 'Human second task'})

    with pytest.raises(ValueError, match='stale reconciliation'):
        reconcile(db.url('cards'), meeting['id'], scripted(proposals, edit_during_model_call))
    assert api.one(new)['merged_into']['id'] == old
    assert api.one(extra[1])['merged_into'] is None
    assert reconcile(db.url('cards'), meeting['id'], scripted(proposals)) == 1
    assert api.one(old)['detail_html'].count('First merge context.') == 1
    assert api.one(extra[0])['title'] == 'Human second task'
