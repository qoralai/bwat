import json
from types import SimpleNamespace

import pytest

from api.app import Cards
from tests.test_smart_merge import pair
from writer.reconcile import reconcile
from writer.revisions import add_context


@pytest.mark.parametrize('fence', ['', '```json', '```'])
def test_merge_summary_cannot_see_other_meetings_context(db, meeting, fence):
    old, new = pair(db, meeting)
    with db.connect('runtime') as conn:
        third = conn.execute("INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) "
                             "VALUES (%s, '123456789') RETURNING id", ['third-' + old]).fetchone()[0]
    with db.connect('cards') as conn:
        add_context(conn, new, third, 'THIRD_MEETING_SECRET', [])
    calls = []

    def reply(value):
        raw = json.dumps(value)
        return f'{fence}\n{raw}\n```' if fence else raw

    def complete(stable, data, usage):
        calls.append(json.loads(data))
        if len(calls) == 1:
            assert 'THIRD_MEETING_SECRET' in data
            # A discovery reply's summary is untrusted and must never be stored.
            return reply([{'older': old, 'newer': new, 'context': 'THIRD_MEETING_SECRET'}])
        assert 'THIRD_MEETING_SECRET' not in data
        assert set(calls[-1]) == {'title', 'detail_html', 'evidence'}
        return reply({'context': 'Include screenshots.'})

    assert reconcile(db.url('cards'), meeting['id'], SimpleNamespace(complete=complete)) == 1
    assert len(calls) == 2
    assert 'THIRD_MEETING_SECRET' in Cards(db.url('cards')).one(old)['detail_html']
    with db.connect('runtime') as conn:
        conn.execute('DELETE FROM bwat.meetings WHERE id = %s', [third])
    detail = Cards(db.url('cards')).one(old)['detail_html']
    assert 'THIRD_MEETING_SECRET' not in detail
    assert 'Include screenshots.' in detail
