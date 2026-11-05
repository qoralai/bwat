import pytest

from capture.feed import line_of
from tests.acceptance.test_commitment_becomes_card import line, model_replying
from writer.window import member_for, read_window


def test_live_frame_preserves_the_same_identity_as_stored_transcript():
    frame = {'transcript_epoch': 0, 'seq': 0, 'speaker_label': 'Zoom name',
             'speaker_zoom_id': '42', 'speaker_member_id': 'member',
             'text': "I'll take that", 'source': 'asr', 'start_ms': 0, 'end_ms': 1000}
    assert line_of(frame)['speaker'] == {'label': 'Zoom name', 'member_id': 'member', 'zoom_id': '42'}


def test_unknown_zoom_speaker_cannot_impersonate_a_member_by_name():
    evidence = [line(0, 'Marco', "I'll take that")]
    evidence[0]['speaker']['zoom_id'] = '42'
    assert member_for({'marco': ['member']}, 'Marco', evidence) is None


@pytest.mark.parametrize('state', ['linked', 'guest', 'conflict', 'inactive'])
def test_writer_rechecks_stored_identity_after_model_call(db, meeting, state):
    text = "I'll send the notes to Ada."
    frames = [line(0, meeting['marco_name'], text)]
    frames[0]['speaker']['zoom_id'] = '42'
    with db.connect('runtime') as conn:
        conn.execute('UPDATE bwat.members SET zoom_user_id = %s WHERE id = %s',
                     [str(meeting['marco']), meeting['marco']])
        conn.execute('''INSERT INTO bwat.transcript_segments
          (meeting_id, epoch, seq, speaker_label, speaker_zoom_id, text, start_ms, end_ms, source)
          VALUES (%s, 0, 0, %s, '42', %s, 0, 1000, 'asr')''', [meeting['id'], meeting['marco_name'], text])

    proposal = {'bucket': 'do', 'title': 'Send notes', 'owner': meeting['marco_name'],
                'evidence': [{'epoch': 0, 'seq': 0, 'quote': text}]}
    base = model_replying([proposal])

    class DelayedArrival:
        def complete(self, stable, volatile, usage):
            # The join event arrives while the AI is working, after capture took its copy.
            with db.connect('runtime') as conn:
                conn.execute('''INSERT INTO bwat.zoom_speakers (occurrence_uuid, speaker_zoom_id, zoom_user_id, conflicted)
                  SELECT occurrence_uuid, '42', %s, %s FROM bwat.meetings WHERE id = %s''',
                             [None if state == 'guest' else str(meeting['marco']), state == 'conflict', meeting['id']])
                if state == 'inactive':
                    conn.execute('UPDATE bwat.members SET activated_at = NULL WHERE id = %s', [meeting['marco']])
            return base.complete(stable, volatile, usage)

    result = read_window(db.url('cards'), meeting['id'], frames, DelayedArrival())
    assert result['cards'] == 1
    with db.connect('cards') as conn:
        owner = conn.execute('SELECT owner_member_id FROM cards.cards WHERE meeting_id = %s', [meeting['id']]).fetchone()[0]
    assert owner == (meeting['marco'] if state == 'linked' else None)
    assert frames[0]['speaker']['member_id'] is None  # capture buffer was not mutated


def spoke_as(db, meeting, label, members):
    """Each member spoke one line under `label`, from a Zoom stream linked to their account."""
    frames = []
    with db.connect('runtime') as conn:
        for seq, member in enumerate(members):
            conn.execute('UPDATE bwat.members SET zoom_user_id = %s WHERE id = %s', [str(member), member])
            conn.execute('''INSERT INTO bwat.transcript_segments
              (meeting_id, epoch, seq, speaker_label, speaker_zoom_id, text, start_ms, end_ms, source)
              VALUES (%s, 0, %s, %s, %s, 'Hello.', 0, 1000, 'asr')''', [meeting['id'], seq, label, str(seq + 42)])
            conn.execute('''INSERT INTO bwat.zoom_speakers (occurrence_uuid, speaker_zoom_id, zoom_user_id)
              SELECT occurrence_uuid, %s, %s FROM bwat.meetings WHERE id = %s''', [str(seq + 42), str(member), meeting['id']])
            frames.append(line(seq, label, 'Hello.'))
            frames[-1]['speaker']['zoom_id'] = str(seq + 42)
    return frames


@pytest.mark.parametrize('speakers', ['one', 'two'])
def test_owner_named_by_someone_else_resolves_to_the_linked_speaker_of_that_label(db, meeting, speakers):
    label = 'Priya' + meeting['marco'].hex[:8]
    frames = spoke_as(db, meeting, label, [meeting['marco']] + ([meeting['ada']] if speakers == 'two' else []))
    text = f'{label} will send the notes to Ada.'
    frames.append(line(len(frames), meeting['ada_name'], text, meeting['ada']))
    proposal = {'bucket': 'do', 'title': 'Send notes', 'owner': label,
                'evidence': [{'epoch': 0, 'seq': len(frames) - 1, 'quote': text}]}
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    with db.connect('cards') as conn:
        owner = conn.execute('SELECT owner_member_id, owner_name FROM cards.cards WHERE meeting_id = %s',
                             [meeting['id']]).fetchone()
    assert result['cards'] == 1
    assert owner == (meeting['marco'] if speakers == 'one' else None, label)


def test_a_member_named_for_an_unverified_speakers_commitment_is_not_guessed():
    # QOR-4896: Marco joined from his phone, signed out of Zoom, as "MARCO".
    evidence = [line(0, 'MARCO', 'This is Marco, and I am taking on the to do of counting to twenty.')]
    evidence[0]['speaker']['zoom_id'] = '42'
    assert member_for({'marco reyes': ['marco']}, 'Marco Reyes', evidence) is None


def test_an_owner_label_whose_member_could_be_the_unverified_speaker_is_not_assigned():
    frames = [line(0, 'Boss', 'Hello.', 'marco')]
    frames[0]['speaker']['zoom_id'] = '41'
    evidence = [line(1, 'MARCO', "I'll count to twenty.")]
    evidence[0]['speaker']['zoom_id'] = '42'
    assert member_for({'marco reyes': ['marco']}, 'Boss', [], frames) == 'marco'
    assert member_for({'marco reyes': ['marco']}, 'Boss', evidence, frames) is None
    frames[0]['speaker']['label'] = 'Marco R'
    assert member_for({'priya nair': ['marco']}, 'Marco R', evidence, frames) is None


def test_a_quoted_guest_does_not_stop_the_room_naming_someone_else():
    evidence = [line(0, 'Owen Hale', 'We need the export.'), line(1, 'Priya', 'Nora Dunn will do it.', 'priya'),
                line(2, 'Nora', 'Sure.', 'nora')]
    evidence[0]['speaker']['zoom_id'] = '42'
    assert member_for({'nora dunn': ['nora'], 'priya': ['priya']}, 'Nora Dunn', evidence) == 'nora'


def test_a_card_from_an_unverified_speaker_is_unassigned_and_says_who_it_came_from(db, meeting):
    text = 'This is Marco, and I am taking on the to do of counting to twenty.'
    frames = [line(0, 'MARCO', text)]
    frames[0]['speaker']['zoom_id'] = '42'
    proposal = {'bucket': 'do', 'title': 'Count to twenty', 'owner': meeting['marco_name'], 'detail': '<p>Today.</p>',
                'evidence': [{'epoch': 0, 'seq': 0, 'quote': text}]}
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    with db.connect('cards') as conn:
        row = conn.execute('SELECT owner_member_id, owner_name, detail_html FROM cards.cards WHERE meeting_id = %s',
                           [meeting['id']]).fetchone()
    assert result['cards'] == 1
    assert row == (None, meeting['marco_name'], '<p>Today.</p><p>From MARCO (not signed in to Zoom as a bwat member).</p>')


def test_the_note_escapes_each_unverified_label_and_names_it_once(db, meeting):
    frames = [line(0, '<b>x</b> & co', 'We need the export.'), line(1, '<b>x</b> & co', 'By Friday.')]
    frames[0]['speaker']['zoom_id'] = frames[1]['speaker']['zoom_id'] = '42'
    proposal = {'bucket': 'do', 'title': 'Export', 'owner': '<b>x</b>',
                'evidence': [{'epoch': 0, 'seq': 0, 'quote': 'export'},
                                                                 {'epoch': 0, 'seq': 1, 'quote': 'Friday'}]}
    read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    with db.connect('cards') as conn:
        detail = conn.execute('SELECT detail_html FROM cards.cards WHERE meeting_id = %s', [meeting['id']]).fetchone()[0]
    assert detail == '<p>From &lt;b&gt;x&lt;/b&gt; &amp; co (not signed in to Zoom as a bwat member).</p>'


@pytest.mark.parametrize('bucket', ['decided', 'do'])
def test_a_card_that_only_quotes_a_guest_carries_no_note(db, meeting, bucket):
    frames = [line(0, 'Owen Hale', 'We ship the export on Friday.'), line(1, 'Ada', 'Ada will ship it.', meeting['ada'])]
    frames[0]['speaker']['zoom_id'] = '42'
    proposal = {'bucket': bucket, 'title': 'Ship the export', 'detail': '<p>Friday.</p>',
                **({'owner': meeting['ada_name']} if bucket == 'do' else {}),
                'evidence': [{'epoch': 0, 'seq': 0, 'quote': 'export'}, {'epoch': 0, 'seq': 1, 'quote': 'ship it'}]}
    read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    with db.connect('cards') as conn:
        row = conn.execute('SELECT owner_member_id, detail_html FROM cards.cards WHERE meeting_id = %s',
                           [meeting['id']]).fetchone()
    assert row == (meeting['ada'] if bucket == 'do' else None, '<p>Friday.</p>')


@pytest.mark.parametrize(('owner', 'note'), [('marco_name', ''), ('Marco', '<p>From MARCO (not signed in to Zoom as a bwat member).</p>')])
def test_only_the_unverified_speaker_a_refused_owner_may_be_is_noted(db, meeting, owner, note):
    marco = meeting['marco_name']
    frames = [line(0, marco, 'I can take the export.', meeting['marco']), line(1, 'MARCO', 'I will do it.')]
    frames[1]['speaker']['zoom_id'] = '42'
    proposal = {'bucket': 'do', 'title': 'Export', 'owner': meeting.get(owner, owner),
                'evidence': [{'epoch': 0, 'seq': 0, 'quote': 'export'}, {'epoch': 0, 'seq': 1, 'quote': 'do it'}]}
    read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    with db.connect('cards') as conn:
        row = conn.execute('SELECT owner_member_id, detail_html FROM cards.cards WHERE meeting_id = %s',
                           [meeting['id']]).fetchone()
    assert row == (meeting['marco'] if owner == 'marco_name' else None, note)
