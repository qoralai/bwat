"""The bot's own ECS task ARN (QOR-4888): read once from the task metadata endpoint ECS
names, and sent on register so the backend can protect that task while it is in a meeting."""
import asyncio
import dataclasses
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from bwat_bot import ecs
from tests.conftest import calls, make_bot, until

ARN = "arn:aws:ecs:us-west-2:123456789012:task/bwat/0123456789abcdef0123456789abcdef"


@pytest.fixture
def metadata():
    """A stand-in for the task metadata endpoint: GET <uri>/task answers the task."""
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/v4/abc/task":
                self.send_error(404)
                return
            body = json.dumps({"TaskARN": ARN, "Cluster": "bwat"}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/v4/abc"
    server.shutdown()


def test_reads_the_task_arn_from_the_metadata_endpoint(metadata):
    assert ecs.task_arn({"ECS_CONTAINER_METADATA_URI_V4": metadata}) == ARN


def test_no_metadata_endpoint_means_not_on_ecs():
    assert ecs.task_arn({}) is None


def test_an_endpoint_that_does_not_answer_gives_no_arn(metadata):
    assert ecs.task_arn({"ECS_CONTAINER_METADATA_URI_V4": metadata + "/missing"}) is None


async def test_register_sends_the_task_arn(backend, bridge, config):
    bot = make_bot(backend, bridge, dataclasses.replace(config, task_arn=ARN))
    task = asyncio.create_task(bot.run())
    await until(lambda: calls(backend, "/v1/bots/register") == 1)
    bot.stop()
    await asyncio.wait_for(task, 2)
    register = next(r for r in backend.requests if r.path == "/v1/bots/register")
    assert register.body["task_arn"] == ARN


async def test_register_sends_no_task_arn_off_ecs(running, backend):
    await until(lambda: calls(backend, "/v1/bots/register") == 1)
    register = next(r for r in backend.requests if r.path == "/v1/bots/register")
    assert "task_arn" not in register.body


@pytest.fixture
def started(monkeypatch):
    """main() up to serve(): the config it would serve with."""
    from bwat_bot import __main__ as entry
    seen = {}

    async def serve(config, bridge):
        seen["config"] = config
        return 0

    monkeypatch.setenv("BWAT_BACKEND_URL", "https://backend.test")
    monkeypatch.setenv("BWAT_FLEET_CREDENTIAL", "bwf_" + "a" * 43)
    monkeypatch.setattr(entry, "choose_bridge", lambda env, config: object())
    monkeypatch.setattr(entry, "serve", serve)
    return entry.main, seen


def test_main_serves_with_the_task_arn(started, metadata, monkeypatch):
    main, seen = started
    monkeypatch.setenv("ECS_CONTAINER_METADATA_URI_V4", metadata)
    assert main() == 0
    assert seen["config"].task_arn == ARN


def test_main_says_when_it_is_on_ecs_but_has_no_arn(started, metadata, monkeypatch, capsys):
    main, seen = started
    monkeypatch.setenv("ECS_CONTAINER_METADATA_URI_V4", metadata + "/missing")
    assert main() == 0
    assert seen["config"].task_arn is None
    assert "bot.task_arn_unknown" in capsys.readouterr().out
