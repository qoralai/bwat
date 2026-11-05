import asyncio

import pytest

from bwat_bot import presence
from bwat_bot.config import Config
from bwat_bot.fake_bridge import FakeBridge
from bwat_bot.lifecycle import Bot
from tests.fake_backend import FakeBackend

MEETING = "84912345678"
PASSCODE = "s3cretPass"


class Clock:
    """A monotonic clock a test moves by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def until(predicate, timeout: float = 2.0) -> None:
    """Waits for a condition the bot reaches asynchronously, or fails the test."""
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.005)


def calls(backend: FakeBackend, path: str) -> int:
    """How many requests the bot sent to `path`."""
    return len([r for r in backend.requests if r.path == path])


async def joined(backend: FakeBackend, bridge: FakeBridge, scheduled_end: str | None = None):
    """Waits for the bot to be ready, sends it to a meeting, and waits for the join."""
    await until(lambda: backend.ready)
    claim = backend.send(MEETING, PASSCODE, scheduled_end=scheduled_end)
    await until(lambda: bridge.joins)
    return claim


@pytest.fixture(autouse=True)
def frame_path(monkeypatch, tmp_path_factory):
    """Where this test's presence frame is written: never the container's /tmp, and not
    the test's own tmp_path, which test_legal checks stays empty (the frame is the logo or
    the admin's picture, never meeting content)."""
    path = tmp_path_factory.mktemp("presence") / "presence.i420"
    monkeypatch.setattr(presence, "FRAME_PATH", str(path))
    return path


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend()


@pytest.fixture
def bridge(backend: FakeBackend) -> FakeBridge:
    return FakeBridge(timeline=backend.timeline)


@pytest.fixture
def config(backend: FakeBackend) -> Config:
    return Config.from_env(
        {
            "BWAT_BACKEND_URL": f"https://{backend.host}",
            "BWAT_FLEET_CREDENTIAL": backend.fleet_credential,
        }
    )


async def always_ready() -> bool:
    return True


def make_bot(backend: FakeBackend, bridge: FakeBridge, config: Config, **options) -> Bot:
    options = {"transcription_ready": always_ready, "tick_seconds": 0.01,
               "heartbeat_seconds": 0.02, **options}
    return Bot(config, bridge, inner_transport=backend.transport(), **options)


@pytest.fixture
async def running(backend: FakeBackend, bridge: FakeBridge, config: Config):
    """A bot running against the fake backend, stopped (as by SIGTERM) after the test."""
    bot = make_bot(backend, bridge, config)
    task = asyncio.create_task(bot.run())
    yield bot
    bot.stop()
    await asyncio.wait_for(task, 2)
