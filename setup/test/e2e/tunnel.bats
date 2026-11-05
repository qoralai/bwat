#!/usr/bin/env bats
# What `./bwat setup` step 1 says and asks on each tier, the checks on what it is given,
# and local on this computer, where the edge stays plain HTTP on 127.0.0.1:8080.

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

google=(BWAT_ALLOWED_DOMAINS=example.com BWAT_GOOGLE_CLIENT_ID=1-web.apps.googleusercontent.com
  BWAT_GOOGLE_CLIENT_SECRET=test-client-secret BWAT_GOOGLE_DESKTOP_CLIENT_ID=2-desktop.apps.googleusercontent.com BWAT_GOOGLE_DESKTOP_CLIENT_SECRET=desk-secret)

@test "in production mode with no address, -y says the tier and that the address is a public domain" {
  run env "${google[@]}" BWAT_MODE=production ./bwat setup -y
  [ "$status" -eq 2 ]
  [[ "$output" == *'public domain pointing at this server'* ]]
  [[ "$output" == *'ports 80 and 443 open'*"load balancer or a proxy"* ]]
  [[ "$output" == *"Tier: production, a cloud server at a public domain, with Zoom's meeting events and auto-join."* ]]
  [ ! -e .env ]
}

@test "setup asks the tier first; only production asks for an address and who gives it HTTPS" {
  # The tier, then the owner's email reads the end of input and stops setup.
  run bash -c "printf '%s\n' local | ./bwat setup"
  [[ "$output" == *'Where should bwat run?'*'Which one? [local]'*'Step 2 of 7: Sign-in'* ]]
  if [[ "$output" == *"bwat's address"* || "$output" == *'Does a load balancer or proxy'* ]]; then
    echo 'asked for an address on local' >&2; return 1
  fi
  run env "${google[@]}" bash -c "printf '%s\n' production https://bwat.test y | ./bwat setup"
  [[ "$output" == *"bwat's address"*'Does a load balancer or proxy in front give this address its HTTPS? (y/n)'* ]]
  [ ! -e .env ]
}

@test "with no answer to the tier question, setup stops instead of asking forever" {
  rm -f bwat.answers
  run timeout 30 bash -c ": | ./bwat setup"
  [ "$status" -eq 2 ]
  [[ "$output" == *'No tier given: run setup in a terminal, or give it as ./bwat setup --tier <name>.'* ]]
  [ ! -e .env ]
}

@test "before asking for the domains, setup says who they let in" {
  run env BWAT_MODE=production BWAT_PUBLIC_URL=https://bwat.test ./bwat setup -y
  [ "$status" -eq 2 ]
  [[ "$output" == *'bwat lets in only Google accounts from the domains you list here and refuses all others, including personal Gmail.'* ]]
}

@test "a bot name that would break the bot's config is refused before anything is written" {
  run env "${google[@]}" BWAT_MODE=production BWAT_PUBLIC_URL=https://bwat.test BWAT_TLS=external BWAT_BOT_NAME='bwat "the bot"' ./bwat setup -y
  [ "$status" -eq 2 ]
  [[ "$output" == *'BWAT_BOT_NAME'* ]]
  [ ! -e .env ]
}

@test "a company name the Zoom manifest cannot take is refused at its question, saying what fits" {
  run env "${google[@]}" BWAT_MODE=production BWAT_PUBLIC_URL=https://bwat.test BWAT_TLS=external BWAT_ZOOM_COMPANY='Acme, Inc.' \
    BWAT_ZOOM_CONTACT_NAME=Ada BWAT_ZOOM_CONTACT_EMAIL=ada@example.com ./bwat setup -y
  [ "$status" -eq 2 ]
  [[ "$output" == *'BWAT_ZOOM_COMPANY must be letters, digits, spaces and . _ ( ) - only; no comma'* ]]
  [ ! -e .env ]
  [ ! -e zoom-manifest.json ]
}

@test "an address pasted with a trailing slash is taken without it" {
  run env BWAT_MODE=production BWAT_PUBLIC_URL=https://bwat.test/ BWAT_ALLOWED_DOMAINS=example.com ./bwat setup -y
  [ "$status" -eq 2 ]
  [[ "$output" != *'BWAT_PUBLIC_URL must be'* ]]
  [[ "$output" == *'JavaScript origin: https://bwat.test'$'\n'* ]]
}

@test "before asking for the Google clients, setup prints their steps with this address" {
  run env BWAT_MODE=production BWAT_PUBLIC_URL=https://bwat.test BWAT_ALLOWED_DOMAINS=example.com ./bwat setup -y
  [ "$status" -eq 2 ]
  [[ "$output" == *'https://console.cloud.google.com/auth/overview'*'Audience Internal'* ]]
  [[ "$output" == *'https://console.cloud.google.com/auth/clients > Create client'*'Web application'* ]]
  [[ "$output" == *'JavaScript origin: https://bwat.test'$'\n'* ]]
  [[ "$output" == *'redirect URI: https://bwat.test/auth/callback'$'\n'* ]]
  [[ "$output" == *'Desktop app'* ]]
  [ ! -e .env ]
}

@test "a typed contact is not followed by a first-name question: the apps take the contact's first name" {
  # tier, address, who gives it HTTPS, bot name, contact; the next question then reads the
  # end of input.
  run env -u BWAT_ZOOM_CONTACT_NAME "${google[@]}" bash -c "printf '%s\n' production https://bwat.test y '' 'Grace Hopper' | ./bwat setup"
  [[ "$output" == *'Contact name for the app'* ]]
  [[ "$output" != *'Your first name'* ]]
  [ ! -e .env ]
}

@test "http://localhost:8080 tries bwat on this computer: the main Zoom app and the Server-to-Server app seeded, the board in this browser" {
  harness_reset
  rm -rf .env .bwat
  printf 'ZOOM_CLIENT_ID=zid-xyz\nZOOM_CLIENT_SECRET=zsecret-xyz\nZOOM_S2S_ACCOUNT_ID=acct-xyz\nZOOM_S2S_CLIENT_ID=sid-xyz\nZOOM_S2S_CLIENT_SECRET=ssecret-xyz\n' > bwat.answers
  : > zoom-board-manifest.json
  run env BWAT_FIRST_OWNER_EMAIL=ada@example.com BWAT_PUBLIC_URL=http://localhost:8080 ./bwat setup -y
  rm -f bwat.answers
  [ "$status" -eq 0 ]
  cmp zoom-manifest.json setup/test/fixtures/manifest-localhost.golden.json
  [ ! -e zoom-board-manifest.json ]
  grep -qx 'BWAT_TIER=local' .env
  grep -qx 'BWAT_TLS=external' .env
  grep -qx 'BWAT_ZOOM_OWNER_NAME=Ada' .env
  [ "$(docker compose exec -T postgres psql -U postgres -d bwat -tAc \
    "select string_agg(name, ',' order by name) from bwat.secrets")" = 'zoom.client_id,zoom.client_secret,zoom.s2s_account_id,zoom.s2s_client_id,zoom.s2s_client_secret' ]
  if [[ "$output" == *ZOOM_BOARD_CLIENT_SECRET* || "$output" == *'board app manifest'* ]]; then
    echo 'asked for the board app on local' >&2; return 1
  fi
  [[ "$output" == *'This install is local (this computer only). For a cloud server that joins meetings on its own: ./bwat setup --tier production.'* ]]
  [[ "$output" == *'1. Open http://localhost:8080 and sign in with the code below and your email, ada@example.com'*'2. Connect Claude Code: run ./bwat plugin, then restart Claude Code and type /bwat:login. By hand, in a terminal:'$'
''       claude plugin marketplace add qoralai/qoral-plugin-marketplace'$'
''       claude plugin install bwat@qoral-plugin-marketplace --config base_url=http://127.0.0.1:8080/v1'$'
'*'the plugin accepts plain http only for 127.0.0.1, not the name localhost.'* ]]
  [[ "$output" == *'In Zoom, on your main bwat app: Production > Beta Test > Add app now > Allow'* ]]
  [[ "$output" == *'Open http://localhost:8080: on the board, open Settings (the gear, top right) and paste a meeting link under Send bwat to a meeting; bwat joins it and transcribes. The board shows in this browser, not inside Zoom.'* ]]
  run curl -sS -w '\n%{http_code}' http://127.0.0.1:8080/health
  [ "${lines[1]}" = 200 ]
  [ "${lines[0]}" = '{"status":"ok","db":"ok"}' ]
  run curl -sS -o /dev/null --max-time 5 https://127.0.0.1/
  [ "$status" -ne 0 ]
}
