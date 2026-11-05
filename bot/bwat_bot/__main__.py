"""`python -m bwat_bot`: one bot process, one meeting at a time.

BWAT_BRIDGE=zoom joins meetings through the Zoom SDK app in the same container (the image's
zoom stage). BWAT_BRIDGE=fake, only on a local stack (BWAT_LOCAL_STACK=1), joins nothing, so
the lifecycle can be tested end to end against a real backend; BWAT_FAKE_AUDIO names a WAV
file (mono, 16-bit) it plays as the meeting's audio.
"""
import asyncio
import dataclasses
import json
import logging
import os
import signal
import sys
from collections.abc import Mapping
from pathlib import Path

from bwat_bot import ecs, presence
from bwat_bot.bridge import Bridge
from bwat_bot.config import Config, ConfigError
from bwat_bot.fake_bridge import FakeBridge
from bwat_bot.feed import FeedServer
from bwat_bot.lifecycle import Bot
from bwat_bot.settings import SettingsPoller
from bwat_bot.transcription import Transcriber
from bwat_bot.zoom_bridge import ZoomBridge

# The only record fields a log line may carry besides its event name: ids and machine codes.
LOGGED_FIELDS = ("bot_id", "claim_id", "reason", "error", "count")


class EventFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line = {"level": record.levelname, "event": record.msg}
        line.update({k: getattr(record, k) for k in LOGGED_FIELDS if hasattr(record, k)})
        return json.dumps(line)


EXIT_BRIDGE_STUCK = 3  # a leave was never confirmed: restart the process and its bridge
EXIT_CREDENTIAL_REJECTED = 4  # the fleet credential was refused: an operator must fix it


def choose_bridge(env: Mapping[str, str], config: Config) -> Bridge | None:
    """The bridge BWAT_BRIDGE names, or None when it may not run here."""
    if env.get("BWAT_BRIDGE") == "zoom":
        return ZoomBridge()
    if env.get("BWAT_BRIDGE") == "fake" and config.local_stack:
        audio = env.get("BWAT_FAKE_AUDIO")
        return FakeBridge(auto_join=True, audio=Path(audio) if audio else None)
    return None


async def serve(config: Config, bridge: Bridge) -> int:
    settings = SettingsPoller()
    transcriber = Transcriber(config, keys=lambda: settings.current.provider_keys)
    feed = FeedServer(config.feed_port)
    await feed.start()
    bot = Bot(config, bridge, settings=settings,
              transcription_ready=transcriber.ready, transcribe=transcriber.transcribe,
              transcription_error=lambda: transcriber.error,
              clear_transcription_error=transcriber.clear_error,
              feed=feed)
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, bot.stop)
    loop.add_signal_handler(signal.SIGINT, bot.stop)
    try:
        await bot.run()
    finally:
        await transcriber.aclose()
        await feed.aclose()
    if bot.credential_rejected:
        return EXIT_CREDENTIAL_REJECTED
    return EXIT_BRIDGE_STUCK if bot.bridge_stuck else 0


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(EventFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    # The HTTP libraries log each request's URL, and a transcript push's URL names the
    # occurrence (Track 3): keep them to warnings, which carry no URL.
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


def main() -> int:
    configure_logging()
    log = logging.getLogger("bwat_bot")
    try:
        config = Config.from_env(os.environ)
    except ConfigError as exc:
        log.error("bot.config_invalid", extra={"error": str(exc)})
        return 2
    if config.presence_image:
        # The picture is cosmetic: a bad one is logged and the bot joins with no picture.
        try:
            presence.write_frame(config.presence_image, presence.FRAME_PATH)
        except (OSError, ValueError) as exc:
            log.error("bot.presence_image_invalid", extra={"error": str(exc)})
            config = dataclasses.replace(config, presence_image=None)
    config = dataclasses.replace(config, task_arn=ecs.task_arn(os.environ))
    if os.environ.get("ECS_CONTAINER_METADATA_URI_V4") and not config.task_arn:
        # The fleet cannot protect this task, so no scale-in happens while it runs.
        log.error("bot.task_arn_unknown")
    bridge = choose_bridge(os.environ, config)
    if bridge is None:
        log.error("bot.no_bridge",
                  extra={"error": "BWAT_BRIDGE=zoom, or BWAT_BRIDGE=fake on a local stack"})
        return 2
    return asyncio.run(serve(config, bridge))


if __name__ == "__main__":
    sys.exit(main())
