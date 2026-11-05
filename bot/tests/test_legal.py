"""Legal review, built in from day one: log events, not content, at every level; no second
copy of anything on disk. Track 4 extends the disk check to audio and SDK logs."""
import asyncio
import logging
import os

from bwat_bot.bridge import Ended, Joined, OccurrenceKnown
from tests.conftest import MEETING, PASSCODE, joined, make_bot, until

OCCURRENCE = "kq8Zr1x2Tq+Ab/Cd9eFg=="


async def full_meeting(backend, bridge, config) -> str:
    """Register, join, promote, end, and stop; returns the bot token it used."""
    bot = make_bot(backend, bridge, config, heartbeat_seconds=0.01)
    task = asyncio.create_task(bot.run())
    await joined(backend, bridge)
    for event in (Joined(), OccurrenceKnown(OCCURRENCE), Ended()):
        bridge.emit(event)
    await until(lambda: backend.releases)
    bot.stop()
    await asyncio.wait_for(task, 2)
    return next(iter(backend.bots))


async def test_no_log_line_at_any_level_carries_content_or_secrets(backend, bridge, config,
                                                                   caplog):
    caplog.set_level(logging.DEBUG)
    bot_token = await full_meeting(backend, bridge, config)
    forbidden = [MEETING, PASSCODE, OCCURRENCE, bot_token, backend.fleet_credential,
                 "zoom.us", "Bearer "]
    text = "\n".join(
        f"{r.getMessage()} {r.__dict__}" for r in caplog.records
    )
    assert caplog.records  # the bot does log its events
    assert [f for f in forbidden if f in text] == []


async def test_transcription_logs_no_words_keys_or_provider_text(caplog):
    from tests.fake_asr import DEEPGRAM_URL, KEYS, PCM, FakeOpenRouter, make
    caplog.set_level(logging.DEBUG)
    fake = FakeOpenRouter(text="the quarterly numbers slipped")
    good = make(fake)
    assert await good.transcribe(PCM)
    fake.transcribe_status = 500
    assert await good.transcribe(PCM) == ""
    await make(FakeOpenRouter(zdr=())).transcribe(PCM)
    assert await make(FakeOpenRouter(text="the quarterly plan"), DEEPGRAM_URL).transcribe(PCM)
    text = "\n".join(f"{r.getMessage()} {r.__dict__}" for r in caplog.records)
    forbidden = ["quarterly", "the provider's own words", "Bearer ", "Token ", *KEYS.values()]
    assert caplog.records
    assert [f for f in forbidden if f in text] == []


async def test_nothing_is_written_to_disk(backend, bridge, config, tmp_path, monkeypatch):
    for name in ("HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"):
        monkeypatch.setenv(name, str(tmp_path))
    monkeypatch.chdir(tmp_path)
    await full_meeting(backend, bridge, config)
    assert os.listdir(tmp_path) == []


def test_the_process_keeps_http_libraries_from_logging_urls():
    from bwat_bot.__main__ import configure_logging
    configure_logging()
    for name in ("httpx", "httpcore"):
        assert not logging.getLogger(name).isEnabledFor(logging.INFO)
