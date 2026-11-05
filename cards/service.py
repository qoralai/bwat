"""The card service as one process (slice C6, QOR-4673): the stored read every
BWAT_CARDS_POLL_S seconds, the live feed from each bot (C3c), the writer loop every
second, the card lifecycle check every 30 s, and the card API on BWAT_CARDS_PORT (8000), until
SIGTERM.

Environment:
  BWAT_CARDS_DB_URL         the card login's database URL (no TLS parameters in it)
  BWAT_DB_SSLROOTCERT       a CA bundle path; set, every connection is verify-full TLS, as
                            the backend's (the image carries the RDS bundle at
                            /app/rds-global-bundle.pem); unset, no TLS
  BWAT_BACKEND_URL          the backend, e.g. http://backend:3000
  BWAT_CARDS_CREDENTIAL     the card service's bwc_ credential for the backend
  BWAT_CARDS_BACKEND_TOKEN  the install-wide token the backend calls this service with (D162)
  BWAT_DEV_PERSON_TOKEN     local stacks only: the backend's dev token, which the board's
                            routes then pass on although it has no real token's shape
  BWAT_CARDS_MAX_CONCURRENT the card API's database connections, a pool of at most this
                            many, a whole number from 1 (default 20). A request with none
                            free waits 2 s, then is refused with 503 busy (QOR-4986)
"""

import logging
import os
import signal
import threading

import httpx
from psycopg.conninfo import make_conninfo

from api.app import MAX_CONCURRENT, make_server
from capture.buffer import Buffer
from capture.feed import FeedCapture
from capture.stored import StoredRead
from writer.loop import WriterLoop

log = logging.getLogger("cards")


def database_url(env):
    """The card login's connection string: a 10 s connect timeout, so an unreachable
    database fails a round instead of hanging it, and verified TLS when a CA is given."""
    url = make_conninfo(env["BWAT_CARDS_DB_URL"], connect_timeout=10)
    ca = env.get("BWAT_DB_SSLROOTCERT")
    if not ca:
        return url
    if not os.access(ca, os.R_OK):
        raise ValueError("BWAT_DB_SSLROOTCERT cannot be read")
    return make_conninfo(url, sslmode="verify-full", sslrootcert=ca)


def describe(err):
    """An error's kind and its HTTP status or SQLSTATE, never its text: a database error's
    text can carry the row, and so the meeting's words."""
    detail = err.response.status_code if isinstance(err, httpx.HTTPStatusError) else getattr(err, "sqlstate", None)
    return f"{type(err).__name__} {detail or ''}".rstrip()


def every(seconds, work, stop):
    """Runs `work` every `seconds` until `stop`; a failed round is logged and the next one runs."""
    while not stop.wait(seconds):
        try:
            work()
        except Exception as err:  # noqa: BLE001
            log.warning("%s failed: %s", work.__qualname__, describe(err))


def max_concurrent(env):
    """BWAT_CARDS_MAX_CONCURRENT, a whole number from 1; empty is the default. Anything else
    stops the service at startup, saying so."""
    value = env.get("BWAT_CARDS_MAX_CONCURRENT") or str(MAX_CONCURRENT)
    try:
        number = int(value)
    except ValueError:
        number = 0
    if number < 1:
        raise SystemExit(f"BWAT_CARDS_MAX_CONCURRENT must be a whole number from 1, not {value!r}")
    return number


def exit_code(signalled):
    """0 after SIGTERM or SIGINT; 1 when a worker ended on its own, so a container restart
    policy (on-failure) brings the service back."""
    return 0 if signalled.is_set() else 1


def until_stopped(target, args, stop):
    """Runs a worker; when it ends, for whatever reason, the service stops, so a dead API or
    loop is restarted with the container instead of running on without it."""
    try:
        target(*args)
    finally:
        stop.set()


def backend_client(env, transport=None):
    """The card service's client for the backend: every call is under its bwc_ credential (D152)."""
    return httpx.Client(base_url=env["BWAT_BACKEND_URL"], timeout=30, transport=transport,
                        headers={"Authorization": f"Bearer {env['BWAT_CARDS_CREDENTIAL']}"})

def main(env=os.environ):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    # httpx logs every request's URL at INFO: a line per poll.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    dsn = database_url(env)
    backend = backend_client(env)
    buffer = Buffer()
    stored = StoredRead(dsn, backend, buffer)
    writer = WriterLoop(dsn, buffer, backend)
    server = make_server(dsn, backend, env.get("BWAT_CARDS_BACKEND_TOKEN"), port=int(env.get("BWAT_CARDS_PORT") or 8000),
                         activity=writer.activity, paused=lambda: writer.paused,
                         dev_token=env.get("BWAT_DEV_PERSON_TOKEN") or None, settings=writer._read_settings,
                         max_concurrent=max_concurrent(env))
    capture = FeedCapture(dsn, backend, stored, buffer)
    stop = threading.Event()
    signalled = threading.Event()

    def on_signal(*_):
        signalled.set()
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    # Daemons: SIGTERM does not wait for a model or backend call in flight. Nothing is lost
    # by stopping mid-round: a window's cards and position are written together, after the
    # model answers, and the stored read starts again from the saved position.
    for target, args in [
        (every, (float(env.get("BWAT_CARDS_POLL_S") or 3), stored.poll, stop)),
        (every, (1, writer.tick, stop)),
        # Reconciliation can take minutes; it must not hold up live extraction.
        (every, (10, writer._reconcile_jobs, stop)),
        # Jev's duplicate hints (QOR-4770), on their own thread: a batch can take seconds.
        (every, (2, writer._hint_checks, stop)),
        # Live cards nobody acted on for 10 days close as no response (D194), and ended
        # meetings' drafts go live once their clean-up is over: one UPDATE each.
        (every, (30, writer._lifecycle, stop)),
        (capture.run, (stop,)),
        (server.serve_forever, ()),
    ]:
        threading.Thread(target=until_stopped, args=(target, args, stop), daemon=True).start()
    log.info("card service listening on %d", server.server_address[1])
    stop.wait()
    logging.shutdown()
    # Not server.shutdown(), which waits for serve_forever to have started (a SIGTERM at
    # startup would hang), and not a normal return: at exit Python joins the worker threads
    # behind asyncio.to_thread, so it would wait for a call in flight to a bot or the backend.
    os._exit(exit_code(signalled))
