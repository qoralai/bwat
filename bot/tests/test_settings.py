"""GET /v1/bot/settings: what every bot applies, polled with its ETag. Model keys are asked
for in memory only and never appear in a repr; an unset setting falls back to the bot's
own default; a read that fails or comes back malformed keeps what the bot had."""
import pytest

from bwat_bot.audio import Segment
from bwat_bot.backend import BackendClient, BackendError
from bwat_bot.settings import Settings, SettingsPoller
from tests.conftest import Clock
from tests.test_dictionary import payload

KEY = "sk-or-v1-" + "c" * 64


async def test_bad_dictionary_keeps_last_good_dictionary_then_clear_disables_it(backend, client):
    backend.dictionary = {'state': 'set', 'payload': payload()}
    clock = Clock()
    poller = SettingsPoller(clock=clock)
    await poller.refresh(client)
    backend.dictionary = {'state': 'set', 'payload': {'targets': []}}
    backend.settings_version += 1
    clock.now += 31
    with pytest.raises(BackendError):
        await poller.refresh(client)
    segment = Segment(0, 'Ada', 'boat', 0, 1)
    assert poller.current.dictionary.correct(segment).text == 'Bwat'
    backend.dictionary = {'state': 'cleared', 'payload': None}
    backend.settings_version += 1
    clock.now += 31
    await poller.refresh(client)
    assert poller.current.dictionary.correct(segment).text == 'boat'


@pytest.fixture
async def client(backend, config):
    client = BackendClient(config, backend.transport())
    await client.register("test")
    yield client
    await client.aclose()


def reads(backend) -> list:
    return [r for r in backend.requests if r.path == "/v1/bot/settings"]


def test_the_defaults_apply_before_anything_is_read():
    assert SettingsPoller().current == Settings("bwat", {})


def test_the_meeting_chat_posts_are_off_until_an_admin_turns_them_on():
    defaults = Settings.from_body({"settings": {}, "providerKeys": {}})
    assert (defaults.chat_posts_enabled, defaults.chat_agenda_enabled) == (False, False)


async def test_served_values_and_keys_are_applied(backend, client):
    backend.settings_values = {"display_name": "Acme notes"}
    backend.provider_keys = {"openrouter": KEY}
    poller = SettingsPoller()
    await poller.refresh(client)
    assert poller.current == Settings("Acme notes", {"openrouter": KEY})


async def test_a_key_never_appears_in_a_repr(backend, client):
    backend.provider_keys = {"openrouter": KEY}
    poller = SettingsPoller()
    await poller.refresh(client)
    assert KEY not in repr(poller.current) and KEY not in repr(poller)


async def test_an_unchanged_answer_is_a_304_that_keeps_the_values(backend, client):
    backend.settings_values = {"display_name": "Acme notes"}
    backend.provider_keys = {"openrouter": KEY}
    clock = Clock()
    poller = SettingsPoller(every=30, clock=clock)
    await poller.refresh(client)
    clock.now += 31
    await poller.refresh(client)
    first, second = reads(backend)
    assert "if-none-match" not in first.headers
    assert second.headers["if-none-match"].startswith('"settings-1-keys-')
    assert poller.current == Settings("Acme notes", {"openrouter": KEY})


async def test_it_reads_again_only_once_the_interval_has_passed(backend, client):
    clock = Clock()
    poller = SettingsPoller(every=30, clock=clock)
    await poller.refresh(client)
    clock.now += 29
    await poller.refresh(client)
    assert len(reads(backend)) == 1
    clock.now += 2
    await poller.refresh(client)
    assert len(reads(backend)) == 2


async def test_a_setting_cleared_in_the_panel_falls_back_to_the_default(backend, client):
    clock = Clock()
    poller = SettingsPoller(every=30, clock=clock)
    backend.settings_values = {"display_name": "Acme notes"}
    await poller.refresh(client)
    backend.settings_values, backend.settings_version = {}, 2
    clock.now += 31
    await poller.refresh(client)
    assert poller.current == Settings("bwat", {})


@pytest.mark.parametrize("body", [
    {"settings": {"display_name": 7}, "providerKeys": {}},
    {"settings": {"waiting_room_min": "15"}, "providerKeys": {}},
    {"settings": {"chat_agenda_enabled": "off"}, "providerKeys": {}},
    {"settings": {}, "providerKeys": {"openrouter": 5}},
    {"settings": {}, "providerKeys": []},
    {"settings": [], "providerKeys": {}},
    ["not", "an", "object"],
])
async def test_a_malformed_answer_keeps_the_last_good_settings(backend, client, body):
    backend.provider_keys = {"openrouter": KEY}
    clock = Clock()
    poller = SettingsPoller(every=30, clock=clock)
    await poller.refresh(client)
    good = poller.current
    backend.settings_body, backend.settings_version = body, 2
    clock.now += 31
    with pytest.raises(BackendError) as caught:
        await poller.refresh(client)
    assert caught.value.code == "malformed_settings"
    assert poller.current == good


async def test_a_failed_read_is_tried_again_once_the_interval_has_passed(backend, client):
    clock = Clock()
    poller = SettingsPoller(every=30, clock=clock)
    backend.unavailable.add("/v1/bot/settings")
    with pytest.raises(BackendError):
        await poller.refresh(client)
    await poller.refresh(client)  # a failing route is not hit on every tick
    assert len(reads(backend)) == 1
    backend.unavailable.clear()
    backend.provider_keys = {"openrouter": KEY}
    clock.now += 31
    await poller.refresh(client)
    assert poller.current.provider_keys == {"openrouter": KEY}


async def test_an_answer_without_an_etag_is_read_in_full_next_time(backend, client):
    # A partial key read carries no ETag; the next poll must not send a stale one.
    clock = Clock()
    poller = SettingsPoller(every=30, clock=clock)
    await poller.refresh(client)
    backend.settings_body = {"settings": {}, "providerKeys": {}}  # served without an ETag
    clock.now += 31
    await poller.refresh(client)
    backend.settings_body = None
    clock.now += 31
    await poller.refresh(client)
    assert "if-none-match" not in reads(backend)[2].headers


async def test_a_served_join_muted_or_camera_off_is_ignored(backend, client):
    # bwat joins unmuted (it never speaks) and has no camera: neither is a setting now.
    backend.settings_values = {"join_muted": True, "join_video_off": True}
    poller = SettingsPoller()
    await poller.refresh(client)
    assert poller.current == Settings("bwat", {})
