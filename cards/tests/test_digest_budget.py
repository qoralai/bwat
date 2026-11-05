from tests.test_writer_board import first_card
from writer.revisions import add_context
from writer.window import board_digest, digest_text


def test_recent_context_survives_the_prompt_budget(db, meeting):
    card_id, display_id = first_card(db, meeting)
    with db.connect('cards') as conn:
        for i in range(5):
            add_context(conn, card_id, meeting['id'], f'Update {i}: ' + 'x' * 990, [])
        prompt = digest_text({display_id: board_digest(conn)[display_id]})
    assert prompt.index('Update 4:') < prompt.index('Update 3:')
    assert 'Update 0:' not in prompt


def test_full_board_keeps_old_open_cards_with_bounded_context():
    board = {f'A{i}': {'display_id': f'A{i}', 'kind': 'todo', 'title': 'Task ' + 'x' * 500,
                       'version': 1, 'retired': False, 'detail': 'context ' * 500}
             for i in range(800)}
    prompt = digest_text(board)
    assert len(prompt) <= 64000
    for i in range(800):
        assert f'A{i} [do]' in prompt
    assert prompt.index('A0 [do]') < prompt.index('A799 [do]')


def test_small_board_preserves_full_title_and_context():
    prompt = digest_text({'Q1': {'display_id': 'Q1', 'kind': 'question', 'title': 'Who owns this?',
                                 'version': 2, 'retired': False, 'detail': 'New detail'}})
    assert prompt == 'Q1 [ask] Who owns this? (version 2)\n  Context: New detail'


def test_detail_lookup_only_reads_retained_cards(db, meeting):
    with db.connect('owner') as conn:
        conn.execute("""INSERT INTO cards.cards (meeting_id, kind, display_number, title, detail_html)
            SELECT %s, 'todo', nextval('cards.todo_numbers'), 'Task ' || n, '<p>Useful detail</p>'
            FROM generate_series(1, 805) n""", [meeting['id']])
    detail_reads = []

    class MeasuredConnection:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, params=None):
            cursor = self.conn.execute(sql, params)
            if 'detail_html' in sql:
                detail_reads.append((cursor.rowcount, params))
            return cursor

    with db.connect('cards') as conn:
        board = board_digest(MeasuredConnection(conn))
    assert len(board) == 800
    assert len(detail_reads) == 1
    count, params = detail_reads[0]
    assert count == len(board)
    assert set(params[0]) == {card['id'] for card in board.values()}
    assert all(card['detail'].strip() == 'Useful detail' for card in board.values())
