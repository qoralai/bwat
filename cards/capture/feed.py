"""Live capture from each bot's feed (slice C3c, QOR-4679; D80, D171, D178).

Every FLEET_S seconds capture reads GET /v1/fleet under the card service's credential and
dials each bot whose row carries a feed address that passes the host guard. The upgrade
carries a fresh nonce and a proof bound to the bot's feed token, claim and generation; no
redirect is followed. Every message is an envelope whose MAC (under the per-connection
key K) and counter are checked before its frame is read; any failure closes the socket.
The first frame, hello, must match the /fleet row (one re-read of /fleet, then 1008).

The feed is the latency layer over the stored read, not a second source of truth: on
every bind the stored transcript is read before any live frame is filed, so a live line
never lands ahead of older stored ones the writer has not seen, and every close ends with
one more stored read. The feed only carries what the backend has stored, so nothing is
lost while it is down. After a close the bot is dialled again on the next /fleet read.
No backoff, gap frames or stalled state (D178).
"""

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets

import psycopg
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

FLEET_S = 5
ALLOW_LOOPBACK = False  # the tests' fake bot binds to 127.0.0.1; production never does
HELLO_FIELDS = ("bot_id", "claim_id", "generation", "occurrence_id", "transcript_epoch")
POLICY_VIOLATION = 1008

log = logging.getLogger("cards.feed")


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _mac(key, text):
    return hmac.new(key, text.encode(), hashlib.sha256).digest()


def new_nonce():
    return b64(secrets.token_bytes(32))


def proof(token, claim_id, generation, nonce):
    """The upgrade's Authorization value after "Bwat-Feed "."""
    return b64(_mac(token.encode(), f"capture|{claim_id}|{generation}|{nonce}"))


def session_key(token, claim_id, generation, nonce):
    return _mac(token.encode(), f"session|{claim_id}|{generation}|{nonce}")


def frame_mac(key, c, f):
    return b64(_mac(key, f"{c}.{f}"))


# Ported from an earlier prototype's capture service (docs/provenance.md), with its v6
# branches replaced by refusing v6: the feed dials IPv4 only (D165).
def dialable(addr):
    """May the shared operator token be sent to this address? IPv4 only: a v6 one, a v4 one
    inside it included (::ffff:169.254.169.254 is the metadata service), never."""
    if addr.version != 4:
        return False
    if not addr.is_private or addr.is_multicast or addr.is_reserved or addr.is_unspecified:
        return False
    if addr.is_link_local:      # 169.254.169.254 is the EC2 metadata service
        return False
    if addr.is_loopback:        # dialling ourselves, or whatever else is local
        return ALLOW_LOOPBACK
    return True


class _NoRedirects(connect):
    def process_redirect(self, exc):
        return exc


class _Broken(Exception):
    """A message that fails its MAC or counter, or a hello that does not match /fleet."""


def feedable(row):
    try:
        host = ipaddress.ip_address(row.get("feed_host") or "")
    except ValueError:
        return False
    port = row.get("feed_port")
    return (
        bool(row.get("feed_token") and row.get("claim_id") and row.get("occurrence_id"))
        and type(row.get("generation")) is int
        and type(port) is int
        and 0 < port < 65536
        # Our bots report their task's private IPv4 address (D165).
        and host.version == 4
        and dialable(host)
    )


class FeedCapture:
    def __init__(self, dsn, backend, stored, buffer):
        self._dsn = dsn
        self._backend = backend
        self._stored = stored
        self._buffer = buffer
        self._following = {}

    def fleet(self):
        """The /fleet rows capture can dial."""
        response = self._backend.get("/v1/fleet")
        response.raise_for_status()
        return [row for row in response.json()["fleet"] if feedable(row)]

    def meeting_for(self, occurrence):
        with psycopg.connect(self._dsn) as conn:
            row = conn.execute(
                "SELECT meeting_id::text FROM bwat.v_cards_occurrences WHERE occurrence_uuid = %s", [occurrence]
            ).fetchone()
        return row and row[0]

    def run(self, stop):
        """Follows the fleet until `stop` (a threading.Event) is set; its own thread and loop."""
        asyncio.run(self._run(stop))

    async def _run(self, stop):
        while not stop.is_set():
            try:
                for row in await asyncio.to_thread(self.fleet):
                    key = (row["claim_id"], row.get("generation"))
                    if key not in self._following:
                        self._following[key] = asyncio.create_task(self._follow_once(key, row))
            except Exception as err:  # noqa: BLE001
                log.warning("fleet read failed: %s", type(err).__name__)
            # Waited on the loop, not in a worker thread: the few threads behind to_thread
            # are for the /fleet, view and stored reads.
            for _ in range(FLEET_S * 10):
                if stop.is_set():
                    break
                await asyncio.sleep(0.1)

    async def _follow_once(self, key, row):
        """One connection; the next /fleet read dials the bot again if it is still listed."""
        try:
            await self.follow(row)
        except Exception as err:  # noqa: BLE001
            log.warning("feed for claim %s failed: %s", row["claim_id"], type(err).__name__)
        finally:
            del self._following[key]

    async def follow(self, row):
        """One connection to one bot: bind, file live lines, and a stored read at the end."""
        meeting_id = await asyncio.to_thread(self.meeting_for, row["occurrence_id"])
        if meeting_id is None:
            return
        try:
            await self._bind(row, meeting_id)
        except (OSError, InvalidHandshake, ConnectionClosed, TimeoutError) as err:
            log.info("feed for claim %s ended: %s", row["claim_id"], type(err).__name__)
        finally:
            await asyncio.to_thread(self._stored.read, meeting_id)

    async def _bind(self, row, meeting_id):
        token, claim_id, generation = row["feed_token"], row["claim_id"], row["generation"]
        nonce = new_nonce()
        headers = {"X-Bwat-Feed-Nonce": nonce, "Authorization": "Bwat-Feed " + proof(token, claim_id, generation, nonce)}
        # Plain ws inside the install's private network, by design: the proof and
        # the per-frame MACs authenticate both ends and every frame; they do not encrypt.
        url = f"ws://{row['feed_host']}:{row['feed_port']}/feed"
        # proxy=None: an HTTP(S)_PROXY in the environment must not carry the dial elsewhere.
        async with _NoRedirects(url, additional_headers=headers, open_timeout=10, proxy=None) as ws:
            key = session_key(token, claim_id, generation, nonce)
            counter = 0
            hello = None
            try:
                async for message in ws:
                    frame = self._verified(key, counter, message)
                    counter += 1
                    if counter == 1 and frame.get("type") != "hello":
                        raise _Broken("first frame is not hello")
                    if frame.get("type") == "hello":
                        hello = await self._checked_hello(frame, row)
                        # Everything stored so far first; the live frames wait in the socket.
                        await asyncio.to_thread(self._stored.read, meeting_id)
                    elif frame.get("type") == "transcript":
                        bound = (hello["occurrence_id"], hello["transcript_epoch"])
                        if (frame.get("occurrence_id"), frame.get("transcript_epoch")) == bound:
                            try:
                                line = line_of(frame)
                            except KeyError as err:
                                raise _Broken("transcript frame is missing a field") from err
                            self._buffer.add(meeting_id, line)
            except _Broken as broken:
                log.warning("feed for claim %s refused: %s", claim_id, broken)
                await ws.close(POLICY_VIOLATION)
            except ConnectionClosed as closed:
                if closed.rcvd and closed.rcvd.code == 4000:
                    log.warning("feed for claim %s taken by another capture (4000)", claim_id)
                else:
                    log.info("feed for claim %s closed: %s", claim_id, closed.rcvd and closed.rcvd.code)

    @staticmethod
    def _verified(key, counter, message):
        try:
            envelope = json.loads(message)
            c, f, m = envelope["c"], envelope["f"], envelope["m"]
        except (ValueError, TypeError, KeyError) as err:
            raise _Broken("not an envelope") from err
        if not isinstance(f, str) or not hmac.compare_digest(str(m).encode(), frame_mac(key, c, f).encode()):
            raise _Broken("bad mac")
        if c != counter:
            raise _Broken("bad counter")
        try:
            frame = json.loads(f)
        except ValueError as err:
            raise _Broken("frame is not JSON") from err
        if not isinstance(frame, dict):
            raise _Broken("frame is not an object")
        return frame

    async def _checked_hello(self, hello, row):
        """The hello, if it matches the dialled row, or that same claim's row read again (it
        can lag the heartbeat that registered a new epoch)."""
        if any(hello.get(k) is None for k in HELLO_FIELDS):
            raise _Broken("hello is missing a field")
        if all(hello.get(k) == row.get(k) for k in HELLO_FIELDS):
            return hello
        # Only the epoch can have moved: the lines are filed under the dialled occurrence.
        if hello["occurrence_id"] != row["occurrence_id"]:
            raise _Broken("hello names another occurrence")
        dialled = (row["claim_id"], row.get("generation"))
        same = [r for r in await asyncio.to_thread(self.fleet) if (r["claim_id"], r.get("generation")) == dialled]
        if any(all(hello.get(k) == again.get(k) for k in HELLO_FIELDS) for again in same):
            return hello
        raise _Broken("hello does not match /fleet")


def line_of(frame):
    """A transcript frame as the line the stored read files (backend segmentView). A field
    missing or of the wrong type raises KeyError: the frame is refused."""
    ints = ("transcript_epoch", "seq", "start_ms", "end_ms")
    strs = ("speaker_label", "text", "source")
    if not all(type(frame.get(k)) is int and frame[k] >= 0 for k in ints) or not all(
        type(frame.get(k)) is str for k in strs
    ):
        raise KeyError("transcript frame field")
    for field in ('speaker_zoom_id', 'speaker_member_id'):
        if frame.get(field) is not None and (type(frame[field]) is not str or not frame[field]):
            raise KeyError("transcript identity field")
    return {
        "epoch": frame["transcript_epoch"],
        "seq": frame["seq"],
        "speaker": {"label": frame["speaker_label"], "member_id": frame.get("speaker_member_id"),
                    **({"zoom_id": frame["speaker_zoom_id"]} if frame.get("speaker_zoom_id") else {})},
        "text": frame["text"],
        "start_ms": frame["start_ms"],
        "end_ms": frame["end_ms"],
        "source": frame["source"],
    }
