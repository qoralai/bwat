"""Polls GET /v1/bot/settings (backend/src/routes/bot-settings.ts) for what every bot applies.

The model keys come only because the bot asks for them in memory only: they live in this
process, never on disk and never in a repr or a log line.
"""
import time
from collections.abc import Callable

from bwat_bot.backend import BackendClient, Settings

__all__ = ["SETTINGS_SECONDS", "Settings", "SettingsPoller"]

SETTINGS_SECONDS = 30.0  # between reads; an unchanged answer is a 304


class SettingsPoller:
    def __init__(self, every: float = SETTINGS_SECONDS,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.current = Settings()
        self._every = every
        self._clock = clock
        self._etag: str | None = None
        self._due = float("-inf")

    async def refresh(self, backend: BackendClient) -> None:
        """Reads the settings once they are due. A read that fails raises (BackendError or
        httpx.RequestError), and a malformed answer raises BackendError(200,
        "malformed_settings"); either way the last good settings stay in place and the next
        read waits for the interval, so a failing route is not hit on every tick."""
        if self._clock() < self._due:
            return
        try:
            answer = await backend.settings(self._etag)
        finally:
            self._due = self._clock() + self._every
        if answer is not None:
            # No ETag on a partial key read, so the next read is in full.
            self.current, self._etag = answer
