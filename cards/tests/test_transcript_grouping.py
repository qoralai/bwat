import pytest

from tests.acceptance.test_commitment_becomes_card import line
from writer.window import checked, transcript_lines


def test_consecutive_speech_reads_as_one_turn_with_each_receipt_retained():
    frames = [line(297, "Nora", "I will just record"), line(298, "Nora", "my screen."),
              line(299, "Nora", "Then take screenshots."), line(300, "Marco", "Great.")]
    assert transcript_lines(frames) == (
        "[Nora @e0 seq 297] I will just record [@e0 seq 298] my screen. "
        "[@e0 seq 299] Then take screenshots.\n[Marco @e0 seq 300] Great.")
    assert checked([{"epoch": 0, "seq": 298, "quote": "my screen."}], frames)
    assert checked([{"epoch": 0, "seq": 297, "quote": "I will just record my screen."}], frames) is None


def test_turn_boundaries_include_epoch_source_and_identity_not_only_display_name():
    frames = [line(0, "Nora", "one"), line(1, "Nora", "two", source="chat"),
              line(2, "Nora", "three", epoch=1), line(3, "Nora", "four")]
    frames[-1]["speaker"]["zoom_id"] = "different-stream"
    assert len(transcript_lines(frames).splitlines()) == 4


def test_a_long_silent_gap_starts_a_new_turn():
    frames = [line(0, 'Nora', 'I will record this.'), line(1, 'Nora', 'Different topic.')]
    frames[1]['start_ms'] = 120000
    frames[1]['end_ms'] = 120900
    assert len(transcript_lines(frames).splitlines()) == 2


@pytest.mark.parametrize(('previous_end', 'start', 'turns'), [
    (900, 900, 1),       # Adjacent frames belong to one turn.
    (900, 5900, 1),      # The five-second limit is inclusive.
    (900, 5901, 2),
    (900, 899, 2),       # Overlapping or out-of-order timing is not joined.
    (None, 1000, 2),
    (900, None, 2),
])
def test_turn_grouping_requires_known_nonoverlapping_timing(previous_end, start, turns):
    frames = [line(0, 'Nora', 'First segment.'), line(1, 'Nora', 'Next segment.')]
    frames[0]['end_ms'] = previous_end
    frames[1]['start_ms'] = start
    assert len(transcript_lines(frames).splitlines()) == turns
