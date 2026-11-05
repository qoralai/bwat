"""Evidence-backed additions. Human prose is never replaced by generated context."""

from psycopg.types.json import Jsonb

from writer.lifecycle import ON_BOARD, event


def add_context(conn, card_id, meeting_id, summary, evidence, link_id=None):
    if not isinstance(summary, str) or not 1 <= len(summary.strip()) <= 4000:
        raise ValueError('invalid context')
    return conn.execute(
        '''INSERT INTO cards.card_context (card_id, source_meeting_id, summary, evidence, link_id)
           VALUES (%s, %s, %s, %s, %s) RETURNING id''',
        [card_id, meeting_id, summary.strip(), Jsonb(evidence), link_id],
    ).fetchone()[0]


def revise(conn, meeting_id, proposal, frames, board):
    from writer.window import checked, locked

    target = board.get(proposal['card_id'])
    evidence = checked(proposal.get('evidence'), frames)
    if not target or target['retired'] or not evidence:
        raise ValueError('not a live card with checked evidence')
    # Not archived and on the board, or refused for this card before any version check.
    row = locked(conn, target, proposal['expected_version'], 'title', ' AND NOT archived AND status = ANY(%s)',
                 [list(ON_BOARD)])
    title = proposal.get('title', row[1])
    if title is None or (isinstance(title, str) and not title.strip()):
        title = row[1]
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 300:
        raise ValueError('invalid title')
    # Any human title edit remains authoritative even after later writer activity.
    human_title = conn.execute(
        "SELECT 1 FROM cards.card_events WHERE card_id = %s AND actor_kind = 'member' AND after ? 'title' LIMIT 1",
        [target['id']],
    ).fetchone()
    if human_title or str(target['meeting_id']) != str(meeting_id):
        # Cross-meeting information must disappear if its source meeting is deleted.
        # Keep it in the source-bound context instead of copying it into permanent fields.
        title = row[1]
    title = title.strip()
    context_id = add_context(conn, target['id'], meeting_id, proposal['context'], [
        {'epoch': e['epoch'], 'seq': e['seq'], 'speaker': e['speaker']['label'], 'quote': e['quote']}
        for e in evidence])
    version = row[0]
    if title != row[1]:
        version = conn.execute('UPDATE cards.cards SET title = %s WHERE id = %s RETURNING version',
                               [title, target['id']]).fetchone()[0]
    event(conn, target['id'], target['meeting_id'], 'card.revise', 'writer', before={'title': row[1]},
          after={'title': title}, cause={'context_id': str(context_id), 'meeting_id': str(meeting_id)})
    # This window's own write moved the version: a later op on the card at the old version
    # is a per-card refusal, not someone else's edit (QOR-4769).
    target['version'] = version
    return True
