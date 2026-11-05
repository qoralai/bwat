#!/usr/bin/env python3
"""The in-container bridge between the bot (bwat_bot.zoom_bridge) and the Zoom SDK app,
which is the headless sample patched by bot/sdk/bwat-sample.patch.

  bot, ws 127.0.0.1:8770        this bridge                     zoomsdk app
  ----------------------        --------------------------      ---------------------
  {"type":"join",...}       ->  write the config, spawn     ->  joins with the jwt
  <- audio_format, then PCM <-  /tmp/meeting.sock (the app  <-  raw audio delegate
                                serves it; we connect)
  <- sdk_status, participant <- tagged stdout lines         <-  BWAT_*_JSON
  {"type":"send_chat",...}  ->  BWAT_CHAT_SEND line         ->  posts it in the chat
  {"type":"leave"}          ->  SIGTERM the app (SIGKILL after KILL_SECONDS)

One connection is one meeting: the bridge closes it once the app has exited, so a closed
connection means the app is gone. With "per_participant" in the join, the socket carries
[u32 node LE][u32 len LE][pcm] frames (node 0 the mixed stream) and each binary message
to the bot is [u32 node LE][pcm].

bwat never speaks; it shows at most one still presence image (D195, D196). With "presence_frame"
in the join, and the camera not off, the app shows that I420 frame as the bot's video. The
app reads `presence-frame=` only since QOR-4846. The bridge and the app ship in one image
from one commit, and an older app ignores the key anyway (CLI11 skips unknown config
keys), so it would join with no picture rather than fail.

bwat never speaks, but it posts in the meeting chat (D125): each {"type":"send_chat"} goes
to the app's stdin as one `BWAT_CHAT_SEND {"text": ...}` line, and Zoom's answer comes back
as a chat_sent status line.

Ported from the prototype's bridge (docs/provenance.md), cut to what bwat uses: no
microphone, hands or rename, and the join JWT comes minted from the backend instead
of being signed here from the Zoom app's secret, which the bot never holds.
"""
import asyncio
import contextlib
import json
import os
import re
import signal
import sys
from pathlib import Path

import websockets
from websockets.asyncio.server import serve

HOST, PORT = "127.0.0.1", 8770  # loopback only: the bot is in the same container
CAPTURE_SOCK = "/tmp/meeting.sock"  # hardcoded in the sample's SocketServer
CAPTURE_RATE = 32000  # what the SDK delivers raw audio at
APP_BIN = "/app/build/zoomsdk"
CONFIG_PATH = "/tmp/bwat-zoom.toml"
READY = "/tmp/bwat-bridge.ready"  # the bot reports ready only while this exists
TAGS = {b"BWAT_MEETING_STATUS_JSON ": "sdk_status", b"BWAT_PARTICIPANT_JSON ": "participant",
        b"BWAT_CHAT_JSON ": "chat"}
FRAME_HEADER, MAX_FRAME = 8, 1 << 20  # a real chunk is ~10 ms; more means out of step
# How long the app gets to leave on SIGTERM before it is killed: well inside the bot's
# BRIDGE_CALL_SECONDS for a leave, past which the bot reads the bridge as stuck and restarts.
KILL_SECONDS = 5.0


def log(msg: str) -> None:
    """Event lines only: never a token, meeting number, name or passcode."""
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


def toml_safe(value, field: str) -> str:
    """A value for a quoted TOML string: a quote or backslash is escaped (an admin may
    name the bot `Acme "Notes"`); a control character is refused."""
    value = str(value)
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):  # TOML forbids DEL too
        raise ValueError(f"invalid character in {field}")
    return value.replace("\\", "\\\\").replace('"', '\\"')


def write_config(join: dict, path: str | None = None) -> None:
    """The app's config for one join: the pre-minted SDK JWT, never a client secret. It
    holds the join tokens, so only its owner may read it; run_app deletes it afterwards."""
    path = path or CONFIG_PATH
    lines = [
        f'jwt="{toml_safe(join["jwt"], "jwt")}"',
        f'meeting-id="{toml_safe(join["meeting_number"], "meeting_number")}"',
        f'password="{toml_safe(join.get("passcode") or "", "passcode")}"',
        f'display-name="{toml_safe(join.get("display_name") or "bwat", "display_name")}"',
    ]
    if join.get("join_token"):  # the local recording token: no host click needed
        lines.append(f'join-token="{toml_safe(join["join_token"], "join_token")}"')
    # Unmuted and camera on are the app's defaults: bwat never speaks, and shows its picture.
    if join.get("presence_frame"):
        lines.append(f'presence-frame="{toml_safe(join["presence_frame"], "presence_frame")}"')
    lines += ["", "[RawAudio]", 'file="meeting-audio.pcm"', "transcribe=true"]
    if join.get("per_participant"):
        lines.append("separate-participants=true")
    if os.path.exists(path):
        os.unlink(path)  # a mode is only set on creation
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as config:
        config.write("\n".join(lines) + "\n")


class CorruptFrame(Exception):
    pass


def take_frames(buf: bytearray) -> list[bytes]:
    """Every complete [u32 node][u32 len][pcm] frame in `buf`, each as [u32 node][pcm];
    a partial frame stays in `buf`."""
    out = []
    while len(buf) >= FRAME_HEADER:
        size = int.from_bytes(buf[4:8], "little")
        if size > MAX_FRAME:
            raise CorruptFrame(f"frame length {size}")
        if len(buf) < FRAME_HEADER + size:
            break
        out.append(bytes(buf[:4]) + bytes(buf[FRAME_HEADER:FRAME_HEADER + size]))
        del buf[:FRAME_HEADER + size]
    return out


async def relay_capture(ws, per_participant: bool) -> None:
    """Streams the app's capture socket to the bot. The app serves the socket only once
    raw recording starts, which can wait on the host, so this waits for it for the whole
    meeting, and reconnects if it closes and comes back."""
    first = True
    while True:
        try:
            reader, writer = await asyncio.open_unix_connection(CAPTURE_SOCK)
        except (FileNotFoundError, ConnectionRefusedError):
            await asyncio.sleep(1)
            continue
        log("capture socket connected")
        pending = bytearray()
        try:
            while chunk := await reader.read(65536):
                if first:
                    first = False
                    await ws.send(json.dumps({"type": "audio_format",
                                              "sample_rate": CAPTURE_RATE, "channels": 1,
                                              "per_participant": per_participant}))
                if not per_participant:
                    await ws.send(chunk)
                    continue
                pending += chunk
                try:
                    frames = take_frames(pending)
                except CorruptFrame as exc:
                    log(f"capture stream out of step ({exc}); reconnecting")
                    break
                for frame in frames:
                    await ws.send(frame)
        finally:
            writer.close()
        await asyncio.sleep(1)  # an instant-EOF stale socket must not spin


async def relay_status(ws, app) -> None:
    """The app's tagged lines to the bot; every other line to stderr."""
    while line := await app.stdout.readline():
        tag = next((t for t in TAGS if line.startswith(t)), None)
        if tag is None:
            sys.stderr.buffer.write(line)
            sys.stderr.flush()
            continue
        try:
            body = json.loads(line[len(tag):].decode("utf-8", "replace"))
            await ws.send(json.dumps({**body, "type": TAGS[tag]}))
        except (ValueError, TypeError) as exc:
            log(f"{TAGS[tag]} line dropped: {type(exc).__name__}")


# Names the SDK app is never handed: the bot's own settings, and anything that looks like
# a credential. Everything else (PATH, the Qt and PulseAudio settings) it may need.
SECRET_NAME = re.compile(r"^BWAT_|KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD", re.IGNORECASE)


def app_env() -> dict:
    """The SDK app's environment: the container's, without the bot's credentials or keys."""
    return {name: value for name, value in os.environ.items() if not SECRET_NAME.search(name)}


async def relay_chat(app, chats: asyncio.Queue) -> None:
    """The bot's chat posts to the app, one BWAT_CHAT_SEND line each on its stdin."""
    while True:
        text = await chats.get()
        app.stdin.write(b"BWAT_CHAT_SEND " + json.dumps({"text": text}).encode() + b"\n")
        await app.stdin.drain()


async def run_app(ws, join: dict, chats: asyncio.Queue) -> None:
    """One meeting: the app until it exits and its last status line is sent, then the
    connection closes. A join that cannot start closes it at once."""
    try:
        write_config(join)
        app = await asyncio.create_subprocess_exec(
            APP_BIN, "--config", CONFIG_PATH, cwd="/tmp", stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=sys.stderr, env=app_env())
    except (ValueError, KeyError, OSError) as exc:
        log(f"join not started: {type(exc).__name__}")
        await ws.close()
        return
    log(f"sdk app spawned (pid {app.pid})")
    capture = asyncio.create_task(relay_capture(ws, bool(join.get("per_participant"))))
    status = asyncio.create_task(relay_status(ws, app))
    chat = asyncio.create_task(relay_chat(app, chats))
    try:
        await app.wait()
        await status  # stdout to its end: the line that says why it exited
    finally:
        if app.returncode is None:
            app.send_signal(signal.SIGTERM)  # the sample leaves the meeting on SIGTERM
            try:
                await asyncio.wait_for(app.wait(), KILL_SECONDS)
            except TimeoutError:
                log("sdk app still running after SIGTERM; killing it")
                app.kill()
                await app.wait()
        log(f"sdk app exited ({app.returncode})")
        # The join tokens are spent: nothing of them stays on disk.
        with contextlib.suppress(FileNotFoundError):
            os.unlink(CONFIG_PATH)
        for relay in (capture, status, chat):
            relay.cancel()
        await asyncio.gather(capture, status, chat, return_exceptions=True)
        await ws.close()


async def handle(ws) -> None:
    meeting = None
    chats: asyncio.Queue[str] = asyncio.Queue()
    try:
        async for frame in ws:
            try:
                msg = json.loads(frame)
            except (TypeError, ValueError):
                continue
            if msg.get("type") == "join" and meeting is None:
                meeting = asyncio.create_task(run_app(ws, msg, chats))
            elif msg.get("type") == "send_chat" and isinstance(msg.get("text"), str):
                chats.put_nowait(msg["text"])
            elif msg.get("type") == "leave":
                break
    except websockets.ConnectionClosed:
        pass
    if meeting is not None:
        meeting.cancel()  # SIGTERMs the app, waits for it, then closes the connection
        await asyncio.gather(meeting, return_exceptions=True)


async def main() -> None:
    async with serve(handle, HOST, PORT, max_size=None, compression=None):
        Path(READY).touch()
        await asyncio.Future()


if __name__ == "__main__":
    for stale in (CAPTURE_SOCK, READY):
        if os.path.exists(stale):
            os.unlink(stale)
    asyncio.run(main())
