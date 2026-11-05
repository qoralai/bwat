"""Spoken owners resolve conservatively to active members, never to the recipient."""

import pytest

from tests.acceptance.test_commitment_becomes_card import line, model_replying
from tests.test_writer_board import card, claim, first_card
from writer.window import build_parts, member_for, read_window


@pytest.mark.parametrize(('name', 'members', 'expected'), [
    (' Marco ', {'marco reyes': ['marco'], 'priya nair': ['priya']}, None),
    ('MARCO REYES', {'marco reyes': ['marco']}, 'marco'),
    ('Marco', {'marco reyes': ['one'], 'marco smith': ['two']}, None),
    ('Marco', {'marco': ['one'], 'marco reyes': ['two']}, 'one'),
    ('Marco Reyes', {'marco reyes': ['one', 'two']}, None),
    ('Reyes', {'marco reyes': ['marco']}, None),
    ('Marcos', {'marco reyes': ['marco']}, None),
    ('Marco R', {'marco reyes': ['marco']}, None),
])
def test_exact_name_only_without_checked_identity(name, members, expected):
    assert member_for(members, name) == expected


def test_checked_speaker_identity_beats_display_name_matching():
    members = {'marco reyes': ['marco'], 'zoom marco': ['other']}
    evidence = [line(0, 'Zoom Marco', "I'll send the notes to Priya.", 'marco')]
    assert member_for(members, 'Zoom Marco', evidence) == 'marco'
    assert member_for(members, 'Priya', evidence) is None


def test_conflicting_or_inactive_speaker_identity_does_not_fall_back_to_a_name():
    members = {'marco': ['marco'], 'other': ['other']}
    evidence = [line(0, 'Marco', "I'll do it.", 'marco'), line(1, 'Marco', 'Me too.', 'other')]
    assert member_for(members, 'Marco', evidence) is None
    assert member_for(members, 'Marco', [line(0, 'Marco', "I'll do it.", 'inactive')]) is None


def test_a_linked_speakers_label_conflicting_with_another_members_name_stays_unresolved():
    frames = [line(0, 'Priya', 'Hello.', 'marco')]
    frames[0]['speaker']['zoom_id'] = '42'
    assert member_for({'marco reyes': ['marco']}, 'Priya', [], frames) == 'marco'
    assert member_for({'marco reyes': ['marco'], 'priya': ['other']}, 'Priya', [], frames) is None


def test_an_unlinked_stream_under_the_label_does_not_block_the_display_name_outside_the_quote():
    frames = [line(0, 'Ana Diaz', 'Hello.'), line(1, 'Marco', 'Ana Diaz will send the notes.', 'marco')]
    frames[0]['speaker']['zoom_id'] = '42'
    assert member_for({'ana diaz': ['ana'], 'marco': ['marco']}, 'Ana Diaz', frames[1:], frames) == 'ana'


def test_a_linked_and_an_unlinked_stream_under_the_same_label_leave_it_unresolved():
    frames = [line(0, 'Marco', 'Hello.', 'marco'), line(1, 'Marco', 'Hi.'), line(2, 'Ada', 'Marco will send the notes.', 'ada')]
    frames[0]['speaker']['zoom_id'], frames[1]['speaker']['zoom_id'] = '42', '43'
    assert member_for({'marco reyes': ['marco'], 'ada': ['ada']}, 'Marco', frames[2:], frames) is None


@pytest.mark.parametrize('member_state', ['named', 'unnamed', 'inactive'])
def test_new_commitment_uses_only_an_active_checked_speaker_id(db, meeting, member_state):
    with db.connect('runtime') as conn:
        if member_state == 'unnamed':
            conn.execute('UPDATE bwat.members SET display_name = NULL WHERE id = %s', [meeting['marco']])
        elif member_state == 'inactive':
            conn.execute('UPDATE bwat.members SET activated_at = NULL WHERE id = %s', [meeting['marco']])
    text = "I'll send the notes to Ada by Friday."
    frames = [line(0, 'Zoom Marco', text, meeting['marco'])]
    proposal = {'bucket': 'do', 'title': 'Send notes to Ada', 'owner': 'Zoom Marco',
                'evidence': [{'epoch': 0, 'seq': 0, 'speaker': 'invented', 'quote': text}]}
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    with db.connect('cards') as conn:
        row = conn.execute('SELECT owner_member_id, owner_name FROM cards.cards WHERE meeting_id = %s',
                           [meeting['id']]).fetchone()
    assert result['cards'] == 1
    assert row == (meeting['marco'] if member_state != 'inactive' else None, 'Zoom Marco')


def test_short_spoken_name_without_identity_is_kept_without_guessing_a_member(db, meeting):
    # Distinct across fixtures: this test database holds other meetings' members too.
    short = 'Marco' + meeting['marco'].hex[:8]
    with db.connect('runtime') as conn:
        conn.execute('UPDATE bwat.members SET display_name = %s WHERE id = %s', [short + ' Reyes', meeting['marco']])
    text = "I'll send the notes to Ada by Friday."
    proposal = {'bucket': 'do', 'title': 'Send notes', 'owner': short,
                'evidence': [{'epoch': 0, 'seq': 0, 'speaker': short, 'quote': text}]}
    result = read_window(db.url('cards'), meeting['id'], [line(0, short, text)], model_replying([proposal]))
    with db.connect('cards') as conn:
        owner = conn.execute('SELECT owner_member_id, owner_name FROM cards.cards WHERE meeting_id = %s', [meeting['id']]).fetchone()
    assert result['cards'] == 1 and owner == (None, short)


def test_existing_spoken_owner_can_gain_a_member_id_on_a_new_claim(db, meeting):
    card_id, display_id = first_card(db, meeting, owner='Zoom Marco')
    assert card(db, card_id)[:2] == (None, 'Zoom Marco')
    before_detail = card(db, card_id)[2]
    lines, proposal = claim(meeting, display_id, owner='Zoom Marco')
    lines[0]['speaker']['label'] = 'Zoom Marco'
    result = read_window(db.url('cards'), meeting['id'], lines, model_replying([proposal]))
    assert result['updated'] == 1
    assert card(db, card_id)[:2] == (meeting['marco'], 'Zoom Marco')
    assert card(db, card_id)[2] == before_detail


def test_repeated_claim_without_identity_keeps_the_existing_member_link(db, meeting):
    card_id, display_id = first_card(db, meeting, owner='Zoom Marco')
    lines, proposal = claim(meeting, display_id, owner='Zoom Marco')
    lines[0]['speaker']['label'] = 'Zoom Marco'
    read_window(db.url('cards'), meeting['id'], lines, model_replying([proposal]))
    before = card(db, card_id)
    lines[0]['speaker']['member_id'] = None
    proposal['expected_version'] = before[3]
    result = read_window(db.url('cards'), meeting['id'], lines, model_replying([proposal]))
    assert result['updated'] == 0
    assert card(db, card_id) == before


def test_the_writer_is_told_a_group_ask_is_owned_by_the_asker():
    stable, _ = build_parts([line(0, 'Marco', 'Next topic.')], {})
    for phrase in ('asks the whole room or a group', 'Acceptance wins over the ask', '"we should all..."',
                   'never a guessed list', 'only on a new card, never by a claim'):
        assert phrase in stable


def test_a_new_group_ask_card_stores_the_asker_the_model_names(db, meeting):
    # Storage only: whether the model names the asker is the prompt rule, checked by the
    # prompt-text test above and on the next real meeting (no live model test here).
    text = 'You guys try the new build every day this week.'
    proposal = {'bucket': 'do', 'title': 'Ask the team to try the new build daily', 'owner': meeting['marco_name'],
                'evidence': [{'epoch': 0, 'seq': 0, 'speaker': meeting['marco_name'], 'quote': text}]}
    frames = [line(0, meeting['marco_name'], text, meeting['marco'])]
    result = read_window(db.url('cards'), meeting['id'], frames, model_replying([proposal]))
    with db.connect('cards') as conn:
        row = conn.execute('SELECT owner_member_id, owner_name FROM cards.cards WHERE meeting_id = %s',
                           [meeting['id']]).fetchone()
    assert result['cards'] == 1
    assert row == (meeting['marco'], meeting['marco_name'])


def test_owner_in_evidence_refuses_a_group_ask_as_a_claim(db, meeting):
    # The real guard behind "never by a claim": a quote that neither names the asker nor
    # is first person. Loosening owner_in_evidence must fail here.
    card_id, display_id = first_card(db, meeting)
    before = card(db, card_id)
    text = 'You guys take the license draft.'
    lines, proposal = claim(meeting, display_id, said=text, quote=text)
    result = read_window(db.url('cards'), meeting['id'], lines, model_replying([proposal]))
    assert result['updated'] == 0 and result['refused'] == [f'{str(display_id)[:40]}: ValueError']
    assert card(db, card_id) == before
