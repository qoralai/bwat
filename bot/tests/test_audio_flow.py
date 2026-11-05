"""Meeting audio through the running bot: once it has joined, the bridge's audio is cut into
utterances, each is transcribed, and what was said is queued for the transcript push."""
import asyncio
from pathlib import Path

from bwat_bot.audio import Segment
from bwat_bot.bridge import Ended, Joined, OccurrenceKnown
from bwat_bot.fake_bridge import FakeBridge
from bwat_bot.settings import SettingsPoller
from tests.conftest import MEETING, joined, make_bot, until
from tests.test_dictionary import payload

SPEECH = Path(__file__).parent / "fixtures" / "speech.wav"  # 1 s of tone between silences


async def test_dictionary_from_backend_applies_in_running_bot_before_queueing(backend, config):
    backend.dictionary = {'state': 'set', 'payload': payload()}
    bridge = FakeBridge(timeline=backend.timeline, audio=SPEECH)
    bot = make_bot(backend, bridge, config, transcribe=FakeAsr('Boat is ready'), settings=SettingsPoller())
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
        bridge.emit(Joined())
        result = await asyncio.wait_for(bot.segments.get(), 3)
        assert result.text == 'Bwat is ready'
        assert result.original_text == 'Boat is ready'
    finally:
        await stop(bot, task)


class FakeAsr:
    def __init__(self, text: str) -> None:
        self.text = text
        self.heard: list[bytes] = []

    async def __call__(self, pcm: bytes) -> str:
        self.heard.append(pcm)
        return self.text


async def attend(backend, config, asr: FakeAsr):
    bridge = FakeBridge(timeline=backend.timeline, audio=SPEECH)
    bot = make_bot(backend, bridge, config, transcribe=asr)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    bridge.emit(Joined())
    return bot, task


async def stop(bot, task) -> None:
    bot.stop()
    await asyncio.wait_for(task, 2)


async def test_what_is_said_after_joining_is_queued_as_a_segment(backend, config):
    asr = FakeAsr("ship it on friday")
    bot, task = await attend(backend, config, asr)
    try:
        segment = await asyncio.wait_for(bot.segments.get(), 3)
    finally:
        await stop(bot, task)
    assert segment == Segment(seq=0, speaker_label="Speaker 1", text="ship it on friday",
                              start_ms=segment.start_ms, end_ms=segment.end_ms)
    assert isinstance(segment.start_ms, int) and isinstance(segment.end_ms, int)
    # The tone runs from 200 ms to 1200 ms; the segment closes after 500 ms of silence.
    assert 150 <= segment.start_ms < 250 and 1650 <= segment.end_ms <= 1800
    (pcm,) = asr.heard
    assert len(pcm) == 32 * (segment.end_ms - segment.start_ms)


async def test_an_utterance_with_no_words_queues_nothing(backend, config):
    asr = FakeAsr("")
    bot, task = await attend(backend, config, asr)
    try:
        await until(lambda: asr.heard)
        await asyncio.sleep(0.05)
        assert bot.segments.empty()
    finally:
        await stop(bot, task)


async def test_each_claim_gets_its_own_segments(backend, config):
    asr = FakeAsr("ship it on friday")
    bot, task = await attend(backend, config, asr)
    bridge = bot._bridge
    try:
        first = bot.segments
        await asyncio.wait_for(first.get(), 3)
        bridge.emit(Ended())
        await until(lambda: backend.releases)
        backend.send(MEETING)
        await until(lambda: len(bridge.joins) == 2)
        bridge.emit(Joined())
        segment = await asyncio.wait_for(bot.segments.get(), 3)
    finally:
        await stop(bot, task)
    assert bot.segments is not first and segment.seq == 0


async def test_a_join_cut_short_by_a_stop_never_starts_the_audio(backend, config):
    class HangingJoin(FakeBridge):
        listened = False

        async def join(self, meeting_number, passcode, credentials=None, options=None):
            await super().join(meeting_number, passcode)
            self.emit(Joined())
            bot.stop()  # SIGTERM lands while the join is still running
            await asyncio.sleep(3600)

        def audio(self):
            self.listened = True
            return super().audio()

    bridge = HangingJoin(timeline=backend.timeline, audio=SPEECH)
    bot = make_bot(backend, bridge, config, transcribe=FakeAsr("ship it on friday"))
    task = asyncio.create_task(bot.run())
    await until(lambda: backend.ready)
    backend.send(MEETING)
    await asyncio.wait_for(task, 2)
    assert not bridge.listened


async def test_the_local_stacks_fake_bridge_reports_an_occurrence_after_joining():
    bridge = FakeBridge(auto_join=True)
    await bridge.join(MEETING, None)
    assert await bridge.next_event() == Joined()
    first = await bridge.next_event()
    assert isinstance(first, OccurrenceKnown) and len(first.occurrence_uuid) == 24
    await bridge.join(MEETING, None)
    await bridge.next_event()
    assert (await bridge.next_event()).occurrence_uuid != first.occurrence_uuid  # one per join


def test_an_audio_failure_logs_its_real_cause(caplog):
    from bwat_bot.lifecycle import _audio_done

    async def fails():
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(asyncio.sleep(0))
            raise ValueError("bad chunk")

    async def run():
        task = asyncio.create_task(fails())
        await asyncio.gather(task, return_exceptions=True)
        return task

    _audio_done(asyncio.run(run()))
    assert [r.error for r in caplog.records if r.msg == "audio.failed"] == ["ValueError"]


async def test_chat_is_numbered_after_what_was_said(backend, config):
    from bwat_bot.bridge import ChatMessage
    bot, task = await attend(backend, config, FakeAsr("ship it on friday"))
    try:
        said = await asyncio.wait_for(bot.segments.get(), 3)
        bot._bridge.emit(ChatMessage("Ada", "agreed"))
        chat = await asyncio.wait_for(bot.segments.get(), 3)
    finally:
        await stop(bot, task)
    assert (said.seq, said.source) == (0, "asr")
    assert (chat.seq, chat.source, chat.speaker_label, chat.text) == (1, "chat", "Ada", "agreed")
