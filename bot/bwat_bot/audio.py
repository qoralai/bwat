"""Meeting audio to transcript segments: resample to 16 kHz, cut into utterances by
loudness, transcribe each in order (Track 4).

Ported from the prototype's audio pipeline (docs/provenance.md), cut to the mixed stream and
the loudness detector. Time is the byte count of 16 kHz mono 16-bit audio, 32 bytes a
millisecond, so a segment's offsets are milliseconds of meeting audio since the join (for one
participant's own stream, of that stream's audio, which may run behind the meeting's).
Logs never carry the words heard.
"""
import asyncio
import itertools
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from dataclasses import dataclass

import numpy as np

log = logging.getLogger("bwat_bot")

TARGET_RATE = 16_000
BYTES_PER_MS = 32
SPEAKER = "Speaker 1"  # the mixed stream names no one


QUEUE_SEGMENTS = 2000  # a claim's unpushed segments: about half an hour of talk


@dataclass(frozen=True)
class Segment:
    """One utterance as the transcript push sends it."""

    seq: int
    speaker_label: str
    text: str
    start_ms: int
    end_ms: int
    source: str = "asr"  # or "chat": a line written in the meeting chat
    original_text: str | None = None
    original_speaker_label: str | None = None
    dictionary_version: str | None = None
    speaker_zoom_id: str | None = None
    speaker_member_id: str | None = None


def put_dropping_oldest(queue: asyncio.Queue, item) -> None:
    """Queues `item`; a full queue drops its oldest entry first (the newest
    talk matters most, and nothing is kept on disk)."""
    if queue.full():
        queue.get_nowait()
        log.warning("transcript.dropped", extra={"count": 1})
    queue.put_nowait(item)


def resample_int16(arr: np.ndarray, src_rate: int, dst_rate: int = TARGET_RATE) -> np.ndarray:
    """Linear-resamples mono int16 PCM from src_rate to dst_rate."""
    if src_rate == dst_rate or arr.size < 2:
        return arr
    new_len = max(1, round(arr.size * dst_rate / src_rate))
    x_old = np.arange(arr.size)
    x_new = np.linspace(0, arr.size - 1, new_len)
    return np.interp(x_new, x_old, arr.astype(np.float32)).astype(np.int16)


def _rms(pcm: bytes) -> float:
    arr = np.frombuffer(pcm, dtype=np.int16)
    return float(np.sqrt(np.mean(arr.astype(np.float32) ** 2))) if arr.size else 0.0


START_RMS, END_RMS = 400, 250
END_SILENCE_MS, MIN_MS, MAX_MS = 500, 300, 6000


class Segmenter:
    """Hysteresis voice detection over 16 kHz mono 16-bit PCM: speech starts above
    START_RMS and continues while above END_RMS. `feed` returns the utterances that
    frame completed: after END_SILENCE_MS of quiet, or at MAX_MS of speech. One with
    less than MIN_MS of speech is dropped, since a transcriber hears words in noise."""

    def __init__(self) -> None:
        self._speaking = False
        self._buf = bytearray()
        self._silence_ms = 0.0

    def feed(self, pcm: bytes) -> list[bytes]:
        rms = _rms(pcm)
        if not self._speaking:
            if rms > START_RMS:
                self._speaking = True
                self._buf = bytearray(pcm)
                self._silence_ms = 0.0
            return []
        self._buf.extend(pcm)
        if rms < END_RMS:
            self._silence_ms += len(pcm) / BYTES_PER_MS
            if self._silence_ms > END_SILENCE_MS:
                speech_ms = len(self._buf) / BYTES_PER_MS - self._silence_ms
                segment = bytes(self._buf)
                self._reset()
                return [segment] if speech_ms >= MIN_MS else []
        else:
            self._silence_ms = 0.0
            if len(self._buf) / BYTES_PER_MS >= MAX_MS:
                segment = bytes(self._buf)
                self._reset()
                return [segment]
        return []

    def flush(self) -> list[bytes]:
        """The utterance still open when the audio ends, if it holds enough speech."""
        if not self._speaking:
            return []
        speech_ms = len(self._buf) / BYTES_PER_MS - self._silence_ms
        segment = bytes(self._buf)
        self._reset()
        return [segment] if speech_ms >= MIN_MS else []

    def _reset(self) -> None:
        self._speaking = False
        self._buf = bytearray()
        self._silence_ms = 0.0


# A participant's stream silent this long has ended its utterance: the segmenter's own
# end-of-speech gap, measured by the clock since Zoom may send no silence.
QUIET_STREAM_SECONDS = 0.5


async def transcribe_audio(audio: AsyncIterator, transcribe: Callable[[bytes], Awaitable[str]],
                           out: asyncio.Queue, seqs: Iterator[int] | None = None,
                           clock: Callable[[], float] = time.monotonic,
                           sweep_seconds: float = 0.25,
                           correct: Callable[[Segment], Segment] | None = None) -> None:
    """Reads a bridge's audio (an audio_format dict, then PCM chunks) until it ends, and
    puts a Segment on `out` for each utterance with words in it, numbered from `seqs`
    (from 0 by default). A chunk
    is the mixed stream's PCM, or (participant id, name, PCM) for one participant's own
    stream, which is cut on its own and labelled with the latest name heard for it. Cutting never waits on a transcription: utterances queue for
    one transcriber, in order. If either side fails, both stop."""
    cuts: asyncio.Queue = asyncio.Queue()
    async with asyncio.TaskGroup() as tasks:
        tasks.create_task(_transcribe_in_order(cuts, transcribe, out, seqs or itertools.count(), correct))
        rate = TARGET_RATE
        # stream id -> [Segmenter, bytes fed, latest name, where its audio ends in ms,
        # when it last sent audio]
        streams: dict[object, list] = {}
        # A participant's own stream starts at their first sound, so its bytes are not
        # meeting time: its utterances are timed by this clock from the meeting's first
        # audio. The mixed stream is continuous, so its bytes are.
        start = None

        def end_quiet_utterances(now: float) -> None:
            """Zoom may send nothing while a participant is quiet: an utterance whose stream
            has been silent past the end-of-speech gap ends now."""
            for node, other in streams.items():
                if now - other[4] > QUIET_STREAM_SECONDS:
                    for segment in other[0].flush():
                        cuts.put_nowait((node, other[2], segment, max(0, other[3] - len(segment) // BYTES_PER_MS), other[3]))

        async def sweep() -> None:
            # When the whole room goes quiet no chunk arrives at all: a timer ends the last
            # utterance instead of leaving it for the next sound.
            while True:
                await asyncio.sleep(sweep_seconds)
                end_quiet_utterances(clock())

        sweeper = tasks.create_task(sweep())
        async for item in audio:
            if isinstance(item, dict):
                rate = int(item["sample_rate"])
                continue
            now = clock()
            start = now if start is None else start
            stream_id, speaker, pcm = item if isinstance(item, tuple) else (0, SPEAKER, item)
            # Including this chunk's own stream, coming back after a pause: its last audio
            # time is still the one before the pause.
            end_quiet_utterances(now)
            if rate != TARGET_RATE:
                pcm = resample_int16(np.frombuffer(pcm, dtype=np.int16), rate).tobytes()
            stream = streams.setdefault(stream_id, [Segmenter(), 0, speaker, 0, now])
            stream[1] += len(pcm)
            stream[2] = speaker
            stream[4] = now
            mixed = isinstance(item, bytes)
            # Where this chunk ends on the meeting's timeline, in ms.
            stream[3] = stream[1] // BYTES_PER_MS if mixed else int((now - start) * 1000)
            for segment in stream[0].feed(pcm):
                # The mix's bytes give an exact start; a participant's is its end less its length.
                begins = ((stream[1] - len(segment)) // BYTES_PER_MS if mixed
                          else max(0, stream[3] - len(segment) // BYTES_PER_MS))
                cuts.put_nowait((stream_id, speaker, segment, begins, stream[3]))
        sweeper.cancel()
        for node, stream in streams.items():  # the meeting ended mid-sentence
            for segment in stream[0].flush():
                cuts.put_nowait((node, stream[2], segment, max(0, stream[3] - len(segment) // BYTES_PER_MS), stream[3]))
        cuts.put_nowait(None)


async def _transcribe_in_order(cuts: asyncio.Queue, transcribe, out: asyncio.Queue,
                               seqs: Iterator[int], correct: Callable[[Segment], Segment] | None = None) -> None:
    while (cut := await cuts.get()) is not None:
        node, speaker, pcm, begins, ends = cut  # on the meeting's timeline, in ms
        text = await transcribe(pcm)
        if not text:
            continue  # the route was closed, the call failed, or nothing was said
        segment = Segment(next(seqs), speaker, text, begins, ends,
                          speaker_zoom_id=str(node) if node else None)
        put_dropping_oldest(out, correct(segment) if correct else segment)
