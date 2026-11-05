"""Acceptance: a person sends bwat to a meeting, and the bot joins it (T012 bot slice, T067)."""
from bwat_bot.bridge import Joined
from tests.conftest import MEETING, PASSCODE, until


async def test_sent_meeting_is_joined_through_the_backend_only(running, backend, bridge):
    await until(lambda: backend.ready)  # registered with the fleet credential, then ready
    backend.send(MEETING, PASSCODE)

    await until(lambda: bridge.joins)
    assert bridge.joins == [(MEETING, PASSCODE)]

    bridge.emit(Joined())
    await until(lambda: any(h.get("joined") for h in backend.heartbeats))

    assert {r.host for r in backend.requests} == {backend.host}
    assert all(r.path.startswith("/v1/") for r in backend.requests)
