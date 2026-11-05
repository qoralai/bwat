import asyncio
import itertools

import pytest

from bwat_bot.audio import Segment, _transcribe_in_order
from bwat_bot.backend import BackendError, Settings
from bwat_bot.dictionary import Dictionary


def payload(alias='boat', canonical='Bwat', **extra):
    return {'version': '2026-10-06.1', 'targets': [
        {'id': 'bwat', 'canonical': canonical, 'hardness': 'hard', 'proper_noun': True}],
        'aliases': [{'alias': alias, 'target_id': 'bwat', **extra}], 'people': []}


def test_whole_words_case_and_originals():
    dictionary = Dictionary.compile(payload())
    original = Segment(3, 'Ada', 'Boat and boat, not boathouse.', 10, 20)
    result = dictionary.correct(original)
    assert result.text == 'Bwat and Bwat, not boathouse.'
    assert result.original_text == original.text
    assert result.dictionary_version == '2026-10-06.1'
    assert result.seq == 3 and result.start_ms == 10
    assert dictionary.correct(Segment(4, 'Ada', 'boat', 20, 30, 'chat')).text == 'boat'


def test_alias_keys_use_the_same_lowercasing_as_backend_validation():
    data = payload(alias='ß')
    data['aliases'].append({'alias': 'ss', 'target_id': 'bwat'})
    assert Dictionary.compile(data).correct(Segment(0, 'Ada', 'ß ss', 0, 1)).text == 'Bwat Bwat'


def test_capitalization_and_longest_phrase_and_no_cascade():
    data = payload(require_capitalised=True)
    data['targets'].append({'id': 'other', 'canonical': 'boat', 'hardness': 'hard', 'proper_noun': True})
    # Overlapping aliases are applied once against the original input.
    data['aliases'] = [{'alias': 'blue boat', 'target_id': 'other'},
                       {'alias': 'boat', 'target_id': 'bwat', 'require_capitalised': True}]
    # A canonical/alias collision is invalid rather than an ambiguous rewrite.
    with pytest.raises(ValueError):
        Dictionary.compile(data)
    data['targets'][1]['canonical'] = 'Blueboat'
    d = Dictionary.compile(data)
    assert d.correct(Segment(0, 'Ada', 'blue boat Boat boat', 0, 1)).text == 'Blueboat Bwat boat'


def test_settings_read_compiles_and_clear_disables_corrections():
    body = {'settings': {}, 'providerKeys': {}, 'dictionary': {'state': 'set', 'payload': payload()}}
    settings = Settings.from_body(body)
    assert settings.dictionary.correct(Segment(0, 'Ada', 'boat', 0, 1)).text == 'Bwat'
    body['dictionary'] = {'state': 'cleared', 'payload': None}
    assert Settings.from_body(body).dictionary.correct(Segment(0, 'Ada', 'boat', 0, 1)).text == 'boat'
    body['dictionary'] = {'state': 'set', 'payload': {'targets': [], 'aliases': [{'alias': 'bad', 'target_id': 'missing'}]}}
    with pytest.raises(BackendError):
        Settings.from_body(body)


async def test_audio_queue_gets_corrected_text_and_picks_up_new_dictionary():
    cuts, out = asyncio.Queue(), asyncio.Queue()
    dictionary = Dictionary.compile(payload())
    async def transcribe(pcm):
        nonlocal dictionary
        if pcm == b'second':
            dictionary = Dictionary.compile(payload(canonical='BWAT'))
        return 'boat'
    cuts.put_nowait((42, 'Ada', b'first', 0, 1))
    cuts.put_nowait((42, 'Ada', b'second', 1, 2))
    cuts.put_nowait(None)
    await _transcribe_in_order(cuts, transcribe, out, itertools.count(), lambda s: dictionary.correct(s))
    first, second = out.get_nowait(), out.get_nowait()
    assert (first.text, second.text) == ('Bwat', 'BWAT')
    assert first.original_text == second.original_text == 'boat'
