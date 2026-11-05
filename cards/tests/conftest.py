"""A test database the way the card service will meet one.

The backend's migrations run as the owner role, exactly as its migration runner applies
them, and the card service logs in as its own login, bwat_cards. BWAT_TEST_DB_URL is a
superuser URL for a throwaway Postgres 16, used only to create the roles and the database
and to drop it again. Without it the database tests skip locally; in CI they must run, so
a missing URL there is an error.
"""

import os
import secrets
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit

import psycopg
import pytest

MIGRATIONS = Path(__file__).resolve().parents[2] / "backend" / "migrations"
ROLES = {
    "owner": "bwat_owner",
    "runtime": "bwat_runtime",
    "cards": "bwat_cards",
}


def _base_url():
    url = os.environ.get("BWAT_TEST_DB_URL") or None
    if url is None and os.environ.get("CI") not in (None, "", "false"):
        raise RuntimeError("BWAT_TEST_DB_URL must be set in CI: the database tests must run there")
    return url


def _with(url, *, user=None, database=None):
    parts = urlsplit(url)
    netloc = parts.netloc
    if user is not None:
        creds, host = netloc.rsplit("@", 1)
        password = creds.split(":", 1)[1] if ":" in creds else ""
        netloc = f"{user}:{password}@{host}"
    path = f"/{database}" if database is not None else parts.path
    return urlunsplit((parts.scheme, netloc, path, parts.query, parts.fragment))


class TestDb:
    def __init__(self, base, name):
        self.base = base
        self.name = name

    def url(self, role):
        return _with(self.base, user=ROLES[role], database=self.name)

    def connect(self, role):
        return psycopg.connect(self.url(role), autocommit=True)


@pytest.fixture(scope="session")
def db():
    base = _base_url()
    if base is None:
        pytest.skip("BWAT_TEST_DB_URL is unset (a Postgres 16 superuser URL)")
    password = unquote(urlsplit(base).password or "")
    name = f"bwat_cards_test_{secrets.token_hex(6)}"
    with psycopg.connect(base, autocommit=True) as su:
        # Roles are cluster-wide, so concurrent runs serialise on a lock.
        with su.transaction():
            su.execute("SELECT pg_advisory_xact_lock(4604)")
            for role in ROLES.values():
                attributes = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
                su.execute(
                    f"""DO $$ BEGIN CREATE ROLE {role} {attributes} PASSWORD '{password}';
                    EXCEPTION WHEN duplicate_object OR unique_violation THEN
                    ALTER ROLE {role} {attributes} PASSWORD '{password}'; END $$"""
                )
        su.execute(f"CREATE DATABASE {name} OWNER {ROLES['owner']}")
        su.execute(f"GRANT CONNECT ON DATABASE {name} TO {ROLES['runtime']}, {ROLES['cards']}")
    test_db = TestDb(base, name)
    try:
        with test_db.connect("owner") as owner:
            # The runner's ledger, which it makes before any migration runs: 0048 tidies it.
            owner.execute(
                "CREATE TABLE public.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, "
                "applied_at timestamptz NOT NULL DEFAULT now())"
            )
            for migration in sorted(MIGRATIONS.glob("*.sql")):
                with owner.transaction():
                    owner.execute(migration.read_text(encoding="utf-8"))
        yield test_db
    finally:
        with psycopg.connect(base, autocommit=True) as su:
            su.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


@pytest.fixture
def meeting(db):
    """A meeting with two members, Marco and Ada, written by the backend's login."""
    tag = uuid.uuid4().hex[:8]
    with db.connect("runtime") as backend:
        meeting_id = backend.execute(
            "INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (%s, '123456789') RETURNING id",
            [f"occ-{tag}"],
        ).fetchone()[0]
        marco, ada = (
            backend.execute(
                "INSERT INTO bwat.members (email, display_name, activated_at) VALUES (%s, %s, now()) RETURNING id",
                [f"{name.lower()}-{tag}@example.com", f"{name} {tag}"],
            ).fetchone()[0]
            for name in ("Marco", "Ada")
        )
    return {"id": meeting_id, "marco": marco, "ada": ada, "marco_name": f"Marco {tag}", "ada_name": f"Ada {tag}"}
