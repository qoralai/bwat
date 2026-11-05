import re

from api.app import CARDS
from tests.test_writer_board import first_card
from writer.reconcile import candidates
from writer.window import board_digest


def test_card_context_lookup_uses_card_index_with_large_history(db, meeting):
    card_id, _ = first_card(db, meeting)
    with db.connect('owner') as conn:
        conn.execute('''INSERT INTO cards.cards (meeting_id, kind, display_number, title)
            SELECT %s, 'todo', nextval('cards.todo_numbers'), 'History ' || n
            FROM generate_series(1, 2000) n''', [meeting['id']])
        conn.execute('''INSERT INTO cards.card_context (card_id, source_meeting_id, summary, evidence)
            SELECT c.id, c.meeting_id, 'Context ' || n, '[]'::jsonb FROM cards.cards c
            CROSS JOIN generate_series(1, 5) n WHERE c.meeting_id = %s''', [meeting['id']])
        conn.execute('ANALYZE cards.cards')
        conn.execute('ANALYZE cards.card_context')
        conn.execute('ANALYZE cards.card_links')
    plans = []
    class ExplainedConnection:
        def __init__(self, conn):
            self.conn = conn

        def cursor(self, **kwargs):
            return ExplainedConnection(self.conn.cursor(**kwargs))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.conn.close()

        def execute(self, sql, params=None):
            if 'FROM cards.card_context x' in sql:
                result = self.conn.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, params).fetchone()
                plans.append((result['QUERY PLAN'] if isinstance(result, dict) else result[0])[0])
            return self.conn.execute(sql, params)

    with db.connect('cards') as conn:
        measured = ExplainedConnection(conn)
        measured.execute(CARDS + ' WHERE c.id = %s', [card_id]).fetchone()
        board_digest(measured)
        candidates(measured, meeting['id'])
    def nodes(node):
        yield node
        for child in node.get('Plans', []):
            yield from nodes(child)
    assert len(plans) == 3
    for name, plan in zip(('api', 'digest', 'reconcile'), plans):
        context_nodes = [n for n in nodes(plan['Plan']) if n.get('Relation Name') == 'card_context']
        print(name, [(n['Node Type'], n.get('Actual Rows'), n.get('Actual Loops')) for n in context_nodes],
              'Execution ms:', plan['Execution Time'])
        assert context_nodes
        assert all(n['Node Type'] != 'Seq Scan' for n in context_nodes)


def test_context_touch_updates_use_card_primary_key(db, meeting):
    card_id, _ = first_card(db, meeting)
    with db.connect('owner') as conn:
        conn.execute("""INSERT INTO cards.cards (meeting_id, kind, display_number, title)
            SELECT %s, 'todo', nextval('cards.todo_numbers'), 'History ' || n
            FROM generate_series(1, 10000) n""", [meeting['id']])
        conn.execute('ANALYZE cards.cards')
        conn.execute('ANALYZE cards.card_links')
        definition = conn.execute("SELECT pg_get_functiondef('cards.touch_context_card()'::regprocedure)").fetchone()[0]
        update = re.search(r'UPDATE cards.cards.*?;', definition, re.DOTALL).group()
        update = re.sub("CASE WHEN TG_OP = 'DELETE' THEN OLD.card_id ELSE NEW.card_id END|context_card_id",
                        '%s::uuid', update)
        plan = conn.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + update,
                            [card_id] * update.count('%s')).fetchone()[0][0]
    def nodes(node):
        yield node
        for child in node.get('Plans', []):
            yield from nodes(child)
    scans = [n for n in nodes(plan['Plan']) if n.get('Relation Name') == 'cards' and n['Node Type'] != 'ModifyTable']
    print([(n['Node Type'], n.get('Actual Rows'), n.get('Rows Removed by Filter')) for n in scans],
          'Execution ms:', plan['Execution Time'])
    assert scans
    assert all(n['Node Type'] != 'Seq Scan' for n in scans)


def test_context_touch_versions_survivors_on_insert_delete_and_source_cascade(db, meeting):
    from tests.test_smart_merge import pair
    from writer.revisions import add_context

    old, new = pair(db, meeting)
    with db.connect('runtime') as conn:
        later = conn.execute("INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) "
                             "VALUES (%s, '123456789') RETURNING id", ['context-' + new]).fetchone()[0]
    with db.connect('cards') as conn:
        conn.execute("INSERT INTO cards.card_links (meeting_id, from_card_id, to_card_id, kind) "
                     "VALUES (%s, %s, %s, 'merges')", [meeting['id'], new, old])

    def versions():
        with db.connect('cards') as conn:
            return dict(conn.execute('SELECT id::text, version FROM cards.cards WHERE id = ANY(%s::uuid[])',
                                     [[old, new]]).fetchall())

    before = versions()
    with db.connect('cards') as conn:
        context_id = add_context(conn, new, later, 'New source context', [])
        privileges = conn.execute("""SELECT p.prosecdef, p.proconfig,
            has_function_privilege('bwat_cards', p.oid, 'EXECUTE'),
            has_function_privilege('bwat_runtime', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = 'cards.touch_context_card()'::regprocedure""").fetchone()
    assert versions() == {cid: v + 1 for cid, v in before.items()}
    assert privileges == (True, ['search_path=cards, pg_temp'], False, False)
    with db.connect('owner') as conn:
        conn.execute('DELETE FROM cards.card_context WHERE id = %s', [context_id])
    assert versions() == {cid: v + 2 for cid, v in before.items()}
    with db.connect('cards') as conn:
        add_context(conn, new, later, 'Deleted with source meeting', [])
    with db.connect('runtime') as conn:
        conn.execute('DELETE FROM bwat.meetings WHERE id = %s', [later])
    assert versions() == {cid: v + 4 for cid, v in before.items()}
