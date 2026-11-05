#!/usr/bin/env bats
# Acceptance tests for `./bwat setup`: A1 a fresh install, A2 a second run.

load helpers

setup_file() {
  harness_reset
  rm -rf "$WORK/.env" "$WORK/.bwat" "$WORK/zoom-manifest.json" "$WORK/zoom-board-manifest.json" "$WORK/bwat.answers"
}

# Later files bring up stacks of their own on the same ports.
teardown_file() {
  harness_reset
}

setup() {
  cd "$WORK"
}

@test "A1: a fresh host installs with -y and serves /health over Pebble-issued TLS" {
  # No BWAT_MODE: an install that gives itself HTTPS is production.
  BWAT_PUBLIC_URL=https://bwat.test BWAT_TLS=caddy BWAT_SECRET_STORE=local \
    BWAT_ALLOWED_DOMAINS=example.com BWAT_GOOGLE_CLIENT_ID=1-web.apps.googleusercontent.com \
    BWAT_GOOGLE_CLIENT_SECRET=test-client-secret \
    BWAT_GOOGLE_DESKTOP_CLIENT_ID=2-desktop.apps.googleusercontent.com BWAT_GOOGLE_DESKTOP_CLIENT_SECRET=desk-secret run ./bwat setup -y
  [ "$status" -eq 0 ]

  # The steps the install guide follows, in its order, then what to do next.
  [[ "$output" == *'Step 1 of 7: Your address'*'Step 2 of 7: Google sign-in'*'Step 3 of 7: Your Zoom app'*'Step 4 of 7: The meeting bot'*'Step 5 of 7: Start bwat'*'Step 6 of 7: Zoom credentials'*'Step 7 of 7: The model key'*'bwat is installed and running.'* ]]
  [[ "$output" == *'1. Open https://bwat.test and sign in first'*'Validate the event URL'*'Zoom > Apps > your board app'*'the app is bwat Ada board.'*"This run's log: $WORK/.bwat/logs/setup-"* ]]
  # Production mode adds the board app for everyone and opens it in every meeting.
  [[ "$output" == *'Add for others > All users > Allow'*'Auto-open an app in meetings'*'the board app was added for everyone'* ]]

  # The backend accepts both Google clients, the web one first.
  grep -qx 'BWAT_GOOGLE_CLIENT_IDS=1-web.apps.googleusercontent.com,2-desktop.apps.googleusercontent.com' .env
  grep -qx 'BWAT_ZOOM_OWNER_NAME=Ada' .env
  grep -qx 'BWAT_BOT_NAME=bwat' .env
  grep -qx 'BWAT_MODE=production' .env
  # Jev is on unless someone says no (QOR-4769).
  grep -qx 'BWAT_JEV=on' .env

  # The Zoom app manifest for this address is ready to upload; in production mode it
  # subscribes to meeting events.
  grep -q '"production_webhook_url": "https://bwat.test/v1/callbacks/zoom/events"' zoom-manifest.json
  [[ "$output" == *"Zoom app manifest: $WORK/zoom-manifest.json"* ]]
  cmp zoom-board-manifest.json setup/test/fixtures/board-manifest.golden.json
  [[ "$output" == *"board app manifest: $WORK/zoom-board-manifest.json"* ]]

  # No Zoom SDK on this host yet: bwat runs without its bot and says how to add it.
  grep -qx 'COMPOSE_PROFILES=' .env
  [[ "$output" == *'setup/zoom-sdk'* ]]

  # The generated keys and both minted credentials are in .env.
  grep -qE '^BWAT_FEED_KEY=[0-9a-f]{64}$' .env
  grep -qE '^BWAT_CARDS_BACKEND_TOKEN=[0-9a-f]{64}$' .env
  grep -qE '^BWAT_FLEET_CREDENTIAL=bwf_' .env
  grep -qE '^BWAT_CARDS_CREDENTIAL=bwc_' .env

  # (a) Certificates Pebble issues chain to its issuing root, not the listener root.
  docker compose cp pebble:/test/certs/pebble.minica.pem "$PEBBLE_LISTENER_ROOT"
  curl -fsS -o "$BATS_FILE_TMPDIR/issuing-root.pem" --cacert "$PEBBLE_LISTENER_ROOT" \
    https://localhost:15000/roots/0
  run curl -sS --cacert "$BATS_FILE_TMPDIR/issuing-root.pem" \
    --resolve bwat.test:443:127.0.0.1 -w '\n%{http_code}' https://bwat.test/health
  [ "${lines[1]}" = 200 ]
  [ "${lines[0]}" = '{"status":"ok","db":"ok"}' ]

  # Sign-in is configured: the admin panel sends a signed-out visitor to Google.
  run curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --cacert "$BATS_FILE_TMPDIR/issuing-root.pem" \
    --resolve bwat.test:443:127.0.0.1 https://bwat.test/admin
  [[ "$output" == '302 https://accounts.google.com/'* ]]

  # (b) Production: no dev token, so a made-up bearer is refused.
  [ "$(docker compose exec -T backend printenv NODE_ENV)" = production ]
  [ "$(docker compose exec -T backend printenv BWAT_JEV)" = on ]
  run curl -sS -o /dev/null -w '%{http_code}' --cacert "$BATS_FILE_TMPDIR/issuing-root.pem" \
    --resolve bwat.test:443:127.0.0.1 -X POST \
    -H "Authorization: Bearer $(printf 'x%.0s' {1..32})" https://bwat.test/v1/allocations
  [ "$output" = 401 ]

  # (c) .env is private, has no placeholder and an empty dev token.
  [ "$(stat -c %a .env)" = 600 ]
  # A bare `! cmd` never fails a bats test, so branch on it.
  if grep -q 'change-me' .env; then echo 'placeholder left in .env' >&2; return 1; fi
  grep -qx 'BWAT_DEV_PERSON_TOKEN=' .env

  # (d) No .env secret value appears in the installer's logs. Settings such as
  # BWAT_PUBLIC_URL or the project name may rightly appear there.
  [ -d .bwat/logs ]
  while IFS='=' read -r key value; do
    [[ $key =~ (PASSWORD|KEY|TOKEN|SECRET|CREDENTIAL)$ && -n $value ]] || continue
    if grep -rqF -- "$value" .bwat/logs/; then echo "value of $key found in the logs" >&2; return 1; fi
  done < .env
}

@test "A2: a second setup run changes nothing" {
  cp .env "$BATS_FILE_TMPDIR/env.before"
  before=$(docker compose ps -aq | sort | xargs docker inspect -f '{{.Id}} {{.State.StartedAt}}')

  run ./bwat setup -y
  [ "$status" -eq 0 ]

  cmp .env "$BATS_FILE_TMPDIR/env.before"
  after=$(docker compose ps -aq | sort | xargs docker inspect -f '{{.Id}} {{.State.StartedAt}}')
  [ "$before" = "$after" ]
  # The installer pins its own project name; the tests never set one.
  [ "$(docker compose config | sed -n 's/^name: //p')" = bwat ]
  [ "$(docker compose exec -T postgres psql -U postgres -d bwat -tAc 'select count(*) from bwat.fleet_credentials')" = 1 ]
  [ "$(docker compose exec -T postgres psql -U postgres -d bwat -tAc 'select count(*) from bwat.cards_credentials')" = 1 ]
}

@test "A2b: a re-run brings back a stopped edge and a loosened .env" {
  docker compose stop edge
  chmod 644 .env

  run ./bwat setup -y
  [ "$status" -eq 0 ]

  [ -n "$(docker compose ps -q --status running edge)" ]
  [ "$(stat -c %a .env)" = 600 ]
}
