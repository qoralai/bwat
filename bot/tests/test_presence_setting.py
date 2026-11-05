"""The admin's presence picture (D196): before each join the bot fetches it; with none, or
any failure, it shows the logo it ships with. BWAT_BOT_PRESENCE_IMAGE wins over both."""
import asyncio
import hashlib
import io

import pytest
from PIL import Image

from bwat_bot import presence
from bwat_bot.config import Config
from tests.conftest import MEETING, joined, make_bot, until
from tests.test_presence import BACKGROUND, LOGO

PRESENCE = "/v1/bot/presence-image"


def encoded(size=(1600, 900), fmt="PNG") -> bytes:
    width, height = size
    image = Image.new("RGB", size, BACKGROUND)
    image.paste(LOGO, (width // 3, height // 3, 2 * width // 3, 2 * height // 3))
    out = io.BytesIO()
    image.save(out, fmt)
    return out.getvalue()


@pytest.fixture
def options_seen(bridge):
    seen = []
    join = bridge.join

    async def recording_join(meeting_number, passcode, credentials=None, options=None):
        seen.append(options)
        bridge.timeline.append("bridge.join")
        await join(meeting_number, passcode, credentials, options)

    bridge.join = recording_join
    return seen


async def attend(backend, bridge, config, **options):
    """Runs the bot through one join, then stops it as SIGTERM would."""
    bot = make_bot(backend, bridge, config, **options)
    task = asyncio.create_task(bot.run())
    try:
        await joined(backend, bridge)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)


def presence_requests(backend):
    return [r for r in backend.requests if r.path == PRESENCE]


def test_the_bundled_default_is_the_logo_at_16_9():
    with Image.open(presence.DEFAULT_IMAGE) as image:
        assert image.size == (1280, 720)
    assert len(presence.i420_frame(presence.DEFAULT_IMAGE)) == 1280 * 720 * 3 // 2


async def test_with_no_upload_the_bot_shows_the_bundled_logo(backend, bridge, config, options_seen,
                                                              frame_path):
    await attend(backend, bridge, config)
    assert [o.presence_frame for o in options_seen] == [str(frame_path)]
    assert frame_path.read_bytes() == presence.i420_frame(presence.DEFAULT_IMAGE)


async def test_the_admins_picture_is_fetched_with_the_bot_token_before_the_join(
        backend, bridge, config, options_seen, frame_path):
    picture = encoded()
    backend.presence_image = ("image/png", picture)
    await attend(backend, bridge, config)
    assert [o.presence_frame for o in options_seen] == [str(frame_path)]
    assert frame_path.read_bytes() == presence.i420_frame(io.BytesIO(picture))
    [request] = presence_requests(backend)
    assert request.authorization.startswith("Bearer bwb_")
    assert backend.timeline.index(PRESENCE) < backend.timeline.index("bridge.join")


async def test_a_jpeg_is_used_too(backend, bridge, config, frame_path):
    picture = encoded((1280, 720), "JPEG")
    backend.presence_image = ("image/jpeg", picture)
    await attend(backend, bridge, config)
    assert frame_path.read_bytes() == presence.i420_frame(io.BytesIO(picture))


async def test_each_join_fetches_once_and_an_unchanged_picture_is_not_fetched_again(
        backend, bridge, config, frame_path):
    picture = encoded()
    backend.presence_image = ("image/png", picture)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    try:
        claim = await joined(backend, bridge)
        backend.recall(claim)
        await until(lambda: bridge.leaves)
        backend.send(MEETING)
        await until(lambda: len(bridge.joins) == 2)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)
    first, second = presence_requests(backend)
    assert "if-none-match" not in first.headers
    assert second.headers["if-none-match"] == f'"{hashlib.sha256(picture).hexdigest()}"'
    assert frame_path.read_bytes() == presence.i420_frame(io.BytesIO(picture))


async def test_a_picture_the_bot_cannot_use_is_logged_and_the_logo_shown(
        backend, bridge, config, options_seen, frame_path, caplog):
    backend.presence_image = ("image/png", encoded((1000, 1000)))
    await attend(backend, bridge, config)
    assert [r.error for r in caplog.records if r.msg == "bot.presence_image_invalid"] == [
        "the presence image must be 16:9, not 1000x1000"]
    assert [o.presence_frame for o in options_seen] == [str(frame_path)]
    assert frame_path.read_bytes() == presence.i420_frame(presence.DEFAULT_IMAGE)


async def test_a_failed_fetch_never_stops_the_join_and_shows_the_logo(
        backend, bridge, config, options_seen, frame_path, caplog):
    backend.presence_image = ("image/png", encoded())
    backend.unavailable.add(PRESENCE)
    await attend(backend, bridge, config)
    assert [r.error for r in caplog.records if r.msg == "presence.fetch_failed"] == ["503:unavailable"]
    assert [o.presence_frame for o in options_seen] == [str(frame_path)]
    assert frame_path.read_bytes() == presence.i420_frame(presence.DEFAULT_IMAGE)


async def test_a_failed_fetch_keeps_the_admins_picture_already_shown(backend, bridge, config, frame_path):
    picture = encoded()
    backend.presence_image = ("image/png", picture)
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    try:
        claim = await joined(backend, bridge)
        backend.recall(claim)
        await until(lambda: bridge.leaves)
        backend.unavailable.add(PRESENCE)
        backend.send(MEETING)
        await until(lambda: len(bridge.joins) == 2)
    finally:
        bot.stop()
        await asyncio.wait_for(task, 2)
    assert frame_path.read_bytes() == presence.i420_frame(io.BytesIO(picture))


async def test_the_operator_override_wins_and_nothing_is_fetched(backend, bridge, options_seen,
                                                                  frame_path):
    backend.presence_image = ("image/png", encoded())
    config = Config.from_env({"BWAT_BACKEND_URL": f"https://{backend.host}",
                              "BWAT_FLEET_CREDENTIAL": backend.fleet_credential,
                              "BWAT_BOT_PRESENCE_IMAGE": "/app/presence.png"})
    await attend(backend, bridge, config)
    assert presence_requests(backend) == []
    assert [o.presence_frame for o in options_seen] == [str(frame_path)]
    assert not frame_path.exists()  # rendered at start by __main__, not per join
