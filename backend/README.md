# bwat-backend

The record keeper for **bwat**: identity and roles, Zoom ingress, allocation, meeting
context, to-dos, the hand-off inbox and the session registry.

TypeScript on Node 22, Fastify, Postgres 16. One company per install, so there is no
workspace column and no row-level security; inside the company, each person is an owner,
an admin or a member.

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
npm run dev        # needs BWAT_DB_URL; see .env.example
```

`GET /health` answers `200 {"status":"ok","db":"ok"}`, or `503` with `"db":"unavailable"`
when Postgres does not answer. It never says where the database is or why it failed.

## Base path, proxy and headers

Every API route is under **`/v1`**: the route tables below name paths relative to it, so
`POST /bots/register` is `POST /v1/bots/register` and Zoom's event subscription URL is
`https://<public host>/v1/callbacks/zoom/events`. `GET /health` alone stays at the root,
unprefixed, for load-balancer and compose health checks. An unprefixed API path (the
old `/me`, `/allocations`, `/callbacks/zoom/events` and so on) answers `404 {"error":"not_found"}`.

| Variable | Meaning |
|---|---|
| `BWAT_TRUST_PROXY` | Whether `X-Forwarded-For` and `X-Forwarded-Proto` name the client (its address and `https`), for a backend behind a TLS-terminating proxy such as Caddy. Off when unset, empty, `false` or `0`: the headers are ignored, since any client could send them. `true` trusts every hop; anything else is a comma-separated list of proxy addresses or CIDRs (`172.16.0.0/12,127.0.0.1`), trusted only when the request comes from one of them. A hop count (`1`) stops the server starting: Fastify 5.12 no longer honours one and would trust nothing |
| `BWAT_FRAME_ANCESTORS` | Who may frame bwat besides Zoom (QOR-4830), added to the `frame-ancestors` below: space-separated, each `https://host`, `https://host:port`, `https://host:*` or a bare scheme such as `qv:` (never `https:`, `http:`, `data:` or `blob:`, which any site has). For the board inside a plugin's product: its pages' address, and a scheme such as `qv:` for a desktop app (the plugin's README says which). Unset or empty: Zoom alone. Anything else stops the server starting. Set the web server's to the same |

Every answer carries these headers, errors, `404`s and `304`s included:

| Header | Value | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | HTTPS only, for a year; browsers ignore it over plain HTTP |
| `X-Content-Type-Options` | `nosniff` | A body is read as its declared type, never sniffed |
| `Referrer-Policy` | `no-referrer` | Nothing the backend answers needs a `Referer` from the browser, and a URL here can carry a meeting link; the stricter choice costs nothing |
| `Content-Security-Policy` | `frame-ancestors https://*.zoom.us https://*.zoom.com`, then the sources in `BWAT_FRAME_ANCESTORS` | The board opens inside the Zoom client, so only Zoom may frame it, and whoever the install adds (the board inside a plugin's product) |

`X-Frame-Options` is never sent: it cannot name Zoom, so any value would forbid the Zoom
client; `frame-ancestors` replaces it. A request Fastify refuses while parsing it (a
malformed request line or header, before routing) is answered by Node without them.

Errors a route does not answer itself are mapped once, by code, in the server's error
handler, and logged as `request.rejected` (or `request.failed`) with the code only, never
the message, which can quote the request back:

| Code | Answer |
|---|---|
| `FST_ERR_CTP_BODY_TOO_LARGE` (a body over the route's limit) | `413 {"error": "too_large"}` |
| `FST_ERR_CTP_INVALID_MEDIA_TYPE` (a content type no route parses) | `415 {"error": "unsupported_media_type"}` |
| PostgreSQL `22021`, `22P05` (text or JSON holding a NUL, `\u0000`, which JSON allows and Postgres cannot store), on any route | `400 {"error": "invalid_body"}`, nothing stored |
| Any other 4xx | its status, `{"error": "invalid_body"}` |
| Anything else | `500 {"error": "internal"}` |

### Public hosting and rate limits

A hosted install is public on the internet, with Google sign-in its only gate
(QOR-4625). Two kinds of request cost something before the backend can tell whether to
trust them, so each is limited per client IP, in a bucket of its own, a minute at a time:

| Variable | Bucket | Default |
|---|---|---|
| `BWAT_RATE_LIMIT_SIGNIN_FAILURES_PER_MIN` | Failed Google sign-ins: a bearer, neither the dev token nor a test person's, that does not verify, or verifies from a refused domain, as someone who is not a member, or as another Google account than the one the address is bound to. A successful sign-in is never counted, so people, boards and the plugin calling the API as often as they like are never limited. An IP that has spent its failures is refused before its next bearer is verified, valid or not, so a flood of bad tokens never reaches Google's keys | `30` |
| `BWAT_RATE_LIMIT_ZOOM_PER_MIN` | `POST /callbacks/zoom/events`, counted before the body is read or the signature checked, and the meeting-schedule lookup of a signed-in, valid `POST /allocations`, one bucket for both. A send over it is never refused: it goes ahead without the lookup, so with no scheduled end. Zoom can burst | `600` |

Each must be a whole number from 1; anything else stops the server starting. Empty is the
default. The client IP is the socket's address, or the client the proxy names when
`BWAT_TRUST_PROXY` trusts it; `X-Forwarded-For` is never read otherwise. Behind a load
balancer, set it to the load balancer's subnet CIDRs, never `true`: the balancer appends
the real client to whatever `X-Forwarded-For` the client sent, so only the right-most
untrusted address is the client. Left unset there, every caller shares the balancer's
address and one bad client can spend everyone's sign-in budget. The card service checks
a board's bearer with `POST /card-service/person`, naming the client it saw, so those
checks count against that client, never the card service's own address (QOR-4749); the
card service keeps the same limit per client itself. A request over
its bucket answers `429 {"error": "rate_limited"}` with `Retry-After` (seconds) and the
headers above, and is logged as `rate_limited` with its bucket (`signin` or `zoom`) only,
never the IP or the token. A request with no bearer, the dev token, a test person's
token, the bot routes (a fleet credential or a `bwb_` bot token) and `GET /health` are never counted. The counts are
kept in memory, per backend process, for at most 10,000 IPs a bucket (the oldest forgotten first).

Every other route refuses a caller who presents nothing: `test/auth-guard.test.ts`
enumerates the router and calls each route with no `Authorization`, wanting `401`. Open
routes, the whole allowlist:

| Route | Why |
|---|---|
| `GET /health` (and its `HEAD`) | Load-balancer checks; says only whether the database answers |
| `POST /callbacks/zoom/events` | Zoom cannot sign in; it signs each delivery instead, and an unsigned one is refused `401` by the route itself |

## Database

Three logins and the database, made once by `db-bootstrap` from an admin connection: a
superuser, or a login with `CREATEROLE` and `CREATEDB` such as the RDS master user. It
ships in the backend image:

```bash
BWAT_DB_ADMIN_URL=postgres://postgres:...@127.0.0.1:5432/postgres \
BWAT_OWNER_PASSWORD=... BWAT_RUNTIME_PASSWORD=... BWAT_CARDS_PASSWORD=... \
  node dist/scripts/db-bootstrap.js          # npm run db-bootstrap from a checkout
```

| Variable | |
|---|---|
| `BWAT_DB_ADMIN_URL` | The admin connection, to any database on the server (e.g. `postgres`) |
| `BWAT_DB_ADMIN_USER`, `BWAT_DB_ADMIN_PASSWORD`, `BWAT_DB_ADMIN_HOST`, `BWAT_DB_ADMIN_PORT` | The admin connection as parts, used when `BWAT_DB_ADMIN_URL` is unset; it connects to the `postgres` database. For RDS: the password may hold characters a URL would need escaped, and ECS passes the master secret's `username` and `password` keys straight in |
| `BWAT_OWNER_PASSWORD`, `BWAT_RUNTIME_PASSWORD`, `BWAT_CARDS_PASSWORD` | The three logins' passwords: printable ASCII, no spaces (they go into `postgres://` URLs, so `openssl rand -hex 24`) |
| `BWAT_DB_NAME` | The database, default `bwat` |
| `BWAT_DB_SSLROOTCERT` | TLS to Postgres, as for every backend connection (below) |

The admin variables are read as `NAME_FILE` > `NAME` only, never from the secret store.
The three passwords are read as `NAME_FILE` > `NAME` > the aws store
(`<prefix>NAME`, with `BWAT_SECRET_STORE=aws`), like every startup secret. It prints one
line per object, `created` or `kept`, and never a URL or a password; anything that fails
exits 1 with a message naming the step. Run it again at any time: a login that exists
is kept and only its password is set again (so a run is also how a password is
rotated), an existing database is kept, and nothing is ever dropped. No plaintext
password reaches the server: it sends Postgres the SCRAM-SHA-256 verifier, so no
statement, server log or error shows a password, though the verifiers may appear in
server statement logs (`log_statement`).

### TLS to Postgres

`BWAT_DB_SSLROOTCERT` is the path of a CA bundle. When it is set, every backend database
connection (the server and its scripts, `migrate` and `db-bootstrap`) uses TLS and checks
the server's certificate and host name against it (`verify-full`); unset, there is no
TLS, as on the compose network. The image carries the RDS bundle, pinned by its digest:

```bash
BWAT_DB_SSLROOTCERT=/app/rds-global-bundle.pem
```

Leave TLS parameters (`sslmode`, `sslrootcert`, ...) out of the database URLs: the Postgres
client lets a URL's own parameters override this setting.

It does not audit logins or a database that already exist: it keeps them as they are and
sets the passwords.

What it does is equivalent to this SQL (for reference, or for a server you set up by hand):

```sql
CREATE ROLE bwat_owner   LOGIN PASSWORD '...';
CREATE ROLE bwat_runtime LOGIN NOBYPASSRLS PASSWORD '...';
CREATE ROLE bwat_cards   LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...';
CREATE DATABASE bwat OWNER bwat_owner;
GRANT CONNECT ON DATABASE bwat TO bwat_runtime;
GRANT CONNECT ON DATABASE bwat TO bwat_cards;
```

**On RDS** the master user is not a superuser, and Postgres lets a non-superuser give a
database only to a role it can act as (`SET ROLE`). So when the master user cannot act
as `bwat_owner`, the script runs `GRANT bwat_owner TO <master user> WITH INHERIT FALSE,
SET TRUE` (the master user may, since it created the role; a membership of its own that
lacks SET only gets `SET TRUE`) and prints `role bwat_owner: granted to <master user>`.
It grants CONNECT acting as `bwat_owner`, since a GRANT from a login without grant
authority only warns, and checks the grant took effect before it prints `granted`. The
master user stays a member of `bwat_owner`; migrations still refuse to run as it (see
Migrations). If someone else created `bwat_owner`, the master user may lack the right to
set its password or grant it; the script then stops naming that step.

- `bwat_owner` owns the database and the `bwat` schema and runs the migrations
  (`BWAT_OWNER_DB_URL`). Nothing else uses it.
- `bwat_runtime` is what the app logs in as (`BWAT_DB_URL`). It cannot create, alter or
  drop anything, and gets only the DML each table grants it. The server checks this
  before it listens and refuses to start as a superuser, as the owner, or as any role
  but `bwat_runtime`.
- `bwat_cards` is what the card service logs in as (`BWAT_CARDS_DB_URL`). It may read
  and write the `cards` schema (migration 0009) and read two views of the backend's data
  (migration 0010), and owns nothing; `bwat_runtime` gets nothing on `cards.*`.
  Migration 0009 stops with an error if this role does not exist.

  The views, the only things in `bwat` the card login can read (it has `USAGE` on the
  schema and `SELECT` on these two; every `bwat` table answers it `42501`). Both read the
  tables as their owner; `bwat_runtime` has no grant on them:

  | View | Columns |
  |---|---|
  | `bwat.v_cards_members` | `member_id`, `display_name`, `email`, `zoom_user_id`, `active` (`activated_at IS NOT NULL`). No role or Google account. |
  | `bwat.v_cards_occurrences` | `meeting_id`, `occurrence_uuid`, `meeting_number`, `started_at`, `ended_at`, `occurrence_state` (`live`, `ended` or `abandoned`, exactly as the transcript read reports it), `title` (0033: the open to-do list names each card's meeting). |

  `occurrence_state` is defined in SQL in the view and again in `findMeeting`
  (`src/meetings.ts`); `test/occurrence-state.test.ts` reads every state through both and
  fails on a difference. Changing one means a new migration that replaces the view (0011
  did, so an expired transcript reads `ended` in both).
- **A migration that adds a function grants EXECUTE on it by name.** Since 0010, a function
  `bwat_owner` creates (in any schema, including one an extension installs) is executable
  by no other role by default, so `bwat_runtime` or `bwat_cards` get "permission denied for
  function" until the migration grants it. `test/db/cards-views.test.ts` keeps that default.

  Upgrading a local Docker stack created before 0009: set `BWAT_CARDS_PASSWORD` in
  `.env`, then `docker compose up -d --build`. The `db-bootstrap` service keeps the
  existing logins and database and creates `bwat_cards`.

### Migrations

```bash
BWAT_OWNER_DB_URL=postgres://bwat_owner:...@127.0.0.1:5432/bwat npm run migrate
```

Plain SQL files in `migrations/`, named `NNNN_name.sql`, applied once each in name
order, each in its own transaction, and recorded in `public.schema_migrations` with a
checksum. Running it again applies only what is new. It runs only as the role that owns
the database (not a superuser, and not a role that can merely act as the owner, such as
the RDS master user). It refuses to run at all if an applied file has been edited or
removed, if two files share a number, or if a new file is numbered before one already
applied: change the schema with a new, higher-numbered file, never by rewriting history.

A plugin's migrations (see Plugins) sit in `migrations/plugins/<plugin>/`, numbered on
their own and recorded as `plugins/<plugin>/NNNN_name.sql`; the same rules apply to each
plugin's files on their own, after core's. They run whether or not the plugin is switched
on.

A migration that adds a table grants the runtime role exactly what that table needs,
by name. There are no default privileges, so a table nobody granted is unreadable:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.things TO bwat_runtime;
GRANT SELECT, INSERT ON bwat.events TO bwat_runtime;  -- append-only: no UPDATE, no DELETE
```

### Tests

The database tests need a throwaway Postgres 16 and a **superuser** URL for it in
`BWAT_TEST_DB_URL`, put in `backend/.env.test` (git-ignored; loaded by the test
harness). Once per run, the test setup creates the two roles if missing and a
template database with the migrations applied as the owner; each test file copies
it into a fresh `bwat_test_*` database and drops that afterwards.

```bash
docker run -d --name bwat-testdb -e POSTGRES_PASSWORD=... -p 127.0.0.1:5434:5432 postgres:16
echo 'BWAT_TEST_DB_URL=postgres://postgres:...@127.0.0.1:5434/postgres' > .env.test
npm test
```

Without `BWAT_TEST_DB_URL` the database tests skip, and say why. With `CI` set they
cannot skip: the harness throws if `CI` is set without it, so a CI job needs a Postgres 16
service and the variable set.

## Local stack (Docker)

From the repository root: `cp .env.docker.example .env`, fill it in, then
`docker compose up -d --build`. Postgres 16 starts empty, a one-off `db-bootstrap` service
makes the logins and the database above (as the `postgres` superuser), a one-off
`migrate` service applies the migrations as `bwat_owner`, and the backend starts as
`bwat_runtime` on `127.0.0.1:${BWAT_PORT}`.
`docker compose down -v` removes it all, data included.

## Bots and allocations

| Route | Caller | What |
|---|---|---|
| `POST /bots/register` | fleet credential | Registers a bot (`version`, and on ECS its `task_arn`) and returns its `bot_id` and `bot_token`, once |
| `POST /bots/ready` | bot token | `{"ready": true}` (default) or `false`. Only a ready bot is allocated |
| `GET /assignment` | bot token | This bot's claim, or `null`. The claim's `transcript_epoch` is the occurrence's highest accepted epoch, or `null` (before promotion, or before any). Its `feed_token` is this claim generation's feed token, `bwo_` + base64url(HMAC-SHA256(`BWAT_FEED_KEY`, `claim_id|generation`)), derived so nothing is stored; `null` without `BWAT_FEED_KEY`. The heartbeat answer carries it too. The poll also counts as the bot's heartbeat time (liveness): a ready bot that only polls stays allocatable and is never shown stale. A fleet credential gets `409 unregistered_bot` |
| `POST /allocations` | person | `{"zoom_url"}`: `202` with the new claim, `200` with `"status": "already_claimed"` for a meeting that has an open one, `422` for anything but a Zoom join link (`not_a_zoom_meeting_link`). Goes ahead whatever the meeting's recording setting (see Readiness gate); Zoom is asked only for the meeting's scheduled end (see Scheduled end) |
| `GET /allocations` | person | `{"allocations": [...]}`: open claims and those ended in the last 24 h, newest first (at most 200), each with the holding bot's last `error` and `joined_at` (when its bot first reported it was in the meeting, else null) |
| `PATCH /allocations/{id}` | admin/owner | `{"recall": true}`. A recall cancels a pending claim; a held claim's bot learns on its next heartbeat. Hosts use the signed Zoom meeting route to recall. `404` unknown, `409 not_live` once ended |
| `POST /assignment/heartbeat` | bot token | `{"claim_id", "generation", "transcript_epoch"?, ...BotStatus}`: renews the lease and answers the Claim; `409 stale_claim` means leave the meeting. Only the fence and epoch can refuse it (`400`: int4 counts, and an epoch above 1000000); a status field the backend cannot store is dropped, never refused, except the feed address: `feed_host` must be a private IPv4 literal (10/8, 172.16/12, 192.168/16; a name, a public, loopback or link-local address, or an IPv6 one, is `400 invalid_body`) and `feed_port` 1-65535. `transcript_epoch` is declared by the bot, not granted: it bumps it for each new transcript stream (see the transcript epoch below); `409 stale_epoch` refuses an epoch the occurrence already used, without renewing the lease. An idle bot sends BotStatus alone, with neither `claim_id` nor `generation` (one without the other is `400`), and gets `null` (an extension of the contract); if it is ready and a claim is waiting, that beat also runs allocation |
| `POST /assignment/occurrence` | bot token | `{"claim_id", "generation", "occurrence_uuid"}`: records the occurrence and opens bwat's meeting for it, then reads its title and host from Zoom after answering; `409 stale_claim`, `occurrence_conflict` or `meeting_already_ended` (the claim then ends, `done`/`meeting_already_ended`, and its bot is free) |
| `POST /assignment/join-token` | bot token | `{"claim_id", "generation"}`: the bot's Zoom credentials for its claim's meeting, so the bot holds no Zoom app secret. See Zoom tokens below |
| `POST /assignment/chat-cards` | bot token | `{"claim_id", "generation", "list"}`: what the bot posts in the meeting chat, `{"cards": [{"display_id", "title"}]}` from the card service. `list` is `agenda` (the open to-dos, questions, risks and decisions of the meeting's previous occurrence, each with its `"kind"`, with `"summary"`: two or three sentences from the card writer's model, null when nothing carried over or the model could not say in time, and the bot then posts a count of each kind; QOR-4966) or `questions` (this occurrence's open questions nobody owns). `409 stale_claim` for a claim not the bot's; `503 unavailable` without a card service or while it is down |
| `POST /assignment/release` | bot token | `{"claim_id", "generation", "reason"?, "meeting_ended"?, "requeue"?}`: `200 {"status": "released"}` or `{"status": "requeued"}`; `400 invalid_body`, `409 stale_claim`. See release reasons below. Allocation re-runs |
| `GET /fleet` | person, or the card-service credential | `{"fleet": [...]}`: one row per bot heard from in the last 10 min or holding a claim: ready, busy (holds a live claim), stale (no heartbeat or poll for 45 s), the last report and the claim. The card service's rows add `generation`, `transcript_epoch`, `feed_token` and the reported `feed_host`/`feed_port` (the bot's feed, `bot/bwat_bot/feed.py`), null once the bot is stale, or past its lease or its drain after Zoom's end, so capture stops dialing a bot that is gone; people's never do. The credential needs no onboarded install |

Bot credentials are bearer tokens, stored as sha256 only. An operator issues a fleet
credential (one per install, D140), printed once:

```bash
BWAT_DB_URL=postgres://bwat_runtime:...@127.0.0.1:5432/bwat npm run fleet-credential -- --label fleet-a
docker compose exec backend node dist/scripts/fleet-credential.js --label fleet-a   # in the local stack
```

The bot side reads it as `BWAT_FLEET_CREDENTIAL` (the secrets contract); the setup script
stores it there, in the same store as the other startup secrets. The backend never reads
that variable: it keeps only the credential's sha256.

The card service has its own credential (`bwc_`), issued the same way and printed once;
it reads `GET /fleet` with the feed fields and `GET /meetings/{meetingId}/transcript` for
any meeting, asks who a board's bearer is with `POST /card-service/person` (see Members),
and every other route answers it `401`:

```bash
BWAT_DB_URL=postgres://bwat_runtime:...@127.0.0.1:5432/bwat npm run cards-credential -- --label cards
docker compose exec backend node dist/scripts/cards-credential.js --label cards   # in the local stack
```

The card service reads it as `BWAT_CARDS_CREDENTIAL`.

The onboarding page (`./bwat setup --web`, `setup/onboard`) has its own credential
(`bwi_`), which it mints the same way once setup has started bwat and keeps in
`.bwat/onboard/state.json`. It lapses 30 days after it is made, or when revoked, and
reaches only the `/install` routes; every other route answers it `401`:

| Route | Who | What |
|---|---|---|
| `GET /install/status` | the onboarding page's credential | `{"owner_signed_in", "zoom": {"ready", "problems"}, "meeting_transcribed", "cards"}`: the facts the page's checks tick its steps from. `zoom` is the auto-join readiness check; `cards` is how many cards the card service has written (`GET /v1/card-count`), `null` without a card service. No secret value, name or meeting content |
| `POST /install/revoke` | the onboarding page's credential | Revokes that credential (`204`): the page does it when its installer deletes the page's records. Every route then answers it `401` |
| `PUT /install/checklist` | the onboarding page's credential | `{"items": [{"id", "title", "detail", "link"}]}`, at most 100: the page's steps still open, which replace the admin panel's "Finish setting up" list (`bwat.setup_checklist_items`, migration 0040); an item already ticked keeps its tick. `204`; `400 invalid_body` for an id outside `[a-z0-9-]{1,64}`, a repeated id, a title outside 1 to 200 characters, a detail over 2000 or a link that is not `https://` |
| `GET /setup-checklist` | owner or admin | `{"items": [{"id", "title", "detail", "link", "done_at", "done_by"}]}`, in the page's order. A member is `403` |
| `POST /setup-checklist/{id}/done` | owner or admin | Ticks the item off once (a second tick keeps the first's time and member) and audits `setup_checklist.done`; answers the item. `404 unknown_item` |

```bash
docker compose exec backend node dist/scripts/install-credential.js --label onboard   # in the local stack
```

A bot presents it to `/bots/register` and from then on uses its own bot token; its id
comes from that token, never from a request body. People's routes need a signed-in
member (see Identity below). Logs carry event names and ids only: never a link,
meeting number, passcode or briefing.

Every bot call on a claim is fenced by the bot (its token), the claim, the generation the
bot believes it holds, a live state and an unexpired lease; a refusal is `409 stale_claim`.
The claim's row is locked first and the lease judged after, by the clock then: a lock that
changed nothing (another call holding the row) is not a reason to pass a lease that lapsed
while the call waited. A claim past its drain after Zoom's end (`drain_until`, see
`meeting.ended` below) is refused the same way and ends there (`done`, `drain_expired`).
A ready bot neither heard from nor polling for 45 s is never allocated. The server sweeps every
15 s: a lapsed lease is abandoned (`lease_expired`), a drain
past its bound ends the claim (`done`, `drain_expired`; it wins over a lapsed lease), a claim
pending past its bound is refused (`no_bot_available`) or out of attempts
(`allocations_exhausted`), then allocation re-runs. A bot is busy while it holds a live
claim; GET /fleet derives that from the claim. The `BusyProtection` seam (`src/busy.ts`) is
told when a bot gets a claim and when it lets go, best effort and after commit; the default
does nothing, and with the fleet on it protects the bot's ECS task at once.

### The fleet (hosted on ECS)

With `BWAT_FLEET_AUTOSCALE` set, the backend sizes the bot service and protects busy bots
from scale-in (`src/fleet.ts`). Unset, nothing runs and the ECS SDK is never loaded: a
self-hosted install runs the bots it starts (`docker compose up --scale bot-zoom=N`).

Every minute one pass (under an advisory lock, so two backends never both act):

- wants `live + waiting + headroom` bots, within the bounds: `live` is meetings held under a
  running lease, `waiting` pending ones allocation would still place;
- protects each bot in a meeting (or still in its room by its own report) for 240 minutes,
  long enough to outlast a deploy, during which ECS refuses renewals;
- scales out at once, and scales in one bot at a time once demand has been lower for 10
  minutes: the oldest idle bot is drained (allocation skips it), every other idle bot is
  protected for 5 minutes, all of it is read back, and only then is the victim's protection
  cleared and the count lowered. Any doubt cancels the decrease, and none happens while a
  stop is in flight or while a live bot sent no task ARN on register;
- logs `fleet.reconcile` with what it saw and did (`error` when a busy task is left
  unprotected or its renewal was refused).

| Variable | What | Default |
|---|---|---|
| `BWAT_FLEET_AUTOSCALE` | `off`; `dryrun` reads the service's count and logs what it would do, writing nothing; `on` protects tasks and sets the count. Anything else stops the server starting | `off` |
| `BWAT_FLEET_CLUSTER`, `BWAT_FLEET_SERVICE` | The ECS cluster and bot service; required unless `off` | |
| `BWAT_FLEET_MIN`, `BWAT_FLEET_MAX` | Bounds of the bot count; the max is at most 10, the most tasks one ECS protection call takes | `1`, `2` |
| `BWAT_FLEET_HEADROOM` | Idle bots kept beyond demand, so a new meeting finds one ready | `1` |

The backend's task role needs `ecs:DescribeServices` and `ecs:UpdateService` on the service,
and `ecs:UpdateTaskProtection` and `ecs:GetTaskProtection` on the cluster's tasks.

With the fleet on, the backend owns the bot service's count: its next pass undoes a count
set by hand. To park the bots, set `BWAT_FLEET_MAX` to 0 (or the fleet off) first;
`BWAT_FLEET_MIN` at 0 is not enough, because the headroom still wants a bot.

### The transcript epoch

The epoch is per occurrence. Before the claim names its
occurrence, a heartbeat's `transcript_epoch` is claim-local and stored as sent. After it:

- the claim's current epoch is accepted;
- an epoch above the occurrence's highest (`occurrence_epochs`, migration 0003) is accepted
  and raises both;
- anything else is `409 stale_epoch`, and the lease is not renewed.

The epoch is at most 1000000 (`MAX_TRANSCRIPT_EPOCH`); a higher one is `400 invalid_body`,
and the lease is not renewed. Epochs only rise per occurrence, so once an occurrence has
accepted 1000000 no later holder can declare a higher one: its beats with an epoch are
`409 stale_epoch` until its lease lapses. The bound sits far below the column's int4
ceiling, so raising it needs no migration.

A new claim, and a claim requeued or retried for another bot, starts with no epoch, so a new
holder, or a restarted bot on a new claim, cannot reuse one. A bot that restarts and gets its
old claim back from GET /assignment (same `claim_id` and `generation`, lease still live) is
not told apart from the process before it: re-declaring the claim's current epoch is
accepted. So after any process restart the bot must declare the claim view's
`transcript_epoch + 1` (or `0` when it is `null`) before it pushes, even on its old claim.
On promotion, an epoch declared earlier is kept only if it is above the occurrence's highest. `claims.transcript_epoch` is the epoch the
transcript push accepts; while it is `null` the push takes nothing.

### Release reasons

`reason` is a machine code: any `^[a-z][a-z0-9_]*$` up to 64 characters is accepted and
stored, including codes not listed here (a failed placement's in `last_placement_failure`,
anything else in `refused_reason`; a `requeue` ignores it). It is never logged. The bot
sends one of:

| Group | Reasons |
|---|---|
| Join | `waiting_for_host_timeout`, `waiting_room_timeout`, `unable_to_connect`, `obf_user_not_in_meeting`, `app_cannot_join_external`, `app_cannot_join_anonymously`, `zoom_join_failed`, `sdk_auth_failed`, `meeting_ended_before_join` |
| Recording | `recording_denied`, `recording_request_timeout`, `recording_not_grantable` |
| Normal | `meeting_ended`, `left_alone` (everyone else left; its final push, `complete: true`, already ended the meeting), `idle` (nothing said for the admin's `idle_leave_min`; people may still be in the meeting, so its final push is not `complete` and Zoom's `meeting.ended` ends it), `recalled`, `removed_by_host`, `stale_claim`, `occurrence_conflict` (Zoom reported a different occurrence from the claim's; the bot may be in one still running), `authorized_user_left` and `zoom_end_unknown` (Zoom took the bot out of the meeting for a reason that does not say the meeting is over; Zoom's `meeting.ended` ends it) |

What the backend does with a release, first match wins:

1. `requeue: true` (only for a bot being stopped mid-meeting: a deploy or scale-in): the
   claim is pending again with the next generation, the stopping bot is withdrawn (not
   ready), and the placement does **not** count toward the attempt cap. The reason is
   ignored. Answers `requeued`.
2. `meeting_ended: true`: `done`, with the reason, and the meeting's tombstone. Answers
   `released`. `requeue` and `meeting_ended` together are `400`.
3. A failed placement: `waiting_for_host_timeout`, `waiting_room_timeout`,
   `unable_to_connect`, `sdk_auth_failed` or `obf_user_not_in_meeting`. The backend
   requeues it: pending again for another bot, the next generation and a fresh pending
   bound. The attempt **does** count, so a claim already allocated `MAX_ALLOCATIONS` (3)
   times is abandoned as `allocations_exhausted` instead (answers `released`). The bot
   stays ready but goes to the back of the queue, so another ready bot is tried first;
   a lone bot is retried. Answers `requeued`. Either way the reason is kept in
   `last_placement_failure`, so an exhausted claim still shows whether its last attempt
   failed on the bot (`sdk_auth_failed`) or on the meeting (`waiting_room_timeout`).
4. Anything else: `done`, with the reason. Answers `released`.

Whether an occurrence's meeting has ended has one answer (`meetingEnded` in
`src/claims.ts`), read in two places: a bot reporting an occurrence (`409
meeting_already_ended`, its claim ended) and a Zoom start (no claim opens; see Zoom webhooks
below). Its record is a claim with `meeting_ended_at`, set the same way by a bot's
`meeting_ended` release and by Zoom's `meeting.ended` releasing a pending claim, or, for
every end Zoom reported, a `bwat.zoom_ended_occurrences` row, or, for a deleted meeting,
its occurrence in `bwat.deleted_occurrences` (the deletion fence: see Retention and
deletes), or, for a meeting whose transcript retention expired, its `transcript_expired_at`. Zoom's end leaves a held claim live: the meeting has ended, but its bot is
still draining its transcript, and ends the claim itself (`meeting_ended`), by its lease
lapsing, or by its drain running out (300 s, `drain_expired`). `POST
/allocations` carries no occurrence, so a person's send into an ended occurrence still
sends a bot, which is turned back once it reports where it is.

## Identity

The backend is the system of record for who is a member (D141). One company per install
(D140); roles are `owner`, `admin` and `member`.

A person signs in by sending a Google ID token as `Authorization: Bearer <id token>`. It
is verified locally: RS256 against Google's published keys (fetched, cached for the
max-age Google sends, at most 6 hours, and refetched at most once a minute when a token
names an unknown key; a failed fetch fails the sign-in, and the next one asks again), issuer `accounts.google.com` (either spelling Google issues, with
or without `https://`), audience one of
`BWAT_GOOGLE_CLIENT_IDS` (comma-separated OAuth client ids), not expired,
`email_verified`, and a non-empty `sub` (Google's stable id for the account). The token must come from an allowed Google Workspace domain (D146):
its `hd` claim, lower-cased, must be one of `BWAT_ALLOWED_DOMAINS` (comma-separated), or of
the list an admin saved in the panel over it (`PUT /console/google-signin/domains`, read at each
sign-in through a 15-second cache), and the email's domain must equal it. A consumer account (no `hd`) or any other domain gets
`401`. With `BWAT_ALLOWED_DOMAINS` unset and no list saved, every Google sign-in is refused, the backend never
calls Google, and the startup log says so (`auth.allowed_domains_unset`). With
`BWAT_GOOGLE_CLIENT_IDS` unset, Google sign-in is off. Both are required when
`NODE_ENV=production` (every deployed image): startup refuses without either, since Google is
a deployed install's only sign-in, except on a local install (below). `BWAT_GOOGLE_CLIENT_IDS`
carries the web client and the plugin's Desktop client.

**A local install signs in with its code, not Google** (D202, QOR-5007). `BWAT_TIER` is the
install's tier: `local`, `team`, `zoom-board` or `production` (unset on an install made before
tiers; `t0`, the local tier's old name, is read as `local`). With `BWAT_TIER=local` the backend starts without Google and needs
`BWAT_SIGNIN_CODE_SHA256`, the sha256 (64 hex) of the install's code as typed in capitals
with only letters and digits; `./bwat setup` makes the code, shows it once, and stores only
this. Startup refuses the code with any Google setting, and on any other tier. On a local install:

| Route | Does |
|---|---|
| `POST /code-signin {code, email}` | The code (any case, dashes and spaces ignored) and any email sign in as the member at that email, made the first time and marked joined by code. `BWAT_FIRST_OWNER_EMAIL` claims the owner (with none named, the first sign-in of an unowned install does). Answers `{token, expires_at, refresh_token, member}`: a board token (`bwz_`, 12 hours) and a refresh token (`bwr_`). A wrong code is `401 wrong_code`, counted against the sign-in limit; a bad email `400 bad_email`; a removed email `403 removed`. |
| `POST /code-signin/refresh {refresh_token}` | A new board token for a session made with the current code; else `401 signed_out`. |
| `POST /code-signin/sign-out {refresh_token}` | Ends the session (`204`). |

Whoever holds the code is trusted with every account: that is the local tier's bargain. A new code
(`./bwat setup --new-code`) ends every session and board token of the old one. On every other
tier these routes are `404`, a code's board tokens sign nobody in, and at startup every member
who joined by code is removed as Settings, People removes someone (owners and
`BWAT_FIRST_OWNER_EMAIL` kept; invited and Google members are never joined by code), once.
`GET /auth/desktop-client` adds `code_signin`, `true` on a local install, so the plugin's `/bwat:login` knows.

**The plugin's Desktop client.** `GET /auth/desktop-client` answers `{client_id, client_secret, code_signin}`
from `BWAT_GOOGLE_DESKTOP_CLIENT_ID` and `BWAT_GOOGLE_DESKTOP_CLIENT_SECRET` (both `null` when
unset), with no sign-in, so the plugin's `/bwat:login` needs nothing typed. Google treats an
installed app's client secret as public; PKCE protects the sign-in. The Desktop client's id
must also be in `BWAT_GOOGLE_CLIENT_IDS`.

**A member is bound to a Google account, not an email.** An admin invites an email; the
first sign-in with it binds the member to that token's `sub` and activates it (audited as
`member.activated`, by id only). From then on the member is that Google account: found by
its `sub` even if its email changed (the stored email is kept), while the same address
from another Google account (a reassigned Workspace address) gets `401` and inherits
nothing (logged as `auth.subject_mismatch`). Neither the `sub` nor the email is ever
answered, audited or logged.

**While the install has no activated owner, the first verified sign-in from an allowed
domain becomes its owner** (D149), joining as one or promoting an existing membership,
bound and activated, exactly once however many arrive together (audited as
`member.owner_claimed`). An owner nobody has signed in as yet does not count, so it can
never block that recovery. There is no operator invite (D108's is retired).

**`BWAT_FIRST_OWNER_EMAIL` names who may claim it** (optional, plain env, QOR-4749). Set,
only a verified sign-in with that email (trimmed, any case) claims the owner; anyone else
from an allowed domain who signs in first joins as a `member` (or activates their invite)
as on an owned install, and gets `403 not_onboarded` until that person has signed in.
Once an activated owner exists it has no effect. Startup refuses a value that is not one
email address, or whose domain is not in `BWAT_ALLOWED_DOMAINS`. Unset, the first sign-in
from an allowed domain claims the owner, as above: anyone at the company who reaches the
address first. It is not required in production, since the self-host installer does not
set it (there, sign in before sharing the address); a hosted install should set it.
**Once an activated owner exists, anyone else from an allowed domain
joins as a `member` on their first sign-in** (bound and activated, audited as
`member.joined`, by id only). An invite is not needed to get in: it sets a person's role
and name before they first sign in, and it is how an admin lets a removed person back in.
A first sign-in takes the members lock once; a member's later sign-ins, and a reassigned
address's refusal, never do.

**Removing a member revokes their access by email, and by Google account if they had
signed in.** Both are kept in `bwat.removed_members`, and a request by either gets `401`
(logged as `auth.removed`) instead of joining again, until an admin invites that email
again. Every request is checked this way, so a removed member's open board stops working
at once. A removed person who never signed in is blocked only by that exact email.

**The panel stays closed until onboarding:** while the install has no activated owner,
every people's route but `GET /me` answers `403 {"error": "not_onboarded"}`.

`BWAT_DEV_PERSON_TOKEN` (local stacks only; refused unless `NODE_ENV` is `development` or `test`) signs in
as a dev member, `dev-person@bwat.invalid`, created (activated, never bound to a Google
account) the first time it is used: as owner on a stack with no activated owner, else as a
plain `member` (it never makes a second owner). So on a
stack where the dev token came first, a later Google sign-in is not made owner (invite it
first); on one a Google sign-in already owns, the dev member is a plain member until that
owner makes it an admin. It can never be made owner: its domain is never allowed.

`BWAT_TEST_PEOPLE` (local and test stacks only) adds more stand-ins, for tests that need
several people, such as one member reading another's inbox:

```
BWAT_TEST_PEOPLE=carol:owner:<token>,alice:member:<token>,bob:member:<token>
```

- Each entry is `name:role:token`: a name matching `^[a-z][a-z0-9-]{0,31}$`, a role of
  `owner`, `admin` or `member`, and a token of 32 or more characters from `[A-Za-z0-9._~-]`.
  Entries are comma-separated.
- `Authorization: Bearer <token>` signs in as the member `<name>@test.bwat.invalid`, created
  the first time it is used (under the members lock, so racing first uses make one), in the
  entry's role, activated (as the dev member is), audited as `member.test_member_created`.
- An owner entry is an activated owner from its first sign-in, so it onboards a fresh stack
  (D149), and it is made owner even on a stack someone else already owns: unlike the dev
  member, a test stack may have several owners. Its domain is never allowed, so no test
  member can be made owner through the API.
- Once the member exists its **stored role wins**: if a test changed it through the API, a
  later sign-in keeps that role, not the entry's.
- Startup is refused unless `NODE_ENV` is `development` or `test` when it is set at all, when an entry is
  malformed, and when a name or a token repeats (the dev token included). The error names
  the entry's position, never its text. A stack that has it logs `auth.test_people_on` with
  the count, once at startup.
- Tokens are kept only as SHA-256 digests, compared in constant time, and never logged or
  written to the database.

The tokens are checked in this order: the dev token, then the test people, then Google.
Both local kinds are a digest comparison that needs nothing from Google, so they never wait
on, or fail with, a fetch of Google's keys; and a token listed locally means that person
even if it also happens to be a valid Google ID token. The dev token and a test token can
never be the same (startup refuses it), so their order is only the order of the checks.

| Route | Who | What |
|---|---|---|
| `GET /me` | any member | `{"id", "email", "display_name", "role"}` of the signed-in member; open before onboarding |
| `POST /card-service/person` | the card-service credential | `{"bearer", "client_ip"}`: the bearer a board sent the card service and the client address it saw. `200 {"person": ...}` with exactly what `GET /me` answers for that bearer, or `{"person": null}` when it signs nobody in; open before onboarding. A failed sign-in is counted against `client_ip`, never the card service's own address, and `429 rate_limited` once that address has spent its failures (QOR-4749). `client_ip` is trusted on this route only |
| `GET /me/connections` | any member | `{"claude_session", "zoom"}`: whether the signed-in member has a live Claude session (the session registry's rule) and has linked their Zoom login; the board's banner names each one that is `false` |
| `GET /members` | any member | `{"members": [...]}`, by email |
| `POST /members` | admin | `{"email", "display_name"?, "role"?}`: `201` with the member; `409 member_exists`, `409 domain_not_allowed` |
| `PATCH /members/{id}` | admin | `{"role"}`: `200`; `409 last_owner`, `409 domain_not_allowed` (to `owner`) |
| `DELETE /members/{id}` | admin | `204`; `409 last_owner` |

Admin means `owner` or `admin`; granting, removing or taking away ownership needs an
owner (`403 owner_required`). Only an email in the allowed domains (the saved list, else `BWAT_ALLOWED_DOMAINS`) is invited, in any
role, or made owner (`409 domain_not_allowed`): no other could ever sign in (D146), so with
none allowed every invite is refused. An owner is demoted or removed only while another
**activated** owner remains (`409 last_owner`): an owner invited but never signed in is no
successor. So an owner who can sign in (and so an admin) always exists. Every change is checked and made under one
lock, and written to `bwat.audit` (append-only: the runtime role can only read and
insert) with who, what, which member, and the role, never an
email or a name. Logs carry event names and member ids only.

## Zoom webhooks and auto-join

`POST /v1/callbacks/zoom/events` takes the Zoom app's webhook deliveries (the contract path,
under the `/v1` base; the old `/zoom/events` and `/callbacks/zoom/events` answer `404`). The
signature covers the timestamp and body, never the path, so the prefix changes nothing in it. It is public, so every
delivery is verified before it is read: `x-zm-signature` must be `v0=` and the hex
HMAC-SHA256 of `v0:{x-zm-request-timestamp}:{raw body}` under the app's secret token,
and the timestamp within 5 minutes of ours (`401` otherwise; `503 not_configured`
without a secret, `503 secret_unavailable` when the secret store cannot be read). A
delivery with no signature or timestamp, a signature not shaped `v0=` and 64 hex digits,
or a timestamp outside the window is refused `401` before the secret store is asked.
`endpoint.url_validation` is answered with the plain token and its HMAC. Each answer is `200 {"status": <outcome>}`. A delivery that changes something
(a start or arrival auto-join acts on, any end) is handled once: its body's sha256 is
recorded in the same transaction as the change, so a re-delivery answers
`{"status":"duplicate"}`, and one whose handling fails or crashes leaves no record and
Zoom's retry is acted on. A delivery that never reaches the claim store (an ignored
type, auto-join or the switch off, waiting for the host or not the host, stale) is not
recorded. These delivery records are swept after a day.

| Event | What happens |
|---|---|
| `meeting.started` | Auto-join opens a claim for the occurrence and offers it to a ready bot, unless auto-join is off, the host must be present, the occurrence already ended (or its claim ended in any way, released or abandoned), Zoom/fleet readiness fails or the meeting cannot be looked up (see Readiness gate below), or the event is over 10 minutes old. A claim already open with no occurrence (a person's send) is stamped with this one by the same locked transition as a bot's occurrence report, epoch rules included, with no lookup (nobody new joins); one a bot already reported another occurrence for is left alone |
| `meeting.participant_joined` | When the host must be present: the host arriving (their Zoom user id, `participant_user_id` or the deprecated `id`, is the meeting's `host_id`) opens the claim; after 4 minutes anyone arriving does. Arrivals before that, while the stored switch is on, keep their speaker identity for the claim to come (docs/speaker-identity.md). Any arrival naming both `participant_user_id` and `email` links that Zoom account to the member with that email, in an allowed domain, once they have signed in and the S2S app's `GET /users/{participant_user_id}` answers the same email on the install's own account, whatever auto-join says. That runs after the answer and never fails the delivery; a conflict or an unconfirmed email links nobody (`zoom.email_link`, docs/speaker-identity.md). A link grants board sign-in as that member, as pairing does |
| `meeting.ended` | Always records the occurrence as ended (`bwat.zoom_ended_occurrences`), whatever auto-join says and whether or not a claim is open, and releases the pending claims that name that occurrence as a bot's `meeting_ended` release does (`done`, `meeting_ended`, `meeting_ended_at`): they have no bot to drain. A held claim (`claimed`, `attending`) on the occurrence stays live: its bot sees the end through the Zoom SDK, pushes its final batch with `complete: true`, then releases with `meeting_ended`; its heartbeats and pushes keep working until then, and a bot that never does loses the claim when its lease lapses (within 90 s). The drain is bounded: the end sets `drain_until`, 300 s from the first end recorded (a later end never extends it), on each held claim on the occurrence; past it the bot's next heartbeat, push, occurrence report or release is `409 stale_claim` and ends the claim (`done`, `drain_expired`), and the sweep retires it if the bot says nothing, so a bot that heartbeats without completing cannot hold an ended occurrence `live`. Answers `released` when it released a pending claim, else `tombstoned` (or `already_ended`). A claim not yet promoted is left open: it may be in the meeting's next sitting, and if its bot is in the ended one, its occurrence report is refused `409 meeting_already_ended` and the claim ends. An end naming no occurrence is ignored. The record is kept as long as the meeting's transcripts (only the retention job prunes it, with the transcript retention days), so neither a late start nor a bot's occurrence report can ever reopen the occurrence; while keep forever is on, the record is still pruned on the window (D168) and the transcript never expires, so past the window that guarantee holds only if a claim recorded the end (see Retention and deletes) |

| Variable | Meaning |
|---|---|
| `BWAT_ZOOM_WEBHOOK_SECRET` | The Zoom app's secret token: the env fallback for the tier-2 secret `zoom.webhook_secret` |
| `BWAT_AUTO_JOIN` | The deployment's ceiling: auto-join never happens when it is `false`, `0`, `no`, `off`, `n` or `disabled`. Anything else, unset included, leaves it to the stored switch |
| `BWAT_AUTO_JOIN_REQUIRE_HOST` | The ceiling of waiting for the host, same spellings: off joins on `meeting.started` whatever is stored; on (default) leaves it to the stored `auto_join_require_host` |

The webhook secret is read by its tier-2 name, `zoom.webhook_secret`, through a
`getSecret(name)` seam (`buildServer({ getSecret })`), on every delivery so a rotated
secret is used at once. The server's seam is the secret store's `get` (D142; see Secrets
below): a stored `zoom.webhook_secret` wins, and `BWAT_ZOOM_WEBHOOK_SECRET` (or its
`_FILE` form), read once at startup, answers while none is stored.

Under the environment ceiling, `auto_join_enabled` defaults on when absent or reset
to JSON null. Explicit false stays off; malformed values fail closed. The backend
reads raw settings and caches the initial preference for at most 60 seconds. A save
invalidates this cache, and a fresh read immediately before claiming catches an off
choice made while Zoom was answering, including a save on another backend process.
The existing `auto_join_require_host` setting still controls whether the bot waits
for the host; the environment remains its ceiling.

- **Readiness gate.** Automatic joining covers every meeting in the configured Zoom
  account, regardless of `settings.auto_recording`. Before creating a claim, bwat
  requires main app SDK credentials, the webhook secret, an accepted S2S grant with
  meeting lookup and local recording token scopes, a fresh ready bot (busy is okay),
  and a verified meeting event under the current webhook secret and Zoom account.
  URL validation does not count. Evidence is recorded before handling the first
  qualifying event, so that event can trigger joining. Missing configuration,
  inaccessible secrets, failed grants, or wrong-account events open no new claim.
  A secret rotation invalidates the previous delivery evidence. Grant checks reuse
  the credential-bound OAuth cache; they run after the webhook response, never while
  a settings write transaction is open. Changed credentials during lookup block the claim.
  Failed readiness does not queue or replay the event after recovery. A later qualifying
  event can retry; with host-waiting disabled, participant arrivals are ignored, so a
  skipped start needs a new start event or a manual invitation.
- **Settings.** `/console/settings` reports requested, ready and effective states,
  actionable problems, and the last verified meeting-event timestamp. No credential
  fingerprint or secret is returned. Explicit enabling or resetting to the on default
  validates prerequisites first; disabling always saves even during a Zoom outage.
  SDK presence is not proof of SDK authentication, and a past event is not proof that
  every required subscription remains enabled. The admin panel says both plainly.
- **Passcode.** Zoom's events carry no passcode, so the claim takes the one in the same
  lookup's answer (its `password`; none when it has none), stored as a person's send
  stores one: in the claim's `briefing`.
- **Scheduled end.** For a one-off meeting (Zoom type 2) or a recurring one at a fixed
  time (type 8), the event's `start_time` plus its scheduled `duration` goes in the
  claim's `briefing` as `scheduled_end` (ISO 8601, UTC); it times the bot's five-minute
  warning and its time-up post. Any other meeting type has none, and gets no timed posts.
  The start is when the host actually started, so an early or late start moves the end
  with it. A meeting a person sends bwat to by link takes its end from Zoom's meeting
  record instead (`GET /meetings/{id}`, same types): the booked start plus the duration,
  and for type 8 the occurrence in progress or the next to start, never the series start.
  A sitting that starts more than 15 minutes after the send has no end: a wrong end is
  worse than none.
  That lookup never decides whether bwat goes: when Zoom cannot be asked (no S2S app, an
  outage), the send goes ahead with no end (`allocation.schedule_unknown`, a code only).
  An invitation from inside Zoom's app gets no end.
- **The lookup.** With all three `zoom.s2s_*` secrets set, the delivery answers
  `{"status":"meeting_lookup"}` at once and the lookup runs after the answer, because Zoom
  wants an answer within three seconds and a cold lookup is two calls to Zoom (a token,
  then the meeting); a lookup cut short to fit would skip the meeting for good, as the
  delivery is already recorded. It then opens the claim exactly as a start does (the
  meeting's lock, the ended check, the occurrence stamp), under a key derived from the
  delivery's, so a start is acted on once; a meeting that ended meanwhile gets no claim.
  A Zoom failure that may pass (no answer, a 429, a 5xx) is asked again once, 1 s later
  (or after Zoom's `Retry-After`, at most 5 s); a 404 is not. One lookup per occurrence
  runs at a time, and a final no (404) is kept for that
  occurrence for 60 s (at most 1000 occurrences, oldest dropped first); a failure that may
  pass is never kept. The meeting's next occurrence is always looked up afresh (the host
  may have changed the meeting), and a start or arrival that names no occurrence is never
  held back. A start or arrival
  meanwhile answers `{"status":"lookup_in_flight"}` or `{"status":"lookup_cached"}` and
  asks Zoom nothing. Each lookup logs `zoom.meeting_lookup` with its outcome
  (`claim_opened`, `already_claimed`, `already_ended`, `not_ready`, `switched_off`, `configuration_changed`,
  `recording_unknown`, `not_configured`, `zoom_unavailable` with Zoom's status, at WARN
  when it may pass, `secret_unavailable`, `failed`) and never the passcode or other
  meeting content. A lookup still running when the server stops is waited for; one lost
  to a crash is not retried.
- **A person's send** (`POST /v1/allocations`) is not gated (QOR-4608, D71): pasting a
  link is the explicit invite, so the send goes ahead whatever the meeting's recording
  setting and asks Zoom nothing. Only auto-join needs Zoom to say the meeting records.
- **Alternative hosts.** Only the meeting's `host_id` counts as the host. Alternative
  hosts are named by email, which needs the Zoom API, so a meeting run by one waits the
  full 4 minutes before bwat joins.

`docker-compose.yml` passes the three variables from `.env` (empty by default: no
secret, so Zoom is refused; both switches on). `scripts/smoke-zoom.sh` recreates the
backend with its own secret to test the stack. On this base it checks that auto-join
opens nothing (the stored switch is unset) and that ends still release.

### The board's meeting bot (`POST /v1/zoom/meeting-bot`)

It takes `{context, invite?: boolean, leave?: boolean, participant_id?: string}`.
`participant_id` (Zoom's per-meeting id for the viewer) records the viewer's speaker identity for an attended occurrence (docs/speaker-identity.md).
The fresh, sealed Zoom context must match the signed-in, active member. Status reads
return only this occurrence's bot state and `can_invite` (with `joined_at` once the bot is
`present`: when it first reported it was in); `invite: true` resolves join
details through the S2S meeting API and uses the shared allocator. Passcodes never
leave the backend in this response. Breakout rooms and ended/deleted meetings cannot
be invited. `leave: true` requires an administrator/owner or the current meeting host
with a signed context issued within 30 seconds. `invite` and `leave` cannot both be true.
Status also returns `can_leave`.

## Zoom tokens (bot)

`POST /v1/assignment/join-token`, with the bot's token and `{"claim_id", "generation"}`,
answers what the bot needs to join and record its claim's meeting, so the bot holds no
Zoom app secret:

```json
{
  "sdk_jwt": "eyJ...",
  "sdk_jwt_expires_at": "2026-10-02T12:30:00.000Z",
  "recording_token": "...",
  "recording_token_expires_at": "2026-10-02T12:02:00.000Z"
}
```

- `sdk_jwt`: a Meeting SDK JWT ([Meeting SDK auth](https://developers.zoom.us/docs/meeting-sdk/auth/),
  [sample JWT](https://developers.zoom.us/blog/create-sample-jwt-meeting-sdk/)), HS256 under
  `zoom.client_secret`, with `appKey` and `sdkKey` both `zoom.client_id` (the current name
  and the one native SDKs read), `mn` the claim's meeting number, `role` 0 (participant),
  and `tokenExp` = `exp`. It lasts 1 hour from now (`sdk_jwt_expires_at`): the SDK
  refuses a token with 1800 s or less left (its auth answers 15, SDKERR_INTERNAL_ERROR),
  so it is minted for an hour, and `iat` is back-dated 30 s for clock skew. Ask again for each join.
- `recording_token`: the local-recording join token from the S2S app
  ("Get a meeting's local recording join token" in the [Meetings API reference](https://developers.zoom.us/docs/api/meetings/),
  `GET /meetings/{meetingId}/jointoken/local_recording`; Zoom's `expire_in` is always 120 s,
  so use it at once). When there is none, `recording_token` and its expiry are `null` and
  `recording_token_error` says why (the field is absent when there is a token):
  `not_configured` (the three `zoom.s2s_*` secrets are not all set), `not_found` (Zoom
  answers 404: the meeting is not on the install's Zoom account), `zoom_unavailable` (a
  network error, no answer within 5 s, the token endpoint refusing, or another API error;
  a missing scope is a 400 from Zoom, so it shows here) or `secret_unavailable` (the S2S
  secrets cannot be read). The call still answers `200` with the SDK JWT: the bot joins
  without a recording token rather than not at all.
- Scope (D105, D118): bwat serves meetings on the install's own Zoom account. A meeting on
  another account is never auto-joined (its lookup fails, so it opens nothing); a person
  can still send bwat to one by link, but it gets no recording token (`not_found`), and
  joining another organisation's meeting needs work this release does not include (OBF,
  D104), so it is not expected to work.

| Answer | When |
|---|---|
| `200` | As above |
| `400 invalid_body` | No usable `claim_id` (uuid) and `generation` |
| `401 unauthorized` | Not a bot token (`409 unregistered_bot` for the fleet credential) |
| `409 stale_claim` | The bot does not hold that generation of a live claim with a running lease (fenced as a heartbeat is; a claim past its drain ends). Checked before any secret is read |
| `503 not_configured` | `zoom.client_id` or `zoom.client_secret` not set |
| `503 secret_unavailable` | The secret store cannot be read for the Zoom app's secrets (the S2S app's are `recording_token_error`) |

The bot asks just before it joins (the recording token lasts two minutes) and again for a
rejoin; it never logs or stores what it gets. Minting the SDK JWT calls nothing, so only
the Zoom app's own secrets can fail the call. A bot that keeps getting `503` cannot join: it releases the claim with `sdk_auth_failed`, which requeues the meeting for
another bot until the allocation cap (see release reasons above).

Every answer carries `Cache-Control: no-store`. The claim is checked in its own short
transaction, which commits before Zoom is called, so no claim row is locked across a call
to Zoom; a lease that lapses in that moment costs nothing, as the next heartbeat evicts the
bot. Logs carry `zoom.join_token` (claim and bot ids, whether a recording token came back,
and `recording_error` with its code when one did not),
`zoom.unavailable` (Zoom's status) and the error codes: never a token, a credential or a
passcode.

**The S2S client** (`src/zoom-api.ts`) is the only Zoom REST client. It asks
`POST https://zoom.us/oauth/token` for an `account_credentials` token
([Server-to-Server OAuth](https://developers.zoom.us/docs/internal-apps/s2s-oauth/)), Basic
auth `zoom.s2s_client_id:zoom.s2s_client_secret` and `account_id` in a form body, as Zoom's
example does, and calls `https://api.zoom.us/v2` with it. The three secrets are read through
the secret store on every call, so a rotation applies at once (a token is kept only for the
credentials it was granted to), and a store that cannot be read fails closed. The token is
kept until 5 minutes before Zoom's `expires_in` (an hour); one request for it is in flight at
a time, and a failed one is not kept. A 401 drops it, so the next call asks for a new one;
the refused call is not retried. Every call is bounded by 5 s. Only a meeting number (9 to 12 digits) is ever put in a
path. One client per server, shared by this route and auto-join's meeting lookup.

**The install's Zoom apps** (how to create them: [Set up Zoom](../docs/onboarding.md#set-up-zoom)): a General app (Meeting SDK) gives `zoom.client_id`
and `zoom.client_secret`; a Server-to-Server OAuth app on the same account gives
`zoom.s2s_account_id`, `zoom.s2s_client_id` and `zoom.s2s_client_secret`, with these scopes:

| Scope (granular, as Zoom's console names them; classic in brackets) | For |
|---|---|
| `meeting:read:local_recording_token:admin` (`meeting_token:read:admin:local_recording`) | The recording token |
| `meeting:read:meeting:admin` (`meeting:read:admin`) | The meeting lookup ("Get a meeting" in the [Meetings API reference](https://developers.zoom.us/docs/api/meetings/): `password`), and the title and host a meeting is listed with (`topic` and `host_email`) |
| `user:read:user:admin` (`user:read:admin`), optional | Confirming a join event's email is the account's own before linking it to a member ("Get a user" in the [Users API reference](https://developers.zoom.us/docs/api/users/): `id`, `account_id`, `email`). Without it nobody is linked by email; pairing remains, and the settings read's `autoJoin.notices` (the admin panel's Zoom account access check) advises adding it, which never makes automatic joining unready |

Without the S2S app the bot joins with no recording token and auto-join joins nothing (it
cannot tell whether a meeting records). Zoom's webhook deadline (three seconds,
[webhooks](https://developers.zoom.us/docs/api/webhooks/)) is why auto-join's lookup runs
after the answer.

## Settings, corrections and model keys

Every route below is a people's route (see Identity): `401` for nobody signed in, `403
not_onboarded` before onboarding. **admin** means the owner or an admin (D141, D149); a
member gets `403 forbidden`. Each admin write (a settings save, a model key's set, remove
or validate) reads the actor's member row again inside its own transaction, `FOR SHARE`:
a role change or removal in flight is waited for, none can start until the write commits,
and an actor no longer an admin gets `403 forbidden` with nothing written.

| Route | Caller | What |
|---|---|---|
| `GET /console/settings` | person | Every catalogue key (`src/settings/catalogue.ts`) with its value (`null` = unset), the `default` that applies while unset, revision, who and when; `settingsVersion`; `canManage` |
| `PUT /console/settings/{section}` | admin | `{"changes": {"<key>": {"value", "expectedRevision"}}}`. Every revision is checked first: one stale key refuses the whole save (`409 stale` with `currentRevisions`). Unset is stored as JSON `null`, never a deleted row |
| `PUT /console/settings` | admin | The same body, with keys of any sections: the admin panel's Save. All of it is stored in one transaction or none of it is: one stale key is `409 stale` with `currentRevisions` for every key sent (the refused are those whose revision differs from the one sent), a bad value or unknown key is `400 invalid_settings` naming each. One `settingsVersion` bump, one audit row per section changed (`settings:<section>`). Answers as `GET`, with `autoJoin` when a `joining` key was sent |
| `GET`, `PUT /console/corrections` | person | The dictionary (`absent`, `cleared`, `set`), conditional on `expectedRevision`; the server stamps a dated `version` (`2026-10-01.2`) on each save |
| `GET /console/cards-model`; `PUT /console/cards-model` | admin, reading included | The card writer's model. `GET`: `{"endpoint": "openrouter"\|"custom", "host", "model", "default", "saved", "elsewhere", "revision", "listed", "paused", "suggestions"}`: the model in use and `BWAT_CARDS_MODEL`; on OpenRouter the pinned suggestions (`src/cards-model.ts`), each priced per million tokens from its public `GET /models` (`price` `null` while that cannot be read, `listed` false), on any other address that endpoint's own `GET /models` under its key, unpriced; `elsewhere` a choice saved for another `BWAT_CARDS_MODEL_URL` (it does not apply); `paused` the card writer's pause on that model (`GET /v1/writer/status` on the card service), else `null`. `PUT {"model", "expectedRevision", "acceptNoZdr"?}`: the endpoint must list the model and one 16-token chat call with the address's key must answer 2xx, else `400 model_refused` with a plain `message`; on OpenRouter a model with no ZDR endpoint is `409 no_zdr` with the warning as `message` until `acceptNoZdr: true`, and an undecided ZDR lookup is refused. Stored as the `cards_model` row (not a catalogue key: `PUT /console/settings` refuses it), `{"model", "base_url", "no_zdr"?}`; one audit row (`settings:cards_model`) when it changed, and a `settingsVersion` bump on every save, so a writer paused on the same model tries again. `409 stale` with `currentRevisions`; `400 invalid_model` for an id that is not 1-200 printable characters. Answers as `GET` |
| `GET /console/model-keys`; `PUT`, `DELETE /console/model-keys/{provider}`; `POST .../validate` | admin, reading included | openai, anthropic, openrouter, cerebras, deepgram (D167: the bot may use Deepgram ASR directly; its key check sends `Authorization: Token`), custom (QOR-4910: the card writer's key for any other `BWAT_CARDS_MODEL_URL` host; its key check is `GET <BWAT_CARDS_MODEL_URL>/models` with the key as a bearer, `unreachable` with nothing sent for an `http:` address; never served to bots). Status only: `set`, `source` (`store`, `env`, or `unavailable` when the store cannot be reached), `last4` (computed here, only for a key of 16+ characters). No route answers or logs a key. A set or remove answers `503 {"error":"not_configured"}` when the store has no key to write with, and `503 {"error":"secret_unavailable"}` when it cannot be reached (validate too); a validate also answers `503 secret_unavailable` when the stored key cannot be read (written under another `BWAT_ENC_KEY`) and no env fallback is set. A validate with no key to check answers `409 not_set`, also on a store with no key to write with. The list never answers 503: a key it cannot ask about shows `source: "unavailable"` |
| `GET /console/secrets`; `PUT`, `DELETE /console/secrets/{name}` | admin, reading included | The Zoom secrets (`zoom.client_id`, `zoom.client_secret`, `zoom.webhook_secret`, `zoom.s2s_account_id`, `zoom.s2s_client_id`, `zoom.s2s_client_secret`) and the shipped plugins' own (their `secrets`, on or off), entered in the panel (D142, D173). `PUT` takes `{"value"}` (1-512 printable characters, no whitespace; else `400 invalid_value`); any other name is `404 unknown_secret`. Status only, as for the model keys: `{name, set, source, last4}`; no route answers or logs a value. Each set or remove is audited (`secret.set`, `secret.removed`). `npm run seed-secrets` still sets them for a scripted install |
| `GET /console/google-signin`; `PUT /console/google-signin/domains` | admin, reading included | How people sign in (QOR-5070). `GET`: `{signIn: "google"\|"code", configured, webClientIds, pluginClient: {id, secret: {set, last4}}, domains: {effective, env, saved, revision, updatedAt}, canEdit}`; the web client's secret is the sign-in server's and never reaches the backend. `PUT` takes `{"domains": [...] \| null, "expectedRevision"}`: 1-50 domains, saved over `BWAT_ALLOWED_DOMAINS` and used by sign-in and invites at once in this process, within 15 seconds in another; `null` goes back to the env. Refused: a list, or a return to the env's, without the saving admin's own email domain (`400 own_domain_missing`) or any activated owner's (`400 owner_locked_out`), a bad list (`400 invalid_domains`), an older revision (`409 stale`), a local install (`409 code_signin`). Audited as `google_signin.domains_updated` |
| `GET`, `PUT`, `DELETE /console/settings/presence-image` | admin, reading included | The picture the bot shows as its video (D196). `PUT` takes the raw picture as the body, `Content-Type: image/png` or `image/jpeg` (any other type is `415`), at most 2 MB (`413 too_large`). The type is read from the magic bytes and the size from the header (PNG IHDR, JPEG frame header), never by decoding: not a PNG or JPEG is `400 not_an_image`, not 16:9 within a height error of 1% of the width (the bot's own rule) is `400 not_16_9`. `DELETE` goes back to the default, the logo the bot ships with. `GET` answers the picture with its type and an `ETag` (its sha256), or `204` while it is the default. One picture per install (`bwat.presence_image`); each upload and removal is audited (`presence_image.set`, `presence_image.removed`) by its sha256, type and size, never its bytes. It does not bump `settingsVersion`: bots read it before each join |
| `GET /bot/settings` | bot token | The dictionary, the served settings that hold a value, `settingsVersion` (read first), and `providerKeys`: the model keys by provider with `X-Bwat-Provider-Keys: memory-only`, `{}` without it. `Cache-Control: no-store`; an `ETag` that, sent back as `If-None-Match` while nothing changed, answers `304` after one query. With keys, the tag also carries a sha256 digest of the keys served (never a key), and the keys are re-read before the `304` is decided |
| `GET /bot/presence-image` | bot token | The uploaded presence picture with its type and `ETag`, `204` while it is the default; `If-None-Match` with the current tag answers `304`. `Cache-Control: no-store`. Read by the bot before each join |
| `GET /cards/settings` | card-service credential | The card writer's model (D179), its card size and Jev's settings: `{"base_url", "model", "api_key", "settings", "settingsVersion", "zdr", "zdr_waived", "jev_api_key"}`. `base_url` is `BWAT_CARDS_MODEL_URL` and `model` is the model an admin saved on `PUT /console/cards-model` while it was saved for that address, else `BWAT_CARDS_MODEL` (their defaults are in `src/routes/cards-settings.ts`); `api_key` is the panel's key for that host (`openrouter.ai`: `provider.openrouter`, `api.openai.com`: `provider.openai`, any other host: `provider.custom` (QOR-4910), with their env fallbacks), `null` for an `http:` address. A custom endpoint gets no ZDR check: the deployer who sets it vouches for its data retention. `settings` holds the card size and the five `jev` section settings, always their effective value (stored, else the default in `src/settings/catalogue.ts`: `cards_granularity` says how many cards the writer makes, `jev_threshold_pct` when the writer starts and `jev_link_threshold_pct` when a card shows Jev's duplicate or related pick); `settingsVersion` is the one `GET /bot/settings` serves. `zdr` is the backend's Zero Data Retention verdicts from OpenRouter's lists: `writer` is `true` for an address that is not `openrouter.ai`, or when at least one of the model's endpoints is on the ZDR list (the writer asks for ZDR routing); `jev` only when every endpoint of `jev_model` is. A verdict is kept per model for an hour, a failed lookup for 30 s, and a failed lookup is `false`. `api_key` is `null` while `zdr.writer` is `false`, except for a model an admin saved past the warning that it has no ZDR endpoint, once OpenRouter has said so (never on a failed lookup): it gets the key with `zdr_waived: true`, and the writer calls it without ZDR routing; `jev_api_key` is the OpenRouter key only while `jev_enabled` and `zdr.jev`, else `null`. A verdict that changes is logged once (`cards_settings.zdr_passed`, `cards_settings.zdr_waived`, `cards_settings.zdr_refused`). `Cache-Control: no-store`; an `ETag` over the version and a digest of the whole body (never a key), which sent back as `If-None-Match` while nothing changed answers `304`. The keys are never logged. `503 {"error":"secret_unavailable"}` while the key store cannot be read. A person or a bot token is `401` |

Every change the bots must pick up (a setting, the dictionary, a model key) bumps
`settingsVersion` and writes a row to `bwat.audit` (`target_type` names what changed:
`settings:<section>`, `dictionary`, `model_key:<provider>`, `secrets`; never a secret or
the dictionary's words), in one transaction under the settings lock; whether a key was
already stored is read under that lock too. A secret on the local store is written in
the transaction. On Secrets Manager it is written last, after the bump and the audit: a
failed bump or audit writes nothing there, and a failed write rolls them back. The one
window left is a COMMIT that fails after Secrets Manager took the write: the key
changed with no audit row and no bump. `GET /bot/settings` re-reads the model keys
once the settings version moves or once they are 60 s old, whichever is first, and tags them by digest: a key that changed without a
bump (that failed COMMIT, a stale Secrets Manager read just after a write, an env key
rotated across a restart) reaches the bots within that bound under a new `ETag`. It
sends no `ETag` when a model key could not be read, so the bot's next poll is answered
in full.

### Secrets

**Tier 2** lives in the secret store (D142) and nowhere else. The store accepts exactly
these names and refuses any other, a startup `BWAT_*` name above all:
`provider.openrouter`, `provider.anthropic`, `provider.openai`, `provider.cerebras`,
`provider.deepgram`, `provider.custom`, `zoom.client_id`, `zoom.client_secret`, `zoom.webhook_secret`,
`zoom.board_client_secret`, `zoom.s2s_account_id`, `zoom.s2s_client_id`, `zoom.s2s_client_secret`, and the shipped
plugins' own (their `secrets` and `retiredSecrets`, Plugins below).

- `BWAT_SECRET_STORE=local` (default): AES-256-GCM in `bwat.secrets` (`pk1:` envelope)
  under `BWAT_ENC_KEY`, the secret's name as associated data. Without `BWAT_ENC_KEY` the
  server still starts and saves answer `503 {"error":"not_configured"}`.
- `BWAT_SECRET_STORE=aws`: Secrets Manager, each secret at `<BWAT_SECRET_PREFIX><name>`.
  Without `BWAT_SECRET_PREFIX` the server refuses to start. Saving a secret not created in
  advance, such as `provider.custom`, needs `secretsmanager:CreateSecret` on the backend's role.
- A stored value overrides the env fallback (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY`, `DEEPGRAM_API_KEY`, `CUSTOM_MODEL_API_KEY` for the model keys, `BWAT_ZOOM_WEBHOOK_SECRET`
  for `zoom.webhook_secret`, each also as `*_FILE`); a model key's `source` says which
  is in use. The env stands in only when the store says nothing is stored, never when
  it cannot be read: the env may hold a value since rotated away. A Zoom delivery then
  answers `503 {"error":"secret_unavailable"}`, `GET /bot/settings` leaves that model key
  out (the bot uses its own env), and the panel shows `source: "unavailable"`.

**Tier 1** (startup secrets) is resolved once, first, by one resolver (`startupEnv`)
before anything checks it, as `NAME_FILE` > `NAME` > Secrets Manager at `<prefix><NAME>`
(aws only): `BWAT_DB_URL`, `BWAT_ENC_KEY`, `BWAT_FEED_KEY`, `BWAT_GOOGLE_CLIENT_IDS` and
`BWAT_ALLOWED_DOMAINS` by the server; `BWAT_OWNER_DB_URL` by `npm run migrate`;
`BWAT_DB_URL` and `BWAT_ENC_KEY` by `npm run seed-secrets`; `BWAT_DB_URL` by
`fleet-credential`, `cards-credential`, `retention` and `delete-meeting`. `BWAT_ENC_KEY`
keys the local store only, so it is never read from Secrets Manager, and never written
to the database. In aws mode without `BWAT_SECRET_PREFIX` every one of them refuses to
start. The model-key fallbacks above are read as `NAME_FILE` > `NAME`;
`BWAT_DEV_PERSON_TOKEN` (local stacks only) as `NAME` alone. A name set in more than
one place is logged once as `config.secret_precedence`, naming the winner, never the
value. The AWS SDK is loaded only in aws mode, so `npm run migrate` on a local install
never loads it. Not read by the backend: `BWAT_SESSION_SECRET`, `BWAT_GOOGLE_CLIENT_SECRET`.
`BWAT_PUBLIC_URL` is read only to link the board from a card hand-off's message.

To import tier-2 secrets once (the setup script does this on first start):

```bash
(umask 077; echo '{"provider.openai": "sk-...", "zoom.webhook_secret": "..."}' > secrets.json)   # mode 600
npm run seed-secrets -- secrets.json            # stores them, then deletes secrets.json
npm run seed-secrets -- secrets.json --force    # also overwrites values already stored
printf '%s' "$SECRETS_JSON" | npm run seed-secrets -- -   # `-`: reads stdin, never on disk
# in the compose image (dist only): printf '%s' "$SECRETS_JSON" | docker compose exec -T backend node dist/scripts/seed-secrets.js -
```

Without `--force` a value already stored is kept (and named as kept). One already stored
with the very value in the file is `matched`: it counts as seeded, so a retry after a
run that wrote to Secrets Manager and then failed in the database records what that run
could not. Whenever anything was stored or matched, the run bumps `settingsVersion` once
and writes one `secrets.seeded` audit row naming them. On POSIX it refuses a file
readable by group or others (`mode & 077`), naming the mode, before reading it; on
Windows that check is skipped, so keep the file in a folder only you can read. It prints
names only, never a value, and exits non-zero on any failure, including when it stored
the values but could not delete the file (delete it by hand then). With `-` there is no file
to delete; bad JSON or a name it does not keep exits non-zero and stores nothing.

## Meetings and transcripts

The bot reports the joined meeting's optional `meeting_title` with
`POST /assignment/occurrence`. After validating the claim and occurrence, the backend
stores the title in the same transaction that creates the meeting. It collapses
whitespace and keeps at most 200 characters; missing, blank, or malformed titles do
not erase an existing title or prevent joining. The first title from either source
stays. The separate Zoom REST lookup still fills missing titles and the host email.
This does not rename historical meetings whose title was never captured.

Verified spoken ownership is described in [speaker identity](../docs/speaker-identity.md).
Per-participant segments may carry `speaker_zoom_id` (a decimal nonzero uint32).
The backend resolves it through signed Zoom join events, scoped to the occurrence,
and ignores a supplied `speaker_member_id` for those segments. Transcript reads
include `speaker.zoom_id` and the resolved `speaker.member_id`. Legacy segments
without a Zoom participant ID keep their existing behavior.

A bot may add `return_segments: true` to a transcript push to receive `200` with
`{"segments": [...]}`: the stored rows for that batch, including their epoch,
`speaker_label`, `speaker_zoom_id`, and resolved `speaker_member_id`. Retries return
the original stored text and participant ID. Without that flag the response remains
`204`. The bot publishes these returned segments to the live feed.

The card login additionally has SELECT on `bwat.v_transcript_speakers` (meeting ID,
epoch, sequence, meeting participant ID, and resolved member ID). It rechecks those
identities before writing a card, so delayed join events can resolve buffered speech.
It has no access to the underlying `zoom_speakers` table or account IDs through this view.

| Route | Caller | What |
|---|---|---|
| `POST /meetings/{occurrenceId}/transcript` | bot token | Pushes transcript segments for the occurrence its claim is in. `204` stored; `409 stale_epoch` unless the caller holds a live claim on the occurrence, lease unexpired, at its accepted epoch (see Pushing a transcript); `409 stale_claim` once the claim's drain after Zoom's end ran out (the claim ends); `409 meeting_deleted` for an occurrence whose meeting was deleted; `409 transcript_expired` for a meeting whose transcript retention expired; `409 transcript_complete` for a new segment after the final push |
| `GET /meetings` | member | History, newest first, keyset-paged |
| `GET /meetings/{meetingId}/transcript` | member, or the card-service credential (every meeting, onboarded or not) | One meeting's transcript (speech and chat), paged. The meeting is named by its id or by its Zoom occurrence (URL-encoded) |
| `GET /meetings/{meetingId}/transcript.txt` | member, or the card-service credential | The board's "Download transcript": the whole transcript as `text/plain`, one `speaker: text` line a segment ("Unknown speaker" for none), as an attachment `transcript-{meetingId}.txt`. Written a page at a time. An expired transcript is no lines, with `x-transcript-expired-at`. By id only. `404` for an unknown meeting |
| `DELETE /meetings/{meetingId}` | admin | Deletes the meeting and everything about it: `200` with the counts; `404 not_found`; `409 meeting_live` while a claim is open for it |

The people routes (all but the push) answer `401 unauthorized` without a signed-in
member, then `403 not_onboarded` until the install has an activated owner (D149), as
the other people routes do. The admin routes then need the `owner` or `admin` role
(`403 forbidden` otherwise).

`occurrenceId` is the Zoom occurrence UUID the bot reported for its claim. It can hold
`/`, `+` and `=`, so it is sent URL-encoded. Up to 128 characters (decoded); a longer
one is refused `414` before it reaches the route. `meetingId` is our own id for the meeting,
from `GET /meetings`; the transcript read also takes the Zoom occurrence in its place (see
Reading a transcript). A meeting is opened when its bot reports the occurrence (`POST /assignment/occurrence`), or else by the first push for it.

Logs carry event names, ids and counts only: never transcript text, a chat line, a
speaker label, a title or a meeting number.

**Who reads a meeting (D148).** Any member reads any meeting: only members sign in, so
anyone else is `401 unauthorized` first. The deferred "attendees plus published" rule,
when it is built, belongs in the history's SQL and the transcript read, answering a
meeting it refuses as `404 not_found`, exactly as one that does not exist. (A bot reads
only its own meeting; no bot read route exists yet.)

### Retention and deletes

- **Retention: only the transcript expires (D163).** One job runs at start and hourly
  (`npm run retention` runs it once). For every meeting that ended (or, never ended,
  started) more than N days ago it deletes the transcript (every segment, speech and chat)
  and stamps the meeting's `transcript_expired_at`. **What stays:** the meeting row (its
  title, times and attendee count, still listed by `GET /meetings`) and its cards
  (`cards.*`, with their quoted evidence), until an admin deletes the meeting. **What else
  goes, by its own age (N days):** Zoom's `meeting.ended` records
  (`zoom_ended_occurrences`), hand-off inbox messages (read or unread) and hand-off keys
  (`bwat.handoffs`, so a `request_key` deduplicates for N days; see Client sessions,
  hand-offs and the inbox); and the passcode is cleared from claims that ended that long
  ago. An expired transcript reads as `200` with no segments and `transcript_expired: true`
  (Reading a transcript), a push for it is `409 transcript_expired` (Pushing a transcript),
  and its occurrence counts as ended (no promotion or Zoom start opens it again), so
  nothing refills it. Expiry writes no deletion fence: the meeting still exists.
- **The retention settings.** N is the stored setting `transcript_retention_days`
  (Settings, section `retention`, 1 to 36500), read on every run, so a save applies from
  the next run with no restart. While it is unset, 90 applies (the panel shows `default: 90`).
  A stored value the catalogue refuses is ignored for the default: 0 would expire every ended
  meeting, so 0 never means "delete everything" and never means "keep forever".
- **Keep forever** is its own choice: `transcript_keep_forever` (same section, a boolean,
  default `true` since QOR-4760, so an install that never saved it keeps transcripts from that
  release on and N days applies to content only once an admin turns it off; a stored value
  that is not a boolean is ignored).
  It keeps the meeting content only (D168): while it is `true` no transcript expires and
  no inbox message or hand-off key is deleted, but the passcode is still cleared from
  claims that ended N days ago and Zoom's `meeting.ended` records older than N days are
  still deleted. Every run logs `retention.ran` with `days`, `keep_forever` and the counts
  of the steps it ran. An occurrence whose only sign of ending was Zoom's record (no claim
  recorded its end) then no longer reads as ended once that record goes, since its
  transcript never expires. The days setting keeps its value and applies to the content
  again once keep forever is turned off.
- **Stopping.** The server's shutdown waits for a run in progress to finish before it
  closes the pool, and no run starts after it.
- **How it runs.** Transcripts, Zoom's records, inbox messages and hand-off keys go 100 at
  a time, each batch committed on its own, so a large backlog never needs one long
  statement. Retention skips a meeting a claim is open for (pending or held, the rule a
  delete refuses by): its bot could still push. A later run takes it once the claim ends.
  It works as an admin's delete does: under each meeting's lock (taken in one order, so
  two runs never deadlock), checking again under the locks. An expired meeting is never
  taken again, so a second run changes nothing.
- **Admins.** Admin means a member whose role is `owner` or `admin` (Identity above),
  read fresh on each request. Anyone else signed in gets `403 forbidden`. Each delete is
  written to `bwat.audit` in its own transaction (`meeting.deleted`; ids only; a null
  actor for the npm script).
- **Deleting a meeting** removes the meeting, its transcript, its cards (`cards.*`
  cascade from the meeting), the hand-off inbox messages that name it, and the briefing of its
  ended claims, whether or not its transcript has expired (the claims stay as tombstones; a claim open for another
  sitting keeps its passcode). It is refused `409 meeting_live`, deleting nothing, while
  a claim is open for the meeting: one on its occurrence (even after the final push, while
  the bot still holds it), or one sent to its meeting number and not yet in an occurrence,
  unless the meeting's end is recorded. Its bot could still push, and a push after the
  delete would open the meeting again. Recall the claim (or wait for the meeting to end),
  then delete. A push stores only under a live claim, so none is in flight once the check
  passes. `npm run delete-meeting -- --meeting <uuid>` does the same (and fails the same way).
- **The deletion fence.** Every delete (an admin's or `npm run delete-meeting`; retention
  deletes no meeting) records the meeting's
  occurrence in `bwat.deleted_occurrences` in the same transaction (one small row, kept
  for good: the runtime role can add and read one, never change or remove it). After it,
  a push for the occurrence is `409 meeting_deleted` and stores nothing, even under a
  live claim, and the occurrence counts as ended: a bot's occurrence report is refused
  (`409 meeting_already_ended`, its claim ends) and a Zoom start opens no claim. So no
  retry, promotion or late start can bring deleted content back. A delete takes the
  meeting's lock (on its number) first, then checks for an open claim: the order
  promotion and Zoom's start and end take (meeting, then claim), and a claim reaches an
  occurrence only under that lock, so a claim that did before the check is seen open and
  one that tries after meets the fence. A person's send takes no lock: it names no
  occurrence, so the fence (per occurrence) cannot apply to it; until its bot reports an
  occurrence it counts as open (the check above), and that report takes the lock and
  meets the fence.
- **No per-person erasure.** Erasing one person's speech is out of the MVP (QOR-4616):
  a whole meeting is deleted by an admin, or its transcript expires with retention.

Both scripts log in as the runtime role (`BWAT_DB_URL`) and print ids and counts;
in the local stack, `docker compose exec backend node dist/scripts/<name>.js ...`.

**Open items** (not done yet; each needs another track or a sign-off):

- **Claim tombstones keep the meeting number.** Deleting a meeting, and retention,
  clear an ended claim's briefing but keep its `meeting_number`,
  `occurrence_uuid` and timestamps: migration 0002's CHECK requires a meeting number.
  Scrubbing them needs that CHECK relaxed by the claims track, or legal sign-off on
  keeping them (legal blocker 3, A255).
- **A drained claim reads `live` until it ends.** A claim past its drain bound ends at its
  bot's next call or the next sweep (every 15 s); until then its occurrence reads
  `live` and a delete is refused `409 meeting_live`.
- **A recurring meeting's older occurrence.** A pending claim has no occurrence yet, so
  it counts for every meeting with its number: an older occurrence that was `abandoned`
  (never completed, end never recorded) reads `live` while next time's claim is pending,
  until that claim's bot reports its occurrence. An `ended` occurrence is unaffected.

### Pushing a transcript (bot)

```json
{
  "epoch": 3,
  "complete": false,
  "segments": [
    { "seq": 0, "speaker_label": "Speaker 1", "speaker_member_id": null,
      "text": "...", "start_ms": 0, "end_ms": 4200, "source": "asr | chat" }
  ]
}
```

- **Admission.** A push is stored only when, at the moment it runs, the calling bot holds
  a live claim (`claimed` or `attending`) on this occurrence, that claim's lease has not
  lapsed (`lease_until`, renewed by each heartbeat), and `epoch` is the claim's accepted
  transcript epoch (declared on a heartbeat after promotion; see The transcript epoch). A
  push carries no claim id or generation: the bot and the occurrence name the claim (one
  live claim per bot). Anything else is `409 {"error":"stale_epoch"}` and stores nothing:
  no claim, an ended, recalled, requeued or lapsed one, another occurrence, or another
  epoch (including before any epoch is accepted). The bot should stop pushing on it and
  read `GET /assignment`. A claim past its drain after Zoom's end (`drain_until`) is
  `409 {"error":"stale_claim"}`: the claim ends there (`done`, `drain_expired`) and the
  bot should leave. An occurrence whose meeting was deleted (`deleted_occurrences`) is
  `409 {"error":"meeting_deleted"}` and stores nothing, whatever the claim. A meeting whose
  transcript retention expired (D163) is `409 {"error":"transcript_expired"}` and stores
  nothing, whatever the claim: unlike `transcript_complete`, even a push that adds nothing
  (the final push again) is refused, since every segment would be new again. The bot
  should stop pushing; no retry can refill an expired transcript.
- **Atomic with the store.** The check is made on the claim's row, locked until the
  push commits. A release, recall, requeue, epoch change or Zoom end that commits first
  refuses the push; one that comes after waits for it, so no segment is stored after a
  release or recall has committed. The lease is judged by the clock once the row is
  locked, not by when the push began: one that lapsed before the push read the claim, or
  while it waited on the row (changed or only locked), refuses it.
- Idempotent on `(meeting, epoch, seq)`: a segment already stored is kept as it is, so a
  retried push is safe. At most 500 segments per push; `text` up to 20,000 characters.
- `source` is `asr` (the meeting's audio, transcribed; the default when it is left out)
  or `chat` (a line from the meeting's chat, D80); anything else is `400 invalid_body`.
  There is no speech (D122/D123). Chat lines share the epoch's `seq` space with speech:
  the bot numbers both from one counter, and a chat line whose `seq` is already stored
  is a retry and stores nothing. For a chat line, `speaker_label` is the sender's name
  and `start_ms = end_ms` is when it was sent. Chat is meeting content: the same
  retention, the same meeting delete, never logged.
- `start_ms`/`end_ms` are milliseconds from the start of the bot's session,
  `end_ms >= start_ms`.
- A recorded end needs no check of its own. A bot's `meeting_ended` release ends its
  claim. Zoom's `meeting.ended` ends the pending claims on the occurrence and leaves a
  held one live, so that bot's final batch (`complete: true`) is still stored; it stops
  when that claim ends, at the latest 300 s after the end. Promotion and Zoom's start refuse an ended occurrence, so no new
  claim can admit a push for it afterwards.
- `complete: true` (with or without segments) marks the transcript complete and the
  meeting ended. After that, a push that would add a segment is
  `409 {"error":"transcript_complete"}` and stores nothing; a retried push that adds
  nothing (the final push again) is still `204`.

### History (`GET /meetings?limit=&cursor=&with_bot=`)

Keyset-paged on `(started_at desc, id desc)`: a meeting added while you page never
shifts the pages. `limit` 1-100 (default 25). `with_bot=1` lists only meetings a bot was
in (non-empty `bot_ids`); by default every meeting is listed. `next_cursor` is opaque; pass it back as
`cursor`, and it is `null` on the last page. `401 unauthorized` without a
signed-in member; a bad `limit` or `cursor` is `400 invalid_query`.

A meeting is listed from the moment its bot reports the occurrence it is in, before any
transcript line. `title` (the Zoom topic) and `host_email` (the host's email) are read from
Zoom ("Get a meeting") right after that, and stay `null` without the S2S app;
`attendee_count` is `null` (nothing fills it in yet); `ended_at` and
`duration_seconds` are `null` until the meeting ends. `ended_at` is the first end bwat
learns of: the bot's final push (`complete: true`), its `meeting_ended` release, or Zoom's
`meeting.ended`, so a meeting whose final push never landed still ends. Zoom's end can arrive
while the bot is still draining its last batch, so `ended_at` set does not mean the bot has left;
whether a bot is still in the meeting is `occurrence_state`. `transcript_available` is whether
any segment is stored. `occurrence_state` is `live` while a claim is open for the
meeting, `ended` once its end is recorded, and `abandoned`
when every claim ended without one (a bot that left with no final push). `bot_present` is
whether a bot is in the live meeting now, exactly as the Zoom panel's status says present
(`claims.ts` `botPresentSql`): the meeting's latest claim attending with its lease and drain
not run out, the bot joined and heard from in the last 45 seconds (what the board shows as
Live; a live meeting without one shows "bwat not in meeting"). `bot_error` is the
error code the bot in the meeting last reported in its heartbeat, `null` for none or once it
has left: `model_out_of_credit` while the model key has run out of credit, so the board can
say so. `transcript_expired` is `true` once retention deleted the
transcript (D163; `transcript_expired_at` says when, `null` until then): the meeting and its
cards stay.

```json
{
  "meetings": [
    { "id": "uuid", "occurrence_id": "string", "title": "string | null",
      "host_email": "string | null", "started_at": "ISO 8601", "ended_at": "ISO 8601 | null", "duration_seconds": 1800,
      "attendee_count": 4, "transcript_available": true,
      "finalization": "open | transcript_complete", "occurrence_state": "live | ended | abandoned",
      "bot_ids": ["uuid"], "bot_error": "string | null", "bot_present": false, "transcript_expired": false, "transcript_expired_at": "ISO 8601 | null" }
  ],
  "next_cursor": "string | null"
}
```

### Reading a transcript (`GET /meetings/{meetingId}/transcript?limit=&cursor=&tail=`)

For the panel's source links, the plugin's context tools (D135) and the bot feed's
capture, which knows only the occurrence and cannot list history. The path names the
meeting either way: a canonical UUID (8-4-4-4-12 hex digits) is the meeting id; anything
else is a Zoom occurrence UUID, URL-encoded by the client (it can hold `/`, `+` and `=`)
and decoded once by the route. Zoom's occurrence is base64, which has no `-`, so it is
never UUID-shaped and the two cannot collide. An occurrence no meeting has is
`404 not_found`, and `not_onboarded` applies as for the id.

Segments come in
`(epoch, seq)` order, speech and chat interleaved: a bot that reconnects gets a new
epoch and starts its `seq` again. Keyset-paged on `(epoch, seq)`: `limit` 1-500
(default 200), `next_cursor` as for history (a transcript page is never short before
the last). `401 unauthorized` without a signed-in member, `404 not_found` for an
unknown meeting, `400 invalid_query` for a bad `limit`
or `cursor`. `speaker.member_id` is the member who spoke, when known. `created_at` is
when the backend stored the segment (the card service times its lines by it). `tail` (1-500)
answers only the newest `tail` segments, oldest of them first, with `next_cursor` `null`,
for a view that shows the last lines (the board's transcript footer); it ignores `limit`
and `cursor`, and a bad one is `400 invalid_query`.

This read is part of the plugin and capture contract (D135/D144): the plugin's context
tools and the card writer both follow a meeting through it.

- **Paging to the end.** Send no `cursor` for the first page. While `next_cursor` is not
  `null`, pass it back unchanged as `cursor` for the next page; `null` means there is
  nothing after this page *yet*. The cursor is opaque (do not build or parse one) and
  stays valid while the meeting exists. A reader following a `live` meeting polls by
  re-reading from the cursor that fetched its last page (none, if that was the first)
  and skipping the `(epoch, seq)` it has already seen. A cursor that is not one of ours
  is `400 invalid_query`.
- **`transcript_expired`** is `true` once retention deleted the transcript (D163):
  the answer is still `200`, with no segments and `next_cursor` `null`, and
  `transcript_expired_at` says when (`null` while the transcript is kept). The meeting and
  its cards stay; nothing is added again (`occurrence_state` is `ended`). A reader that
  sees it should stop following the meeting, not treat the empty page as an error. The
  meeting's state and the page are read from one snapshot, so an expiry that commits
  during the read is in neither: the page is never `transcript_expired: false` without the
  segments retention removed.
- **`complete`** is `true` once the bot's final push is stored (`finalization` is
  `transcript_complete`): no segment will ever be added, so the transcript read to the
  end is the whole transcript.
- **`occurrence_state`** is derived at read time from the meeting and its claims:
  - `ended`: the transcript is complete or expired, or the meeting's end is recorded (a bot's
    `meeting_ended` release, or Zoom's `meeting.ended`, whose held claim drains for at
    most 300 s: `meetingEnded` in
    `src/claims.ts`, the same answer promotion and auto-join read) and no claim is open
    on the occurrence. A write fence: no push is stored after it (see Pushing a
    transcript), and it stays `ended`, so a reader that has paged to the end can stop.
  - `live`: a claim is open (pending or held) for it; more segments may come. A pending
    claim has no occurrence yet, so an open claim for the meeting's number counts,
    unless the meeting's end is already recorded (an occurrence that ended does not
    restart; the next one is a new occurrence).
  - `abandoned`: not ended, and every claim for it ended (refused, lapsed, or released
    for another reason). A new claim for the meeting makes it `live` again.
  A complete transcript wins over an open claim: right after its final push the bot still
  holds its claim, and the occurrence is already `ended`. A recorded end does not: a
  claim still open on the occurrence keeps it `live` until that claim's final push or its
  end, so its last segments are not cut off.

```json
{
  "meeting_id": "uuid",
  "occurrence_id": "string",
  "finalization": "open | transcript_complete",
  "complete": false,
  "occurrence_state": "live | ended | abandoned",
  "transcript_expired": false,
  "transcript_expired_at": "ISO 8601 | null",
  "segments": [
    { "epoch": 1, "seq": 0,
      "speaker": { "label": "Speaker 1", "member_id": "uuid | null" },
      "text": "string", "start_ms": 0, "end_ms": 4200, "source": "asr | chat",
      "created_at": "ISO 8601" }
  ],
  "next_cursor": "string | null"
}
```

## Client sessions, hand-offs and the inbox

The Claude Code plugin's router registers each of the member's local agent sessions here,
and a card or to-do is handed to one of them as a brief, queued in the member's inbox for
the session to fetch. **A hand-off is queued, never started**: no answer claims more than
`queued`, and the backend never connects to the member's machine. Every route is a people's
route: `401 unauthorized` without a signed-in member, then `403 not_onboarded` until the
install has an activated owner (D149).

| Route | What |
|---|---|
| `PUT /sessions/{sessionId}` | Registers or heartbeats a session: `{"client": {"kind", "wake", "machine", "platform", "plugin_version", "name"?, "cwd"?}, "instance_id", "ended"?}`, at most 2 KB (`413 too_large`). `200` with the Session. See the rules below |
| `GET /sessions` | The caller's reachable sessions, a bare array of `{"session_id", "client", "last_seen_at"}`, most recently heard from first |
| `POST /handoffs` | `{"source_kind": "card" \| "todo", "source_id", "occurrence_id"?, "target_session_id", "request_key", "subject", "body", "note"?}`: `202 {"handoff_id", "status": "queued"}`. `409 meeting_deleted` for an `occurrence_id` naming no meeting we hold (deleted, or never held), `403 forbidden` for a target that is not one of the caller's sessions, `409 session_unreachable` for one of theirs that is not reachable, in that order; nothing is queued for any of them. A request over 64 KB, a `subject` over 500 or a `body` over 10000 characters is `413 too_large`. With a card service (`BWAT_CARDS_URL`, D162, D169), a card's `subject` and `body` are not sent: the backend asks the card service for the card's brief (`GET {BWAT_CARDS_URL}/v1/cards/{source_id}/brief` with `BWAT_CARDS_BACKEND_TOKEN` and the caller's id in `X-Bwat-Member-Id`; `502 cards_unavailable` when it does not answer), and once a new hand-off is queued tells the card (`POST .../routed {handoff_id, by_member_id, at}`, the caller in `X-Bwat-Member-Id` too), once per hand-off. The message's body is the brief's, then the sender's `note` (up to 1000 characters, else `400 invalid_body`) as `Note from the sender: ...` when one is sent, then `Board: {BWAT_PUBLIC_URL}/` when that is set; a repeated `request_key` makes no second call. A failed `routed` is logged and the hand-off still stands. Without a card service, or for a to-do, the caller sends `subject` and `body` |
| `GET /me/inbox?unread_only=&scope=&client_session=&limit=&cursor=` | The caller's messages, oldest first, without `body`. `scope=session` (needs `client_session`, else `400 invalid_query`) or `all` (the default; ignores `client_session`); `unread_only` `true` or `false` (default); `limit` 1-100 (default 20). Keyset-paged on `(created_at, id)`: `next_cursor` is opaque and left out on the last page. A bad query is `400 invalid_query` |
| `GET /me/inbox/{id}` | One message, `body` included |
| `PATCH /me/inbox/{id}` | No body. Marks it read: `200 {"id", "read_at"}`. Idempotent: a message already read keeps its first `read_at`. With a card service, every mark of a card's hand-off tells the card (`POST {BWAT_CARDS_URL}/v1/cards/{source_id}/handoff-read {handoff_id, by_member_id, at}`, the caller in `X-Bwat-Member-Id`), which shows "Read", recorded once per hand-off. A failed call is logged and the message stays read; marking it again tells the card again |
| `DELETE /me/inbox/{id}` | Hard-deletes the caller's own message: `204`. Any other well-formed id (unknown, already gone, or another member's) is also `204` and changes nothing, so a delete never tells whether an id exists; a malformed id is `404` |

**Sessions.** `sessionId` is the client's own id, `^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$`, 8-128 characters starting with a letter or digit (not a UUID;
anything else is `400 invalid_body`). Each member has their own namespace of ids: the same
id from two members is two sessions, and neither can see, end or take over the other's, so
no answer says whether another member uses an id. The descriptor is replaced whole on every
PUT, never merged, and a key the backend does not know is dropped; `cwd` is a last path
segment only (one holding `/` or `\` is `400 invalid_body`). `instance_id` is new per client
process:

- a heartbeat from the session's current instance renews it;
- one from another instance takes it over, and reopens it if it had ended;
- `"ended": true` from the current instance ends it; from any other instance it is ignored
  (the answer is the session as it stands);
- anything from the instance that ended it is ignored: that process said it is gone.

A session is reachable while not ended and heard from within 180 s (3 missed 60 s beats),
judged on the clock by one rule (`LIVE_SESSION` in `src/sessions.ts`) that `GET /sessions`
and `POST /handoffs` share: a session the list shows is one a hand-off accepts at that
instant. Each rule is one statement on the session's row, so a PUT that waits on another judges the
row as that one left it. Sessions are not deleted, nor pruned by retention: the runtime
role has no DELETE on them (a member's removal takes theirs with it).

**Hand-offs (v1: to the caller's own sessions).** The sender and the recipient are the
caller, so the message is created unread for them (rule 5), and `403 forbidden` answers
both another member's session and an id nobody has. The target is locked and judged by the
clock once the lock is held: a session ending while a send waits is refused `409`. A
repeated `request_key` (per sender, up to 128 characters) answers the first hand-off, even
after its session ended or its message was deleted, and queues nothing, for the transcript
retention days: the retention job prunes hand-off keys older than that (none while keep
forever is on), after which the same key queues a new hand-off; a repeat sent
while the first is in flight waits for it and answers it, whatever the session did in
between; a refused send
keeps no key, so the same click works once the session is back. Until the backend holds
cards and to-dos, the caller renders the brief and sends `subject` and `body` (an
extension of the contract, which has the backend render it from `source_id`); `source_id`
is stored as sent, unchecked.

**The inbox (D148).** Only the recipient reads, marks or deletes a message. Another
member's message is `404 not_found`, never `403`, for a read, a mark and a delete alike; an
unknown id is `404` for a read or a mark and `204` for a delete (it is already gone); one
that is not a UUID is `404` for all three. Messages are meeting-derived content: the
retention job deletes them after the transcript retention days, read or unread, by their
own `created_at`. A brief's `occurrence_id` (a meeting's id, from `GET /meetings`) must name
a meeting we hold when it is sent (one whose transcript expired is still held: its cards
stay, D163), and its message is deleted with that meeting by an admin or `npm run
delete-meeting`, read or not, so it never outlives the meeting; a send racing the delete
either commits first and goes with the meeting or is refused `409 meeting_deleted`. A member's removal deletes their sessions,
hand-offs and inbox.

```json
{
  "id": "uuid",
  "message_type": "handoff",
  "created_at": "ISO 8601",
  "read_at": "ISO 8601 | null",
  "target_client_session": "session id",
  "source": { "kind": "card | todo", "id": "uuid", "occurrence_id": "uuid, only when sent" },
  "handoff_id": "uuid",
  "subject": "string",
  "body": "string, only from GET /me/inbox/{id}"
}
```

Logs carry event names and ids (`session.registered`, `session.ended`, `handoff.queued`,
`handoff.session_unreachable`, `inbox.message_deleted`; member, session, hand-off and
message ids) only: never a subject, a body, or a session's machine, name or cwd. A
heartbeat logs nothing.

## Plugins

An integration with another product of ours that only some installs run is a plugin: its
code in `src/plugins/<name>/`, its migrations in `migrations/plugins/<name>/` (see
Migrations), one line in the registry `src/plugins/index.ts`. Core never imports a plugin's
folder (eslint enforces it); a plugin may use core.

An owner or admin switches each plugin on or off on the admin panel's Plugins page; a
fresh install has them all off. Every plugin in the registry is registered at start, and the
switch is read on each request (`src/plugins/switches.ts`, cached for up to 5 s per process),
so a change needs no restart. While a plugin is off its routes answer 404 and its bearer
signs in nobody, as if it were not there. Its tables and data stay. A board token it gave out
(`zoom_board_sessions.source` names it) signs in nobody either, while a Zoom one (no source)
always does (QOR-4890). The card service remembers a sign-in for up to 60 s, so card reads with
such a token can go on that long after the plugin is switched off. Each switch is a row in
`bwat.settings` under `plugin_<name>`, outside the catalogue; it does not bump `settingsVersion`.

A plugin declares its `displayName` and a one-line `description` for the Plugins page, and
may add:

- `needs`: an env var the operator must set first (`{"env", "to"}`). Until it is set, the page
  shows "Needs setup" and turning the plugin on is `409 needs_setup`;
- `holds(pool)`: a line on what it holds ("3 lists and the tags on 21 cards"), or null. The
  page asks for it as an admin turns the plugin off, and asks them to confirm when there is one;

- its own routes, under `/v1/plugins/<name>/`. Each one says whether it needs a signed-in
  person. They call out of bwat through `deps.fetch` (the global fetch);
- `secrets`: the tier-2 secrets its routes read with `deps.getSecret`, each named
  `<name>.<what>`. Any other name, one of core's included, reads as not set. The secret
  store keeps these names beside core's, on or off, so `npm run seed-secrets` takes them too,
  and the panel lists, sets and removes them with its others (`GET /console/secrets`);
- `retiredSecrets`: secrets it once kept and now only moves away at `start`, named as
  `secrets` are. The store and `npm run seed-secrets` keep them; the panel never shows them
  and its routes never read them;
- `start(deps)`: a step run once at each server start, on or off, after the migrations, with
  the pool, the secret store and the log: moving what an older version left. It logs its own
  failure and must not throw;
- `settings`: its own settings, each a row in `bwat.settings` under `<name>_<what>`, with a
  label, a `check` (the problem with a value, as a sentence, or null), an optional `normalise`
  and `auditValue` (its audit row shows the value; without it, only `set`, so an email or free
  text never reaches the audit table). They are outside the catalogue.
  `GET /console/plugins/<name>/settings` gives any signed-in person `{"canManage", "settings":
  {"<key>": {"value", "revision"}}}` (null and null while unset), on or off;
  `PUT /console/plugins/<name>/settings` `{"changes": {"<key>": {"value", "expectedRevision"}}}`
  saves as an owner or admin, all or nothing, as a core settings save: `400 invalid_settings
  {problems}`, `409 stale {currentRevisions}`, an unchanged value written and audited not at
  all, one `settings.updated` audit row (`settings:<name>`), and no `settingsVersion` bump.
  Its routes read them with `readStoredSetting`;
- what it works out from cards, without their content: its routes get the card service's
  backend-only calls (`deps.cards`, `src/cards-client.ts`), among them `facts`
  (`POST {BWAT_CARDS_URL}/v1/cards/facts`, the cards/README). The backend's runtime login reads
  no card table itself. A plugin that files a card in its product reads the card's `content`
  (title, note, quotes) and, once it has, adds its receipt line with `note` (the cards/README);
- its own person bearer (`bw<letter>_` and 43 base64url characters, a letter no other
  kind uses), checked before the board token and the sign-in. Once a bearer has its shape it
  asks `isOn` and, while off, passes it on as if it were not there, so no other bearer waits
  on the switch. The card service passes any
  such bearer to `POST /card-service/person`, so it needs no change for a new one;
- the board inside its product (`embeds`): its routes mint a one-minute, single-use ticket
  and answer `POST /plugins/<name>/embed/redeem` `{"ticket"}` with `{"token", "expires_at"}`,
  a board token marked with its name (`zoom_board_sessions.source`). The product frames the web
  server's page for it, which redeems it there (the plugin's web side, below).

A plugin may also have a web side, in `web/plugins/<name>/` (registered in
`web/server/src/plugins/index.ts`): board-page scripts, its own web-server routes and its own
sign-in on the board (the web README, Web plugins). The web server runs it only while this
backend lists the plugin in `GET /plugins` (QOR-4890): that is the one list of which plugins are
on; the web server has no switch of its own.

| Route | Who | What |
|---|---|---|
| `GET /plugins` | anyone | `{"plugins": [{"name", "display_name", "embeds"}]}`: the switched-on plugins, for the pairing page's wording and the web server's plugins (the one list of which run); `embeds` is whether the board opens inside its product |
| `GET /console/plugins` | person | Every plugin bwat ships: `{"canManage", "plugins": [{"name", "display_name", "description", "on", "needs"}]}`, `needs` null once the operator has set it |
| `GET /console/plugins/{name}/holds` | admin | `{"holds"}`: what the plugin holds, as one line, or null; asked as an admin turns it off |
| `PUT /console/plugins/{name}` | admin | `{"on": true \| false}`; takes effect at once in this process and within 5 s in another. `409 needs_setup` to turn on a plugin whose `needs` is unset, `404 unknown_plugin`. Audited as `plugin.switched_on` or `plugin.switched_off` (`plugin:<name>`). Answers as `GET` |
| `POST /zoom/pair` | person (sign-in only) | `{"for"?}` → `{"pair_code"}` (`XXXX-XXXX`, 10 minutes, once). The code is redeemable only by `for`: `zoom` (default, the board inside Zoom) or a switched-on plugin's name; `400 bad_request` for another. Only a Google sign-in (or a local stack's dev and test people) mints one, never a board or plugin bearer, so no bearer can mint itself a successor |

The web server's `/auth/pair?for=<name>` signs the person in with Google and shows the code,
worded for the plugin's display name (`/auth/zoom-link` for the board inside Zoom).

Each plugin documents its own routes in its folder: `src/plugins/<name>/README.md`.

## Local smoke test (docker compose)

Every backend PR is exercised in the local stack before merge:

```bash
cp .env.docker.example .env   # fill in local values
docker compose -p bwat-smoke up -d --build --wait
scripts/smoke.sh bwat-smoke
scripts/smoke-meetings.sh bwat-smoke   # transcripts, history, deletes, retention expiry
scripts/smoke-sessions.sh bwat-smoke   # sessions, hand-offs, the inbox
scripts/smoke-test-people.sh bwat-smoke   # two test people: the inbox and hand-offs stay each one's own
scripts/smoke-zoom-tokens.sh bwat-smoke   # join-token: fence and not_configured (no Zoom app locally)
docker compose -p bwat-smoke down -v
```

It prints status codes and response shapes only, and checks that the backend log carries no link, meeting number, passcode or token. `smoke-meetings.sh` also checks for transcript text and speaker names, and `smoke-sessions.sh` for a brief's subject and body and a session's machine, name and cwd. `smoke-zoom-tokens.sh` checks the join-token route without Zoom credentials (none are available locally): minting is covered by the unit tests against a fake Zoom.
