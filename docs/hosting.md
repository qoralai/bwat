# Hosting bwat

What bwat needs from wherever you run it, for a production install on any cloud or your
own servers. It is written for the person who runs the company's hosting and for the
Claude Code session they build it with: it says what to build, not which tool builds it.

On one server, you need none of this: `./bwat setup` runs the whole install with Docker
Compose (the production steps of [bwat onboarding](onboarding.md)). That install is also
the reference for everything below: `docker-compose.yml`, `setup/compose.yml` and
`setup/Caddyfile`.

## The services

Four long-running services, two one-off jobs, and Postgres. Build each image from its
folder; none is published.

| Service | Image (build from) | Listens on | Runs |
|---|---|---|---|
| backend | `backend/` | 3000 | Always. More than one may run (the fleet pass and the settings caches are made for it). |
| cards | `cards/` | 8000 | Always, one. The card writer and the card API. |
| web | `web/` | 8080 | Always. The board, the admin panel and Google sign-in. |
| bot | `bot/`, target `zoom` (below) | 8771 (the live feed) | One container per meeting at a time; as many as you size the fleet to. |
| db-bootstrap | backend image, `node dist/scripts/db-bootstrap.js` | | Once, before the first migration; again only to rotate a database password. |
| migrate | backend image, `node dist/scripts/migrate.js` | | Before every deploy that changes the backend or the card service, and must exit 0 first. |
| Postgres | Postgres 16 | 5432 | Always. |

- The backend, cards and web images run as a non-root user. The bot runs as root and needs
  a writable filesystem (PulseAudio and the Zoom SDK write under `/var` and `/tmp`).
- The bot image is Linux x86_64 only: the Zoom Meeting SDK is.
- The backend listens on `127.0.0.1` unless `HOST` is set: set `HOST=0.0.0.0` in a
  container.

## The network

| From | To | How |
|---|---|---|
| The internet (people, Zoom) | The load balancer or proxy | HTTPS, the routing table below |
| The load balancer | backend :3000, cards :8000, web :8080 | Plain HTTP on the private network |
| backend | cards :8000 (`BWAT_CARDS_URL`) | Private network only. Every card-service route that rules 1 to 3 of the routing table below don't name is backend-only and must never be reachable from the load balancer: forward only what those rules list |
| cards, web | backend :3000 (`BWAT_BACKEND_URL`) | Private network, plain HTTP is fine |
| bot | backend (`BWAT_BACKEND_URL`) | HTTPS, a bare origin such as `https://bwat.company.com`: the bot refuses plain HTTP to anything but a host named `backend` |
| cards | each bot, `ws://<bot>:8771/feed` | The bot reports its own address toward the backend; the backend and the card service accept only a private IPv4 address (10/8, 172.16/12, 192.168/16). So bots and the card service share one private IPv4 network, and cards may reach the bots on 8771 |
| backend, cards, migrate, scripts | Postgres :5432 | Private network; TLS when `BWAT_DB_SSLROOTCERT` is set |

Outbound to the internet: the backend reaches Google (sign-in keys), Zoom's API and the
model provider (OpenRouter by default); the card service reaches the model provider; each
bot reaches Zoom's meeting servers and the transcription service (OpenRouter by default).

## Public HTTPS and routing

bwat has one public address, `https://<domain>` with no slash at the end. Terminate TLS
at your load balancer or proxy. The same address goes into:

- `BWAT_PUBLIC_URL` on the backend and web, and the bots' `BWAT_BACKEND_URL`;
- the Google web client: origin `<address>`, redirect URI `<address>/auth/callback`;
- the Zoom apps' manifests, which `./bwat prep` writes from `BWAT_PUBLIC_URL`;
- the Zoom main app's event URL, `<address>/v1/callbacks/zoom/events`.

Zoom must reach the address from the internet, for meeting events and to open the board
inside a meeting. Behind a load balancer, set `BWAT_TRUST_PROXY` on the backend and web
to the load balancer's subnet CIDRs (never `true`): without it every caller shares the
load balancer's address, and one bad client spends everyone's sign-in budget. The card
service has no such setting: it always takes the right-most `X-Forwarded-For` entry, so the
load balancer must append one.

The routing table is `setup/Caddyfile`; build yours from it, in this order, first match wins:

| # | Match | To |
|---|---|---|
| 1 | Path `/v1/occurrences/*/cards`, `/v1/occurrences/*/activity`, `/v1/cards/*/owner`, `/v1/cards/*/archive`, `/v1/cards/*/unarchive`, `/v1/cards/*/keep`, `/v1/cards/*/move-back`, `/v1/cards/*/unmerge`, `/v1/cards/*/clarify`, `/v1/cards/*/hint/*`, `/v1/editing`, `/v1/orders` | cards :8000 |
| 2 | `PATCH` of `/v1/cards/<uuid>` only | cards :8000 |
| 3 | `GET` of `/v1/cards`, `/v1/cards/counts` or `/v1/cards/<uuid>` only | cards :8000 |
| 4 | `/v1/*` and `/health` | backend :3000 |
| 5 | Everything else | web :8080 |

A load balancer without regular expressions can do rules 2 and 3 with wildcards, as long
as these come before rule 4: `GET` of `/v1/cards/settings` and `/v1/cards/*/*` to the
backend first, then `GET` of `/v1/cards` and `/v1/cards/*` to cards, and `PATCH` of
`/v1/cards/*` to cards. Without them the board's card reads reach the backend and answer
404. When you upgrade, compare `setup/Caddyfile` with your rules: a release that adds a
card route adds it there first.

## Postgres

Postgres 16, reachable only from the private network. Three logins and one database,
made by `db-bootstrap` from an admin connection (a superuser, or a login with `CREATEROLE`
and `CREATEDB`, such as a managed database's master user); `backend/README.md`, Database,
has the details and the equivalent SQL.

| Login | Used by | URL variable |
|---|---|---|
| `bwat_owner` | `migrate` only; owns the database | `BWAT_OWNER_DB_URL` |
| `bwat_runtime` | The backend, and the credential scripts | `BWAT_DB_URL` |
| `bwat_cards` | The card service | `BWAT_CARDS_DB_URL` |

Each URL is `postgres://<login>:<password>@<host>:5432/bwat`. The backend refuses to start
as any login but `bwat_runtime`, and `migrate` refuses to run as anything but the owner
(a master user that can merely act as the owner is refused too).

The order, every time:

1. `db-bootstrap`, with `BWAT_DB_ADMIN_URL` (or `BWAT_DB_ADMIN_USER`, `_PASSWORD`, `_HOST`,
   `_PORT`) and `BWAT_OWNER_PASSWORD`, `BWAT_RUNTIME_PASSWORD`, `BWAT_CARDS_PASSWORD`. Run it
   before the first migration: migration 0009 stops if `bwat_cards` does not exist. It keeps
   what exists, so it is safe to run again.
2. `migrate`, with `BWAT_OWNER_DB_URL`. It applies only what is new and refuses an edited or
   reordered migration.
3. Then the backend and the card service, in that order on an upgrade too: start an updated
   card service only after the migrations it needs.

TLS to Postgres: set `BWAT_DB_SSLROOTCERT` to a CA bundle path on the backend, cards, and
both jobs; every connection is then `verify-full`. The images carry Amazon RDS's bundle at
`/app/rds-global-bundle.pem`; for any other provider, mount its CA bundle and point the
variable at it. Leave `sslmode` and other TLS parameters out of the URLs.

## The bot image

Each company builds its own bot image from its own download of the Zoom Meeting SDK, under
Zoom's licence ([Download the Meeting SDK](onboarding.md#download-the-meeting-sdk)
says what it allows); the image must never go to a public registry.

1. Download the Linux x86_64 Meeting SDK at the version in `bot/sdk/zoom-sdk.lock` from your
   main Zoom app (the same step).
2. From the repository root:

   ```bash
   bot/sdk/prepare-vendor.sh <the SDK archive's absolute path>
   docker build --target zoom -t <your private registry>/bwat-bot:<version> bot
   ```

   `prepare-vendor.sh` fails if the SDK's library does not match the lock.
3. Push it to your private registry, then delete the archive and `bot/sdk/vendor/`.

When `bot/sdk/zoom-sdk.lock` moves to a new SDK version, download that version and build
again. Without the SDK, `docker build bot` builds a bot with a stand-in meeting, for tests
only.

## Configuration

**Secret** means: keep it in your secret manager and give it to the service as an
environment variable (or, for the backend's own startup secrets, from the secret store;
below). The bot, cards and web read their environment only.

### backend (and the migrate and script jobs)

| Variable | Secret | What |
|---|---|---|
| `NODE_ENV` | | `production` (the image's default): Google sign-in settings are then required |
| `HOST`, `PORT` | | `0.0.0.0` and `3000` |
| `BWAT_TIER` | | `production` |
| `BWAT_DB_URL` | yes | The runtime login's URL |
| `BWAT_OWNER_DB_URL` | yes | `migrate` only: the owner login's URL |
| `BWAT_DB_SSLROOTCERT` | | Optional; above |
| `BWAT_PUBLIC_URL` | | The address |
| `BWAT_TRUST_PROXY` | | The load balancer's subnet CIDRs |
| `BWAT_GOOGLE_CLIENT_IDS` | | The web client's id and the desktop client's id, comma-separated |
| `BWAT_ALLOWED_DOMAINS` | | The company's Google Workspace domains, comma-separated |
| `BWAT_GOOGLE_DESKTOP_CLIENT_ID`, `BWAT_GOOGLE_DESKTOP_CLIENT_SECRET` | | The plugin's sign-in client; Google treats a desktop client's secret as public |
| `BWAT_FIRST_OWNER_EMAIL` | | Recommended: only this person can claim the owner. Unset, the first sign-in from an allowed domain does ([Who can sign in](onboarding.md#who-can-sign-in)) |
| `BWAT_CARDS_URL` | | The card service on the private network, such as `http://cards:8000` |
| `BWAT_CARDS_BACKEND_TOKEN` | yes | At least 32 characters; the card service gets the same value |
| `BWAT_FEED_KEY` | yes | 32 bytes, as 64 hex characters or base64; keys the bots' live feed. Required: with `NODE_ENV=production` the backend refuses to start without it |
| `BWAT_SECRET_STORE` | | `aws` (Secrets Manager) or `local` (the default: encrypted in Postgres) |
| `BWAT_SECRET_PREFIX` | | `aws` only, required: the install's secret prefix, such as `bwat/prod/` |
| `BWAT_ENC_KEY` | yes | `local` only: 32 bytes, as 64 hex characters or base64; keys the store in Postgres; unset, the store holds nothing and the admin panel cannot save a secret. Never read from Secrets Manager |
| `AWS_REGION` | | `aws` only, unless the runtime gives the region: the AWS SDK's default chain finds it and the credentials |
| `BWAT_BOT_NAME` | | Optional: the bot's name in meetings (default `bwat`); the admin panel can change it |
| `BWAT_FLEET_AUTOSCALE`, `BWAT_FLEET_*` | | Optional, ECS only: fleet sizing, below |

Optional tuning, each described in `backend/README.md`: `BWAT_AUTO_JOIN`,
`BWAT_AUTO_JOIN_REQUIRE_HOST`, `BWAT_RATE_LIMIT_SIGNIN_FAILURES_PER_MIN`,
`BWAT_RATE_LIMIT_ZOOM_PER_MIN`, `BWAT_FRAME_ANCESTORS`, `BWAT_CARDS_MODEL_URL`,
`BWAT_CARDS_MODEL`, `BWAT_JEV`. Never set `BWAT_DEV_PERSON_TOKEN`, `BWAT_TEST_PEOPLE` or
`BWAT_SIGNIN_CODE_SHA256` in production.

The backend reads its startup secrets (`BWAT_DB_URL`, `BWAT_FEED_KEY`,
`BWAT_CARDS_BACKEND_TOKEN`, `BWAT_GOOGLE_CLIENT_IDS`, `BWAT_ALLOWED_DOMAINS`; `migrate`:
`BWAT_OWNER_DB_URL`; `db-bootstrap`: the three passwords) as `NAME_FILE`, then `NAME`,
then, with `BWAT_SECRET_STORE=aws`, Secrets Manager at `<prefix><NAME>`. So on AWS the
backend can read them itself, with no injection. The admin connection is read from the
environment only.

### cards

| Variable | Secret | What |
|---|---|---|
| `BWAT_CARDS_DB_URL` | yes | The card login's URL |
| `BWAT_DB_SSLROOTCERT` | | Optional; as the backend's |
| `BWAT_BACKEND_URL` | | The backend on the private network, such as `http://backend:3000` |
| `BWAT_CARDS_CREDENTIAL` | yes | The card service's credential (`bwc_`), minted after the migrations |
| `BWAT_CARDS_BACKEND_TOKEN` | yes | The backend's value |
| `BWAT_CARDS_MAX_CONCURRENT` | | Optional: the card API's database connections (default 20) |
| `BWAT_CARDS_PORT` | | Optional: the port the card API listens on (default 8000) |

### web

| Variable | Secret | What |
|---|---|---|
| `BWAT_PUBLIC_URL` | | The address |
| `BWAT_TIER` | | `production` |
| `BWAT_GOOGLE_CLIENT_ID` | | The web client's id |
| `BWAT_GOOGLE_CLIENT_SECRET` | yes | The web client's secret |
| `BWAT_SESSION_SECRET` | yes | 32 random bytes, base64: seals the sign-in cookie |
| `BWAT_BACKEND_URL` | | The backend on the private network |
| `BWAT_TRUST_PROXY` | | As the backend's |
| `BWAT_VERSION`, `BWAT_FRAME_ANCESTORS` | | Optional (`web/README.md`) |

### bot

| Variable | Secret | What |
|---|---|---|
| `BWAT_BACKEND_URL` | | The public address, `https://` |
| `BWAT_FLEET_CREDENTIAL` | yes | The fleet credential (`bwf_`), minted after the migrations |
| `BWAT_FEED_PORT` | | `8771` (the default) |
| `BWAT_ASR_URL`, `BWAT_ASR_MODEL`, `BWAT_ASR_TRUSTED_HOSTS` | | Optional: the transcription service (default Deepgram Nova-3 through OpenRouter); `bot/README.md` |

### The secrets the admin panel holds

The Zoom apps' credentials and the model keys live in the secret store
(`BWAT_SECRET_STORE`), not in the environment (the backend reads `BWAT_ZOOM_WEBHOOK_SECRET`,
`OPENROUTER_API_KEY` and the other providers' `*_API_KEY` only while nothing is stored), under these names: `zoom.client_id`,
`zoom.client_secret`, `zoom.webhook_secret`, `zoom.board_client_secret`,
`zoom.s2s_account_id`, `zoom.s2s_client_id`, `zoom.s2s_client_secret`,
`provider.openrouter` and the other `provider.*` keys (`backend/README.md`, Secrets). With
`aws`, each is a plain-string secret at `<prefix><name>`.

After the first sign-in, an owner enters them in the admin panel (Settings: the Zoom
secrets under Connections, the model keys under Models), which writes them to the store.
A scripted install can import them instead with `node dist/scripts/seed-secrets.js -` in
the backend image (`backend/README.md`, Secrets).

### Values you generate

| Value | Make it with |
|---|---|
| `BWAT_OWNER_PASSWORD`, `BWAT_RUNTIME_PASSWORD`, `BWAT_CARDS_PASSWORD` | `openssl rand -hex 24` (they go into URLs) |
| `BWAT_FEED_KEY`, `BWAT_CARDS_BACKEND_TOKEN`, `BWAT_ENC_KEY` | `openssl rand -hex 32` |
| `BWAT_SESSION_SECRET` | `openssl rand -base64 32` |

Generate each straight into your secret manager; never paste one into a chat.

## IAM for BWAT_SECRET_STORE=aws

The backend calls `GetSecretValue`, `PutSecretValue`, `CreateSecret` (when an admin saves a
secret that does not exist yet) and `DeleteSecret` (when an admin removes one), only on
names under its prefix (`backend/src/secrets/store.ts`). The minimum policy for the
backend's role, with your region, account and prefix (Secrets Manager adds a suffix to each
secret's ARN, so keep the `*`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BwatSecretStore",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret"
      ],
      "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:<prefix>*"
    }
  ]
}
```

- The `migrate`, `db-bootstrap` and credential jobs only read: `secretsmanager:GetSecretValue`
  on the same resource is enough for them.
- If the secrets are encrypted with your own KMS key rather than the account's default
  Secrets Manager key, also allow `kms:Decrypt` and `kms:GenerateDataKey` on that key.
- The cards, web and bot containers read nothing from Secrets Manager: whatever injects
  their secrets into the environment needs `GetSecretValue` on those secrets.

With the fleet on ECS (`BWAT_FLEET_AUTOSCALE`), the backend's role also needs
`ecs:DescribeServices` and `ecs:UpdateService` on the bot service, and
`ecs:UpdateTaskProtection` and `ecs:GetTaskProtection` on the cluster's tasks.

## Health checks

| Service | Check | Healthy |
|---|---|---|
| backend | `GET /health` on 3000 | `200 {"status":"ok","db":"ok"}`; `503` when Postgres does not answer. Not under `/v1`, needs no sign-in |
| cards | `GET /health` on 8000 | `200` |
| web | `GET /health` on 8080 | `200`, needs no sign-in (the image has this check built in) |
| bot | none over HTTP | The admin panel's Overview, or `GET /v1/fleet`, shows each bot ready, busy or stale (no word for 45 s) |
| db-bootstrap, migrate | exit code | `0`; anything else stops the deploy |

A bot that exits 2 has a configuration error, and one that exits 4 had its fleet credential
refused: no restart fixes either, so do not restart it. One
that exits 3 could not confirm it left a meeting: restart it fresh.

## Sizing the bot fleet

One bot is one container and attends one meeting at a time. Run as many as the meetings
you expect at once, plus one idle bot so a new meeting finds one ready. A bot that has not
been heard from for 45 s is never sent to a meeting.

- **Anywhere:** run that many bot containers yourself (with Compose,
  `docker compose up --scale bot-zoom=<n>`).
- **On Amazon ECS:** the backend can size the bot service itself and protect a bot in a
  meeting from scale-in. Set `BWAT_FLEET_AUTOSCALE=on` (`dryrun` logs what it would do),
  `BWAT_FLEET_CLUSTER` and `BWAT_FLEET_SERVICE`, and the bounds `BWAT_FLEET_MIN` (default 1),
  `BWAT_FLEET_MAX` (default 2, at most 10) and `BWAT_FLEET_HEADROOM` (idle bots kept beyond
  demand, default 1). It then owns the service's count; to park the bots, set
  `BWAT_FLEET_MAX=0`. `backend/README.md`, The fleet.

Stopping a bot: send SIGTERM and allow at least 20 s before killing it. A bot stopped in a
meeting hands the meeting back, and another ready bot joins it, so roll or scale in bots
when no meeting is on, or let the ECS fleet's protection hold them.

The repository gives no CPU or memory figures for any service: start small, and size from
what you measure.

## The first deploy, in order

1. **The address.** Choose the domain and get its certificate on your load balancer or proxy.
2. **Google sign-in.** Make the web and the desktop clients, as
   [Set up Google sign-in](onboarding.md#set-up-google-sign-in) says, with the address.
3. **Zoom apps.** In a clone, run `./bwat prep` once to make `bwat.answers`, then set in it
   `BWAT_MODE=production`, `BWAT_PUBLIC_URL=<address>`, `BWAT_ZOOM_COMPANY`,
   `BWAT_ZOOM_CONTACT_NAME` and `BWAT_ZOOM_CONTACT_EMAIL` (none is a secret, and no secret
   goes in that file). Run `./bwat prep` again: it writes `zoom-manifest.json` and
   `zoom-board-manifest.json`. Make the main app, the board app and, for automatic joining,
   the Server-to-Server app, as [Set up Zoom](onboarding.md#set-up-zoom) says.
4. **Images.** Build backend, cards and web from their folders, and the bot from your SDK
   (above); push them to your private registry.
5. **Postgres and secrets.** Make the database server and the private network. Generate the
   values above into your secret manager.
6. **Database.** Run `db-bootstrap`, then `migrate`; each must exit 0.
7. **Backend.** Start it; `GET /health` must answer 200.
8. **Credentials.** With the backend image and `BWAT_DB_URL`, run
   `node dist/scripts/fleet-credential.js --label fleet` and
   `node dist/scripts/cards-credential.js --label cards`. Each prints its credential once:
   store them as `BWAT_FLEET_CREDENTIAL` and `BWAT_CARDS_CREDENTIAL`.
9. **The rest.** Start cards and web, and put the routing table on the load balancer.
10. **Sign in first** at the address: the first sign-in becomes the owner (or only
    `BWAT_FIRST_OWNER_EMAIL` can claim it). Enter the Zoom secrets (the main app's, its
    event secret token, the board app's and the Server-to-Server app's) and the OpenRouter
    key in the admin panel.
11. **Bots.** Start the bot fleet; the admin panel's Overview shows each bot ready.
12. **Finish in Zoom and Claude Code.** As [Finish the company setup](onboarding.md#finish-the-company-setup)
    says: validate the event address, add the main app to the account, check automatic
    joining in the admin panel, and share the address with the team, who connect Claude
    Code as [For everyone else](onboarding.md#for-everyone-else) says.

On every later deploy: build the images, run `migrate`, then roll the backend, cards, web
and, when no meeting is on, the bots.
