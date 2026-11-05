"""Acceptance: what the bot posts in the meeting chat (D125). It never speaks.

On joining, once, the agenda: the card service's summary of what is still open from the
meeting's previous occurrence, or the hello when nothing is (QOR-4966). With a scheduled end
on the claim, five minutes before it the warning with the open questions nobody owns, and at
the end a bare alarm clock. A reconnect posts none of them again. The admin's chat posts
setting off, none of them goes out; the agenda setting off, nothing on joining.
"""
import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from bwat_bot.bridge import Ended, Joined, OccurrenceKnown, Removed
from bwat_bot.settings import SettingsPoller
from tests.conftest import Clock, joined, make_bot, until

OCCURRENCE = "occ-chat-1"
AGENDA = [{"display_id": "A12", "title": "Ship the release", "kind": "todo"},
          {"display_id": "Q4", "title": "Who reviews the migration?", "kind": "question"}]
HELLO = "bwat is here and taking notes. Nothing carried over from last time."
QUESTIONS = [{"display_id": "Q9", "title": "Which region first?"}]
SUMMARY = "Open from last time: the release still has to ship, and nobody owns the migration review."


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture(autouse=True)
def chat_posts_on(backend):
    """The chat posts are off by default; every test here starts with them on."""
    backend.settings_values = {"chat_posts_enabled": True, "chat_agenda_enabled": True}


@pytest.fixture
async def running(backend, bridge, config):
    """The shared running bot, but reading the served settings, so the chat posts are on."""
    bot = make_bot(backend, bridge, config, settings=SettingsPoller(every=0.01))
    task = asyncio.create_task(bot.run())
    yield bot
    bot.stop()
    await asyncio.wait_for(task, 2)


@pytest.fixture
def served() -> dict:
    """The settings a test serves, besides the idle leave below; none by default."""
    return {}


@pytest.fixture
async def bot(backend, bridge, config, clock, served):
    # A lease far longer than the test moves the clock, so moving it never lapses the claim,
    # and the longest idle leave: these meetings say nothing.
    backend.settings_values = {**backend.settings_values, "idle_leave_min": 120, **served}
    bot = make_bot(backend, bridge, config, clock=clock, lease_seconds=10_000,
                   settings=SettingsPoller(every=0.01))
    task = asyncio.create_task(bot.run())
    yield bot
    bot.stop()
    await asyncio.wait_for(task, 2)


async def in_meeting(backend, bridge, ends_in: float | None):
    end = None if ends_in is None else (datetime.now(UTC) + timedelta(seconds=ends_in)).isoformat()
    await joined(backend, bridge, end)
    bridge.emit(Joined())
    await until(lambda: asked(backend, "agenda"))  # the posts are armed


def asked(backend, kind: str) -> bool:
    return any(r.path == "/v1/assignment/chat-cards" and r.body["list"] == kind for r in backend.requests)


async def at(clock: Clock, bridge, seconds: float, posts: int) -> None:
    """Moves the clock to `seconds` after the join and waits for the bot's `posts`th post."""
    clock.now = 1000.0 + seconds
    await until(lambda: len(bridge.chats) >= posts)


async def test_the_agenda_on_joining_then_the_warning_then_time_up(bot, backend, bridge, clock):
    backend.chat_cards = {"agenda": AGENDA, "questions": QUESTIONS}
    backend.agenda_summary = SUMMARY
    await in_meeting(backend, bridge, ends_in=600)
    await until(lambda: bridge.chats)
    assert bridge.chats == [SUMMARY]

    await at(clock, bridge, 290, 1)
    await asyncio.sleep(0.05)
    assert len(bridge.chats) == 1  # not yet five minutes out
    await at(clock, bridge, 301, 2)
    assert bridge.chats[1] == "Five minutes left.\nOpen questions with no owner:\nQ9 Which region first?"
    await at(clock, bridge, 595, 2)
    await asyncio.sleep(0.05)
    assert len(bridge.chats) == 2  # not yet the end
    await at(clock, bridge, 601, 3)
    assert bridge.chats[2] == "⏰"


@pytest.mark.parametrize("served", [{"chat_posts_enabled": True}])
async def test_chat_posts_on_posts_the_hello_the_warning_and_time_up(bot, backend, bridge, clock):
    await in_meeting(backend, bridge, ends_in=600)
    await at(clock, bridge, 301, 2)
    await at(clock, bridge, 601, 3)
    assert bridge.chats == [HELLO, "Five minutes left.", "⏰"]


@pytest.mark.parametrize("served", [{"chat_posts_enabled": False}])
async def test_chat_posts_off_posts_nothing(bot, backend, bridge, clock):
    await joined(backend, bridge, (datetime.now(UTC) + timedelta(seconds=600)).isoformat())
    beats = len(backend.heartbeats)
    bridge.emit(Joined())
    await until(lambda: len(backend.heartbeats) > beats)  # the join's beat, then the arming
    await asyncio.sleep(0.05)
    for seconds in (301, 601):  # past the warning, then the end
        clock.now = 1000.0 + seconds
        await asyncio.sleep(0.1)
    assert bridge.chats == []
    assert not asked(backend, "agenda")


@pytest.mark.parametrize("served", [{"chat_agenda_enabled": False}])
async def test_the_agenda_off_posts_nothing_on_joining_but_the_warning_and_time_up(bot, backend, bridge, clock):
    backend.chat_cards = {"agenda": AGENDA}
    backend.agenda_summary = SUMMARY
    await joined(backend, bridge, (datetime.now(UTC) + timedelta(seconds=600)).isoformat())
    beats = len(backend.heartbeats)
    bridge.emit(Joined())
    await until(lambda: len(backend.heartbeats) > beats)  # the join's beat, then the arming
    await at(clock, bridge, 301, 1)
    await at(clock, bridge, 601, 2)
    assert bridge.chats == ["Five minutes left.", "⏰"]
    assert not asked(backend, "agenda")


async def test_an_agenda_with_no_summary_posts_the_count_of_each_kind(bot, backend, bridge):
    """The card writer's model could not say, or a card service from before the summary."""
    backend.chat_cards = {"agenda": AGENDA + [{"display_id": "Q5", "title": "Which region?", "kind": "question"},
                                              {"display_id": "D2", "title": "Ship on Fridays", "kind": "decision"}]}
    await in_meeting(backend, bridge, ends_in=None)
    await until(lambda: bridge.chats)
    assert bridge.chats == ["Open from last time: 1 to-do, 2 questions, 1 decision."]


async def test_a_reconnect_posts_nothing_again(bot, backend, bridge, clock):
    backend.chat_cards = {"agenda": AGENDA}
    backend.agenda_summary = SUMMARY
    await in_meeting(backend, bridge, ends_in=600)
    await at(clock, bridge, 301, 2)
    bridge.emit(Joined())  # Zoom reconnected the bot
    await at(clock, bridge, 601, 3)
    bridge.emit(Joined())
    clock.now = 2000.0
    await asyncio.sleep(0.1)
    assert bridge.chats[1:] == ["Five minutes left.", "⏰"]


async def test_nothing_carried_over_posts_a_hello_and_no_scheduled_end_nothing_timed(bot, backend, bridge,
                                                                                   clock):
    await in_meeting(backend, bridge, ends_in=None)
    clock.now = 100_000.0
    await asyncio.sleep(0.1)
    assert bridge.chats == [HELLO]


async def test_a_card_service_it_cannot_reach_means_no_hello_and_a_bare_warning(bot, backend, bridge, clock):
    backend.unavailable.add("/v1/assignment/chat-cards")
    await in_meeting(backend, bridge, ends_in=600)
    await at(clock, bridge, 301, 1)
    assert bridge.chats == ["Five minutes left."]


async def test_a_join_inside_the_last_five_minutes_posts_no_warning(bot, backend, bridge, clock):
    await in_meeting(backend, bridge, ends_in=200)
    await at(clock, bridge, 201, 2)
    assert bridge.chats == [HELLO, "⏰"]


async def test_a_long_list_is_cut_to_one_post_and_says_how_many_more(bot, backend, bridge, clock):
    backend.chat_cards = {"questions": [{"display_id": f"Q{n}", "title": "x" * 95} for n in range(30)]}
    await in_meeting(backend, bridge, ends_in=600)
    await at(clock, bridge, 301, 2)
    post = bridge.chats[1]
    lines = post.split("\n")
    assert len(post) <= 1100
    assert lines[-1] == f"and {30 - (len(lines) - 3)} more on the board"  # less the first line, heading and this


async def test_the_agenda_waits_past_the_card_writers_model(bot, backend, bridge):
    """The card service asks the model for the summary with a budget of its own, and the
    backend waits past it (QOR-4966): the bot waits longer than for any other call."""
    backend.chat_cards = {"agenda": AGENDA}
    backend.agenda_summary = SUMMARY
    backend.delays["/v1/assignment/chat-cards"] = 11
    await in_meeting(backend, bridge, ends_in=None)
    await until(lambda: bridge.chats, timeout=15)
    assert bridge.chats == [SUMMARY]
    (asked_for,) = [r for r in backend.requests if r.path == "/v1/assignment/chat-cards"]
    assert asked_for.read_timeout == 25  # httpx's per-phase wait too, not only the call's


async def test_a_slow_chat_post_never_holds_up_the_heartbeat(running, backend, bridge):
    # The card service hangs on every list: the agenda's fetch on joining, then the
    # warning's, due a moment later. The lease and the transcript must not wait on either.
    backend.delays["/v1/assignment/chat-cards"] = 5
    await joined(backend, bridge, (datetime.now(UTC) + timedelta(seconds=300.3)).isoformat())
    bridge.emit(Joined())
    await until(lambda: asked(backend, "questions"))
    beats = len(backend.heartbeats)
    await until(lambda: len(backend.heartbeats) >= beats + 3)


async def warning_being_fetched(backend, bridge):
    """In a meeting whose warning is due at once, with the card service slow to answer:
    returns once the warning's fetch is under way."""
    backend.delays["/v1/assignment/chat-cards"] = 0.3
    claim = await joined(backend, bridge, (datetime.now(UTC) + timedelta(seconds=300.1)).isoformat())
    bridge.emit(Joined())
    bridge.emit(OccurrenceKnown(OCCURRENCE))
    await until(lambda: claim.occurrence_uuid == OCCURRENCE and asked(backend, "questions"))
    return claim


async def test_a_claim_lost_while_the_warning_is_fetched_posts_nothing(running, backend, bridge):
    claim = await warning_being_fetched(backend, bridge)
    backend.delays["/v1/assignment/heartbeat"] = 1.0  # the bot learns of the loss late
    backend.recall(claim)  # the fetch is answered 409 stale_claim before then
    await until(lambda: bridge.leaves == 1, timeout=3)
    assert bridge.chats == []


@pytest.mark.parametrize("event", [Ended(), Removed()])
async def test_nothing_is_posted_once_the_bot_sets_out_to_leave(running, backend, bridge, event):
    await warning_being_fetched(backend, bridge)
    # Leaving outlasts the fetch: the final push after the meeting's end, and the release.
    backend.delays[f"/v1/meetings/{OCCURRENCE}/transcript"] = 1.0
    backend.delays["/v1/assignment/release"] = 1.0
    bridge.emit(event)
    await until(lambda: backend.releases, timeout=4)
    assert bridge.chats == []
