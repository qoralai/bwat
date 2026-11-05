"""The segmenter cuts 16 kHz mono speech into utterances by loudness; time is the byte count
(32 bytes a millisecond), so nothing here sleeps. The cases are the prototype's own."""
import asyncio

import numpy as np
import pytest

from bwat_bot.audio import Segment, Segmenter, resample_int16, transcribe_audio

LOUD, QUIET = 3000, 0  # against the thresholds: start 400, end 250


def frames(amplitude: int, total_ms: int, frame_ms: int = 50) -> list[bytes]:
    """Constant-amplitude frames, so each frame's RMS is `amplitude`."""
    frame = np.full(16 * frame_ms, amplitude, dtype=np.int16).tobytes()
    return [frame] * (total_ms // frame_ms)


def cut(chunks: list[bytes]) -> list[bytes]:
    segmenter = Segmenter()
    return [segment for chunk in chunks for segment in segmenter.feed(chunk)]


def test_speech_then_silence_is_one_segment():
    speech = frames(LOUD, 500)
    (segment,) = cut(speech + frames(QUIET, 800))
    assert segment.startswith(b"".join(speech))


def test_a_blip_under_300_ms_is_dropped():
    assert cut(frames(LOUD, 100) + frames(QUIET, 800)) == []


def test_speech_is_cut_every_6_s():
    assert len(cut(frames(LOUD, 6500))) == 1
    assert len(cut(frames(LOUD, 12500))) == 2  # the last 0.5 s is still open


def test_an_utterance_ends_after_500_ms_of_silence():
    segmenter = Segmenter()
    speech_and_pause = frames(LOUD, 500) + frames(QUIET, 450)
    assert [s for c in speech_and_pause for s in segmenter.feed(c)] == []
    assert len([s for c in frames(QUIET, 150) for s in segmenter.feed(c)]) == 1


def test_a_dip_between_the_thresholds_does_not_end_speech():
    assert cut(frames(LOUD, 400) + frames(300, 800) + frames(LOUD, 400)) == []


def test_silence_yields_nothing():
    assert cut(frames(QUIET, 2000)) == []


def test_resampling_to_16_khz():
    pcm = np.arange(3200, dtype=np.int16)  # 100 ms at 32 kHz
    resampled = resample_int16(pcm, 32_000)
    assert resampled.dtype == np.int16 and resampled.size == 1600
    assert resampled[0] == 0 and resampled[-1] == 3199
    assert resample_int16(pcm, 16_000) is pcm


async def test_utterances_are_numbered_in_order_at_the_bridge_rate():
    async def bridge_audio():
        yield {"sample_rate": 32_000, "channels": 1}
        for amplitude, ms in ((LOUD, 500), (QUIET, 600), (LOUD, 400), (QUIET, 600)):
            # 32 kHz: each 800-sample frame is 25 ms, so an utterance closes 525 ms into quiet
            for frame in frames(amplitude, 2 * ms):
                yield frame

    texts = iter(["first", "second"])

    async def transcribe(pcm: bytes) -> str:
        await asyncio.sleep(0)
        return next(texts)

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(bridge_audio(), transcribe, out)
    assert [out.get_nowait(), out.get_nowait()] == [
        Segment(0, "Speaker 1", "first", 0, 1025),
        Segment(1, "Speaker 1", "second", 1100, 2025),
    ]
    assert out.empty()


async def test_offsets_keep_sub_millisecond_precision():
    async def bridge_audio():
        yield {"sample_rate": 16_000, "channels": 1}
        yield np.zeros(1, dtype=np.int16).tobytes()  # speech starts 1/16 ms in
        yield np.full(15, LOUD, dtype=np.int16).tobytes()
        for frame in frames(LOUD, 500) + frames(QUIET, 600):
            yield frame

    async def transcribe(pcm: bytes) -> str:
        return "words"

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(bridge_audio(), transcribe, out)
    segment = out.get_nowait()
    assert (segment.start_ms, segment.end_ms) == (0, 1051)


async def test_a_transcriber_that_raises_stops_the_audio():
    async def endless_audio():
        yield {"sample_rate": 16_000, "channels": 1}
        while True:
            for frame in frames(LOUD, 500) + frames(QUIET, 600):
                yield frame
                await asyncio.sleep(0)

    async def transcribe(pcm: bytes) -> str:
        raise RuntimeError("bug")

    with pytest.raises(ExceptionGroup):
        await asyncio.wait_for(transcribe_audio(endless_audio(), transcribe, asyncio.Queue()), 2)


async def test_an_utterance_still_open_when_the_audio_ends_is_kept():
    async def ends_mid_sentence():
        yield {"sample_rate": 16_000, "channels": 1}
        for frame in frames(QUIET, 100) + frames(LOUD, 500):
            yield frame

    async def transcribe(pcm: bytes) -> str:
        return "last words"

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(ends_mid_sentence(), transcribe, out)
    assert out.get_nowait() == Segment(0, "Speaker 1", "last words", 100, 600)


def test_a_blip_open_when_the_audio_ends_is_still_dropped():
    segmenter = Segmenter()
    for frame in frames(LOUD, 100):
        segmenter.feed(frame)
    assert segmenter.flush() == []


async def test_a_full_queue_drops_its_oldest_segment():
    async def bridge_audio():
        yield {"sample_rate": 16_000, "channels": 1}
        for _ in range(3):
            for frame in frames(LOUD, 500) + frames(QUIET, 600):
                yield frame

    async def transcribe(pcm: bytes) -> str:
        return "words"

    out: asyncio.Queue = asyncio.Queue(maxsize=2)
    await transcribe_audio(bridge_audio(), transcribe, out)
    assert [out.get_nowait().seq, out.get_nowait().seq] == [1, 2]


async def test_each_voice_is_cut_and_labelled_on_its_own():
    async def per_participant_audio():
        yield {"sample_rate": 16_000, "channels": 1}
        # Ada and Grace talk over each other; each stream still cuts on its own.
        for ada, grace in zip(frames(LOUD, 500) + frames(QUIET, 800),
                              frames(QUIET, 200) + frames(LOUD, 500) + frames(QUIET, 600)):
            yield (16778240, "Ada", ada)
            yield (16779264, "Grace", grace)

    async def transcribe(pcm: bytes) -> str:
        return "words"

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(per_participant_audio(), transcribe, out)
    segments = [out.get_nowait() for _ in range(out.qsize())]
    assert sorted(s.speaker_label for s in segments) == ["Ada", "Grace"]
    assert [s.seq for s in segments] == [0, 1]



async def test_two_people_with_one_name_are_still_two_voices():
    async def same_name():
        yield {"sample_rate": 16_000, "channels": 1}
        for one, two in zip(frames(LOUD, 500) + frames(QUIET, 800),
                            frames(QUIET, 200) + frames(LOUD, 500) + frames(QUIET, 600)):
            yield (1, "Alex", one)
            yield (2, "Alex", two)

    async def transcribe(pcm: bytes) -> str:
        return "words"

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(same_name(), transcribe, out)
    segments = [out.get_nowait() for _ in range(out.qsize())]
    assert [s.speaker_label for s in segments] == ["Alex", "Alex"]
    assert all(s.end_ms - s.start_ms < 1200 for s in segments)  # never merged


async def test_a_name_learned_mid_utterance_labels_the_whole_utterance():
    async def named_late():
        yield {"sample_rate": 16_000, "channels": 1}
        for i, chunk in enumerate(frames(LOUD, 500) + frames(QUIET, 600)):
            yield (42, "Participant 42" if i < 3 else "Ada", chunk)

    async def transcribe(pcm: bytes) -> str:
        return "words"

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(named_late(), transcribe, out)
    (segment,) = [out.get_nowait() for _ in range(out.qsize())]
    assert segment.speaker_label == "Ada" and segment.start_ms == 0


async def test_a_participant_who_first_speaks_later_is_timed_on_the_meetings_clock():
    # Each participant's stream starts with their first sound, so its bytes say nothing
    # about meeting time: Grace speaking 30 s in must not read as 0 s.
    now = [0.0]

    async def late_speaker():
        yield {"sample_rate": 16_000, "channels": 1}
        for chunk in frames(LOUD, 500) + frames(QUIET, 600):
            yield (16778240, "Ada", chunk)
            now[0] += 0.05
        now[0] = 30.0
        for chunk in frames(LOUD, 500) + frames(QUIET, 600):
            yield (16779264, "Grace", chunk)
            now[0] += 0.05

    async def transcribe(pcm: bytes) -> str:
        return "words"

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(late_speaker(), transcribe, out, clock=lambda: now[0])
    ada, grace = [out.get_nowait() for _ in range(out.qsize())]
    assert ada.speaker_label == "Ada" and ada.start_ms < 1000
    assert grace.speaker_label == "Grace" and 29_000 <= grace.start_ms <= 31_000
    assert grace.end_ms > grace.start_ms


async def test_a_participant_who_goes_quiet_ends_their_utterance_though_no_silence_arrives():
    # Zoom may send nothing while someone is silent: their utterance must still end once
    # they have been quiet long enough, not wait for their next word.
    now = [0.0]

    async def ada_stops_grace_goes_on():
        yield {"sample_rate": 16_000, "channels": 1}
        for chunk in frames(LOUD, 500):
            yield (16778240, "Ada", chunk)
            now[0] += 0.05
        for chunk in frames(QUIET, 1000) + frames(LOUD, 500) + frames(QUIET, 600):
            yield (16779264, "Grace", chunk)
            now[0] += 0.05

    async def transcribe(pcm: bytes) -> str:
        return "words"

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(ada_stops_grace_goes_on(), transcribe, out, clock=lambda: now[0])
    first, second = [out.get_nowait() for _ in range(out.qsize())]
    assert (first.speaker_label, second.speaker_label) == ("Ada", "Grace")
    assert first.end_ms <= 1000


async def test_one_person_speaking_again_after_a_pause_is_two_utterances():
    now = [0.0]

    async def ada_pauses():
        yield {"sample_rate": 16_000, "channels": 1}
        for chunk in frames(LOUD, 500):
            yield (16778240, "Ada", chunk)
            now[0] += 0.05
        now[0] += 10  # Zoom sent nothing while she was quiet
        for chunk in frames(LOUD, 500) + frames(QUIET, 600):
            yield (16778240, "Ada", chunk)
            now[0] += 0.05

    async def transcribe(pcm: bytes) -> str:
        return "words"

    out: asyncio.Queue = asyncio.Queue()
    await transcribe_audio(ada_pauses(), transcribe, out, clock=lambda: now[0])
    first, second = [out.get_nowait() for _ in range(out.qsize())]
    assert first.end_ms <= 1000 and second.start_ms >= 10_000


async def test_when_the_room_goes_quiet_the_last_utterance_ends_without_waiting_for_a_sound():
    now = [0.0]
    out: asyncio.Queue = asyncio.Queue()
    ended_before_the_meeting: list[int] = []

    async def ada_then_silence():
        yield {"sample_rate": 16_000, "channels": 1}
        for chunk in frames(LOUD, 500):
            yield (16778240, "Ada", chunk)
            now[0] += 0.05
        now[0] += 2  # nobody says anything, and Zoom sends nothing
        await asyncio.sleep(0.2)
        ended_before_the_meeting.append(out.qsize())

    async def transcribe(pcm: bytes) -> str:
        return "words"

    await transcribe_audio(ada_then_silence(), transcribe, out, clock=lambda: now[0], sweep_seconds=0.01)
    assert ended_before_the_meeting == [1]
