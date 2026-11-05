"""D139 / QOR-4557 through the running bot: it reports ready only while its transcription
route cannot train on meeting audio and it holds the key GET /v1/bot/settings served it.
The key travels only to the transcription host; the bot token only to the backend."""
import asyncio
from contextlib import asynccontextmanager

import pytest

from bwat_bot.settings import SettingsPoller
from bwat_bot.transcription import Transcriber
from tests.conftest import calls, make_bot, until
from tests.fake_asr import PCM, FakeOpenRouter

SETTINGS = "/v1/bot/settings"
KEY = "sk-or-v1-" + "a" * 64
UNREADY = {"ready": False, "reason": "transcription_unavailable"}


@pytest.fixture
def openrouter() -> FakeOpenRouter:
    return FakeOpenRouter()


@asynccontextmanager
async def started(backend, bridge, config, openrouter):
    settings = SettingsPoller(every=0.01)
    transcriber = Transcriber(config, keys=lambda: settings.current.provider_keys,
                              inner=openrouter.transport())
    bot = make_bot(backend, bridge, config, settings=settings,
                   transcription_ready=transcriber.ready)
    task = asyncio.create_task(bot.run())
    try:
        yield transcriber
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)
        await transcriber.aclose()


async def test_ready_on_a_zero_data_retention_route_and_audio_reaches_it(
        backend, bridge, config, openrouter):
    backend.provider_keys = {"openrouter": KEY}
    async with started(backend, bridge, config, openrouter) as transcriber:
        await until(lambda: True in backend.ready.values())
        assert await transcriber.transcribe(PCM) == "hello"
    (post,) = openrouter.audio_posts()
    assert str(post.url) == "https://openrouter.ai/api/v1/audio/transcriptions"
    assert post.headers["authorization"] == f"Bearer {KEY}"
    settings_reads = [r for r in backend.requests if r.path == SETTINGS]
    assert settings_reads and all(
        r.headers.get("x-bwat-provider-keys") == "memory-only" for r in settings_reads)


async def test_one_endpoint_off_the_zero_data_retention_list_keeps_the_bot_unready(
        backend, bridge, config, openrouter):
    backend.provider_keys = {"openrouter": KEY}
    openrouter.served.append("Reseller | deepgram/nova-3")
    async with started(backend, bridge, config, openrouter) as transcriber:
        await until(lambda: UNREADY in backend.ready_bodies)
        assert await transcriber.transcribe(PCM) == ""
    assert True not in backend.ready.values()
    assert openrouter.audio_posts() == []


async def test_without_a_served_key_the_bot_stays_unready(backend, bridge, config, openrouter):
    async with started(backend, bridge, config, openrouter) as transcriber:
        await until(lambda: UNREADY in backend.ready_bodies)
        assert await transcriber.transcribe(PCM) == ""
    assert True not in backend.ready.values()
    assert openrouter.audio_posts() == []


async def test_a_key_saved_later_reaches_the_bot_and_makes_it_ready(
        backend, bridge, config, openrouter):
    async with started(backend, bridge, config, openrouter):
        await until(lambda: UNREADY in backend.ready_bodies)
        backend.provider_keys = {"openrouter": KEY}  # an admin saves the key in the panel
        backend.settings_version += 1
        await until(lambda: True in backend.ready.values())


async def test_each_credential_goes_only_to_its_own_host(backend, bridge, config, openrouter):
    backend.provider_keys = {"openrouter": KEY, "openai": "sk-openai-" + "b" * 40}
    async with started(backend, bridge, config, openrouter) as transcriber:
        await until(lambda: True in backend.ready.values())
        await transcriber.transcribe(PCM)
    assert openrouter.requests
    assert all("bwb_" not in r.headers.get("authorization", "") for r in openrouter.requests)
    assert all(r.url.host == "openrouter.ai" for r in openrouter.requests)
    assert all(KEY not in (r.authorization or "") for r in backend.requests)
    # the policy lookups are public: no key goes with them
    assert all("authorization" not in r.headers for r in openrouter.requests if r.method == "GET")


async def test_a_settings_read_that_fails_keeps_the_last_good_key(
        backend, bridge, config, openrouter):
    backend.provider_keys = {"openrouter": KEY}
    async with started(backend, bridge, config, openrouter) as transcriber:
        await until(lambda: True in backend.ready.values())
        backend.unavailable.add(SETTINGS)
        reads = calls(backend, SETTINGS)
        await until(lambda: calls(backend, SETTINGS) >= reads + 2)
        assert await transcriber.transcribe(PCM) == "hello"
    assert UNREADY not in backend.ready_bodies


async def test_a_settings_outage_does_not_stop_the_bot_taking_meetings(
        backend, bridge, config, openrouter):
    backend.provider_keys = {"openrouter": KEY}
    async with started(backend, bridge, config, openrouter):
        await until(lambda: True in backend.ready.values())
        backend.unavailable.add(SETTINGS)
        reads = calls(backend, SETTINGS)
        await until(lambda: calls(backend, SETTINGS) >= reads + 2)
        backend.send("84912345678")
        await until(lambda: bridge.joins)
