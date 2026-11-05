"""The in-container bridge's config for a join (bot/container/bridge.py)."""
import asyncio
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

_spec = importlib.util.spec_from_file_location(
    "container_bridge", Path(__file__).parent.parent / "container" / "bridge.py")
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

JOIN = {"type": "join", "meeting_number": "84912345678", "passcode": "s3cret",
        "display_name": "bwat", "jwt": "eyJ.sdk.jwt", "join_token": "rec-token"}


def test_a_join_writes_the_minted_jwt_and_no_client_secret(tmp_path):
    path = tmp_path / "config.toml"
    bridge.write_config(JOIN, str(path))
    config = path.read_text(encoding="utf-8")
    assert config == ('jwt="eyJ.sdk.jwt"\nmeeting-id="84912345678"\npassword="s3cret"\n'
                      'display-name="bwat"\njoin-token="rec-token"\n\n[RawAudio]\n'
                      'file="meeting-audio.pcm"\ntranscribe=true\n')
    assert "client-secret" not in config and "client-id" not in config


def test_the_join_options_are_written(tmp_path):
    # bwat joins unmuted with its picture as its video: the app's defaults, so neither
    # join-muted nor video-off is written.
    path = tmp_path / "config.toml"
    bridge.write_config({**JOIN, "per_participant": True, "presence_frame": "/tmp/bwat-presence.i420"},
                        str(path))
    config = path.read_text(encoding="utf-8")
    assert "join-muted" not in config and "video-off" not in config
    assert 'join-token="rec-token"\npresence-frame="/tmp/bwat-presence.i420"\n' in config
    assert config.endswith("transcribe=true\nseparate-participants=true\n")


def test_frames_are_reassembled_across_reads():
    def framed(node: int, pcm: bytes) -> bytes:
        return node.to_bytes(4, "little") + len(pcm).to_bytes(4, "little") + pcm

    stream = framed(0, b"mixed!") + framed(16778240, b"ada")
    buf = bytearray(stream[:10])
    assert bridge.take_frames(buf) == []
    buf += stream[10:]
    assert bridge.take_frames(buf) == [(0).to_bytes(4, "little") + b"mixed!",
                                       (16778240).to_bytes(4, "little") + b"ada"]
    assert buf == bytearray()


def test_a_frame_too_long_to_be_real_means_the_stream_is_out_of_step():
    with pytest.raises(bridge.CorruptFrame):
        bridge.take_frames(bytearray(b"\0\0\0\0" + (1 << 21).to_bytes(4, "little")))


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes; the bridge runs on Linux")
def test_the_config_holding_the_join_tokens_is_readable_by_its_owner_only(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text("old", encoding="utf-8")
    os.chmod(path, 0o644)
    bridge.write_config(JOIN, str(path))
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_without_a_recording_token_none_is_written(tmp_path):
    path = tmp_path / "config.toml"
    bridge.write_config({**JOIN, "join_token": None}, str(path))
    assert "join-token" not in path.read_text(encoding="utf-8")


def test_a_name_with_quotes_and_backslashes_reaches_the_app_as_written(tmp_path):
    import tomllib

    name = 'Acme "Notes" \\ bot'  # an admin may name the bot this (D166)
    path = tmp_path / "config.toml"
    bridge.write_config({**JOIN, "display_name": name, "passcode": 'p"w'}, str(path))
    config = tomllib.loads(path.read_text(encoding="utf-8"))
    assert config["display-name"] == name and config["password"] == 'p"w'


def test_a_control_character_is_refused(tmp_path):
    with pytest.raises(ValueError):
        bridge.write_config({**JOIN, "passcode": "a\nb"}, str(tmp_path / "config.toml"))


spawned: list[dict] = []  # each fake app's environment


async def serving(monkeypatch, tmp_path, app_script: str):
    """The bridge's handler on a free port, its SDK app replaced by a Python one-liner."""
    real = asyncio.create_subprocess_exec

    async def fake_app(*_args, **kwargs):
        kwargs.pop("cwd", None)
        # What the app would see: the env given, or else everything this process has.
        spawned.append(dict(kwargs["env"]) if kwargs.get("env") is not None else dict(os.environ))
        return await real(sys.executable, "-c", app_script, **kwargs)

    monkeypatch.setattr(bridge.asyncio, "create_subprocess_exec", fake_app)
    monkeypatch.setattr(bridge, "CONFIG_PATH", str(tmp_path / "config.toml"))
    monkeypatch.setattr(bridge, "CAPTURE_SOCK", str(tmp_path / "no.sock"))
    server = await serve(bridge.handle, "127.0.0.1", 0)
    return server, f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"


async def received(url: str, join: dict) -> list:
    async with connect(url) as ws:
        await ws.send(json.dumps(join))
        return [json.loads(m) async for m in ws]  # until the bridge closes


async def test_the_apps_last_status_reaches_the_bot_before_the_close(monkeypatch, tmp_path):
    # Log lines first, so the status line is still in the pipe when the app has exited.
    server, url = await serving(monkeypatch, tmp_path, (
        "import sys; sys.stdout.write(('x' * 99 + '\\n') * 4000); "
        "print('BWAT_MEETING_STATUS_JSON {\"event\":\"auth\",\"code\":2}', flush=True)"))
    try:
        messages = await asyncio.wait_for(received(url, JOIN), 10)
    finally:
        server.close()
    assert messages == [{"event": "auth", "code": 2, "type": "sdk_status"}]


async def test_a_join_that_cannot_start_closes_the_connection(monkeypatch, tmp_path):
    server, url = await serving(monkeypatch, tmp_path, "pass")
    try:
        messages = await asyncio.wait_for(received(url, {**JOIN, "passcode": 'a"b'}), 10)
    finally:
        server.close()
    assert messages == []


async def test_a_chat_line_reaches_the_bot(monkeypatch, tmp_path):
    server, url = await serving(monkeypatch, tmp_path, (
        "print('BWAT_CHAT_JSON {\"from\":\"Ada\",\"text\":\"hi\"}', flush=True)"))
    try:
        messages = await asyncio.wait_for(received(url, JOIN), 10)
    finally:
        server.close()
    assert messages == [{"from": "Ada", "text": "hi", "type": "chat"}]


async def test_the_join_tokens_are_deleted_once_the_app_has_exited(monkeypatch, tmp_path):
    server, url = await serving(monkeypatch, tmp_path, "pass")
    try:
        await asyncio.wait_for(received(url, JOIN), 10)
    finally:
        server.close()
    assert not (tmp_path / "config.toml").exists()


def test_the_sdk_app_gets_no_bwat_setting_and_no_secret(monkeypatch):
    # The SDK app is a closed binary: it needs nothing of the bot's credentials or keys.
    for name, value in {"BWAT_FLEET_CREDENTIAL": "bwf_x", "BWAT_BACKEND_URL": "http://backend",
                        "OPENROUTER_API_KEY": "sk-x", "SOME_TOKEN": "t", "DB_PASSWORD": "p",
                        "QT_LOGGING_RULES": "*.debug=false", "PATH": "/usr/bin"}.items():
        monkeypatch.setenv(name, value)
    env = bridge.app_env()
    assert env["QT_LOGGING_RULES"] == "*.debug=false"
    assert env["PATH"] == "/usr/bin"
    for gone in ("BWAT_FLEET_CREDENTIAL", "BWAT_BACKEND_URL", "OPENROUTER_API_KEY", "SOME_TOKEN", "DB_PASSWORD"):
        assert gone not in env


async def test_the_sdk_app_is_started_without_the_bots_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("BWAT_FLEET_CREDENTIAL", "bwf_x")
    spawned.clear()
    server, url = await serving(monkeypatch, tmp_path, "pass")
    try:
        await asyncio.wait_for(received(url, JOIN), 10)
    finally:
        server.close()
    assert spawned and "BWAT_FLEET_CREDENTIAL" not in spawned[0]


async def test_a_chat_post_reaches_the_app_as_one_line_on_its_stdin(monkeypatch, tmp_path):
    # The app echoes the first line it reads back as a status line.
    server, url = await serving(monkeypatch, tmp_path, (
        "import json, sys; line = sys.stdin.readline(); "
        "print('BWAT_MEETING_STATUS_JSON ' + json.dumps({'event': 'echo', 'line': line}), flush=True)"))
    try:
        async with connect(url) as ws:
            await ws.send(json.dumps(JOIN))
            await ws.send(json.dumps({"type": "send_chat", "text": "Five minutes left.\nQ9 Which region?"}))
            messages = await asyncio.wait_for(_until_closed(ws), 10)
    finally:
        server.close()
    ((echo),) = messages
    tag, _, body = echo["line"].partition(" ")
    assert tag == "BWAT_CHAT_SEND" and body.endswith("\n") and body.count("\n") == 1
    assert json.loads(body) == {"text": "Five minutes left.\nQ9 Which region?"}


async def _until_closed(ws) -> list:
    return [json.loads(m) async for m in ws]


async def test_an_app_that_ignores_sigterm_is_killed_so_the_leave_completes(monkeypatch, tmp_path):
    # QOR-5113: the bot waits BRIDGE_CALL_SECONDS for a leave; an app stuck leaving must not
    # outlast it, or the bot reads the bridge as stuck and restarts.
    monkeypatch.setattr(bridge, "KILL_SECONDS", 0.2)
    server, url = await serving(monkeypatch, tmp_path, (
        "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "print('BWAT_MEETING_STATUS_JSON {\"event\":\"up\"}', flush=True); time.sleep(60)"))
    try:
        async with connect(url) as ws:
            await ws.send(json.dumps(JOIN))
            assert json.loads(await asyncio.wait_for(ws.recv(), 10))["event"] == "up"
            await ws.send(json.dumps({"type": "leave"}))
            await asyncio.wait_for(ws.wait_closed(), 5)
    finally:
        server.close()
