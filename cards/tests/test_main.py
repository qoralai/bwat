"""The card service as one process: stored read, writer loop and API (slice C6, QOR-4673)."""

import logging
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import httpx
import psycopg
import pytest

from api.app import make_server
from service import backend_client, database_url, every, exit_code, max_concurrent, until_stopped

CARDS = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(env):
    return subprocess.Popen(
        [sys.executable, "."], cwd=CARDS, env={**os.environ, **env}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )


def service_env(db, port):
    return {
        "BWAT_CARDS_DB_URL": db.url("cards"),
        "BWAT_BACKEND_URL": "http://127.0.0.1:9",
        "BWAT_CARDS_CREDENTIAL": "bwc_test",
        "BWAT_CARDS_BACKEND_TOKEN": "backend-token",
        "BWAT_CARDS_PORT": str(port),
    }


def healthy(port, within_s):
    deadline = time.monotonic() + within_s
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"http://127.0.0.1:{port}/health", timeout=1).status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    return False


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM is a POSIX signal; CI runs this on Linux")
def test_the_service_answers_health_and_stops_cleanly_on_sigterm(db):
    port = free_port()
    service = start(service_env(db, port))
    try:
        assert healthy(port, within_s=5), service.stdout.read1().decode() if service.poll() is not None else ""
        service.send_signal(signal.SIGTERM)
        assert service.wait(timeout=10) == 0
    finally:
        service.kill()


def test_the_service_will_not_start_without_the_backend_token(db):
    env = service_env(db, free_port()) | {"BWAT_CARDS_BACKEND_TOKEN": ""}
    service = start(env)
    assert service.wait(timeout=30) != 0
    assert b"BWAT_CARDS_BACKEND_TOKEN" in service.stdout.read()


def test_a_ca_path_turns_on_verified_tls_as_the_backend_does(tmp_path):
    ca = tmp_path / "ca.pem"
    ca.write_text("not checked here")
    info = psycopg.conninfo.conninfo_to_dict(
        database_url({"BWAT_CARDS_DB_URL": "postgresql://cards@db:5432/bwat", "BWAT_DB_SSLROOTCERT": str(ca)})
    )
    assert (info["sslmode"], info["sslrootcert"], info["host"]) == ("verify-full", str(ca), "db")

    plain = psycopg.conninfo.conninfo_to_dict(database_url({"BWAT_CARDS_DB_URL": "postgresql://cards@db:5432/bwat"}))
    assert "sslmode" not in plain and plain["host"] == "db"
    # Every connection gives up on an unreachable database instead of hanging a round.
    assert plain["connect_timeout"] == info["connect_timeout"] == "10"
    with pytest.raises(ValueError, match="BWAT_DB_SSLROOTCERT"):
        database_url({"BWAT_CARDS_DB_URL": "postgresql://cards@db/bwat", "BWAT_DB_SSLROOTCERT": str(tmp_path / "missing.pem")})


def test_a_failed_round_is_logged_and_the_next_one_runs():
    """On compose the card service can start before the backend answers."""
    stop = threading.Event()
    calls = []

    def poll():
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("backend not up yet")
        stop.set()

    every(0.01, poll, stop)
    assert len(calls) == 2


@pytest.fixture
def live_meeting(db):
    number = str(secrets.randbelow(9 * 10**8) + 10**8)
    occurrence = f"occ-{uuid.uuid4().hex[:8]}"
    with db.connect("owner") as owner:
        owner.execute("INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (%s, %s)", [occurrence, number])
        owner.execute("INSERT INTO bwat.claims (meeting_number, occurrence_uuid, state) VALUES (%s, %s, 'pending')", [number, occurrence])
    yield
    with db.connect("owner") as owner:
        owner.execute("UPDATE bwat.claims SET state = 'done', meeting_ended_at = now() WHERE occurrence_uuid = %s", [occurrence])


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM is a POSIX signal; CI runs this on Linux")
def test_sigterm_does_not_wait_for_a_backend_that_never_answers(db, live_meeting):
    with socket.socket() as silent:
        silent.bind(("127.0.0.1", 0))
        silent.listen()
        port = free_port()
        env = service_env(db, port) | {"BWAT_BACKEND_URL": f"http://127.0.0.1:{silent.getsockname()[1]}", "BWAT_CARDS_POLL_S": "0.2"}
        service = start(env)
        try:
            assert healthy(port, within_s=5)
            time.sleep(1)  # the stored read is now waiting on the silent backend
            service.send_signal(signal.SIGTERM)
            assert service.wait(timeout=3) == 0
        finally:
            service.kill()


def test_a_failed_round_logs_what_failed_but_not_what_it_said(caplog):
    stop = threading.Event()

    def poll():
        stop.set()
        raise psycopg.errors.CheckViolation('Failing row contains (ship it on friday, pwd=secret)')

    with caplog.at_level(logging.WARNING):
        every(0.01, poll, stop)
    assert "CheckViolation" in caplog.text
    assert "friday" not in caplog.text and "secret" not in caplog.text


def test_a_request_is_logged_without_its_query(db, caplog):
    server = make_server(db.url("cards"), httpx.Client(base_url="http://backend.test"), "backend-token", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with caplog.at_level(logging.INFO):
            response = httpx.get(f"http://127.0.0.1:{server.server_address[1]}/health?pwd=secret")
        assert response.status_code == 200
        logged = " | ".join(r.getMessage() for r in caplog.records if r.name == "cards.api")
        assert "/health" in logged and "secret" not in logged
    finally:
        server.shutdown()
        server.server_close()


def test_a_malformed_request_is_refused_and_logged_without_its_text(db, caplog):
    server = make_server(db.url("cards"), httpx.Client(base_url="http://backend.test"), "backend-token", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with caplog.at_level(logging.INFO), socket.create_connection(("127.0.0.1", server.server_address[1])) as raw:
            raw.sendall(b"GET /health?pwd=secret extra HTTP/1.1\r\n\r\n")
            answer = raw.recv(1024)
        assert answer.startswith(b"HTTP/1.0 400")
        logged = " | ".join(r.getMessage() for r in caplog.records if r.name == "cards.api")
        assert logged and "secret" not in logged
    finally:
        server.shutdown()
        server.server_close()


def test_an_empty_optional_setting_means_its_default(db):
    """Compose passes BWAT_CARDS_POLL_S and BWAT_CARDS_MAX_CONCURRENT as empty strings when
    .env leaves them out."""
    port = free_port()
    service = start(service_env(db, port) | {"BWAT_CARDS_POLL_S": "", "BWAT_CARDS_MAX_CONCURRENT": ""})
    try:
        assert healthy(port, within_s=10), service.stdout.read1().decode() if service.poll() is not None else ""
    finally:
        service.kill()


def test_a_worker_that_dies_stops_the_service():
    stop = threading.Event()

    def server_crashes():
        raise OSError("socket gone")

    with pytest.raises(OSError):
        until_stopped(server_crashes, (), stop)
    assert stop.is_set()


def test_a_dead_worker_exits_non_zero_and_a_signal_exits_zero():
    signalled = threading.Event()
    assert exit_code(signalled) == 1
    signalled.set()
    assert exit_code(signalled) == 0


def test_every_call_to_the_backend_carries_the_card_service_credential():
    seen = []
    client = backend_client({"BWAT_BACKEND_URL": "http://backend.test", "BWAT_CARDS_CREDENTIAL": "bwc_test"},
                            transport=httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(204)))
    for path in ("/v1/fleet", "/v1/cards/settings", "/v1/meetings/m/transcript"):
        client.get(path)
    client.post("/v1/card-service/person", json={})
    assert [(str(r.url), r.headers["authorization"]) for r in seen] == [
        ("http://backend.test" + p, "Bearer bwc_test")
        for p in ("/v1/fleet", "/v1/cards/settings", "/v1/meetings/m/transcript", "/v1/card-service/person")]


def test_the_cap_on_requests_is_a_whole_number_from_1_and_empty_is_20():
    assert (max_concurrent({}), max_concurrent({"BWAT_CARDS_MAX_CONCURRENT": ""})) == (20, 20)
    assert max_concurrent({"BWAT_CARDS_MAX_CONCURRENT": "7"}) == 7
    for value in ("0", "-1", "1.5", "abc"):
        with pytest.raises(SystemExit, match="BWAT_CARDS_MAX_CONCURRENT must be a whole number from 1"):
            max_concurrent({"BWAT_CARDS_MAX_CONCURRENT": value})
