#!/usr/bin/env bats
# ./bwat prep: everything a person creates by hand, collected in bwat.answers
# before setup runs; ./bwat prep --check names what is still blank.

load helpers

setup() {
  cd "$WORK"
  rm -f bwat.answers zoom-manifest.json zoom-board-manifest.json
  export HOME=$BATS_TEST_TMPDIR/home
  mkdir -p "$HOME/Downloads"
}

# Sets KEY to VALUE in bwat.answers.
answer() {
  sed -i "s|^$1=.*|$1=$2|" bwat.answers
}

@test "prep writes every value setup needs, each under a line saying where it is found" {
  run ./bwat prep
  [ "$status" -eq 0 ]
  [ "$(stat -c %a bwat.answers)" = 600 ]
  for key in BWAT_MODE BWAT_PUBLIC_URL BWAT_TLS BWAT_ALLOWED_DOMAINS BWAT_GOOGLE_CLIENT_ID \
    BWAT_GOOGLE_CLIENT_SECRET BWAT_GOOGLE_DESKTOP_CLIENT_ID BWAT_GOOGLE_DESKTOP_CLIENT_SECRET BWAT_ZOOM_OWNER_NAME BWAT_BOT_NAME ZOOM_CLIENT_ID \
    ZOOM_CLIENT_SECRET ZOOM_WEBHOOK_SECRET ZOOM_BOARD_CLIENT_SECRET BOARD_APP_ADDED ZOOM_S2S_ACCOUNT_ID ZOOM_S2S_CLIENT_ID \
    ZOOM_S2S_CLIENT_SECRET OPENROUTER_API_KEY BWAT_JEV; do
    grep -B1 "^$key=" bwat.answers | head -n 1 | grep -q '^# '
  done
  for key in BWAT_GOOGLE_CLIENT_SECRET BWAT_GOOGLE_DESKTOP_CLIENT_SECRET ZOOM_CLIENT_SECRET ZOOM_WEBHOOK_SECRET ZOOM_BOARD_CLIENT_SECRET ZOOM_S2S_CLIENT_SECRET OPENROUTER_API_KEY; do
    grep -B1 "^$key=" bwat.answers | head -n 1 | grep -q "secret: paste yourself, or copy it and run ./bwat secret $key"
  done
}

@test "a second prep keeps what was filled in and writes the manifests once the address is there" {
  ./bwat prep
  answer BWAT_MODE production
  answer BWAT_PUBLIC_URL https://bwat.test
  run ./bwat prep
  [ ! -e zoom-manifest.json ]
  [[ "$output" == *'The Zoom manifests come once'* ]]
  [[ "$output" == *'then ./bwat prep --check names what is still blank.'* ]]
  answer BWAT_ZOOM_COMPANY Example
  answer BWAT_ZOOM_CONTACT_NAME Ada
  answer BWAT_ZOOM_CONTACT_EMAIL ada@example.com
  run ./bwat prep
  grep -qx 'BWAT_PUBLIC_URL=https://bwat.test' bwat.answers
  grep -q '"production_webhook_url": "https://bwat.test/v1/callbacks/zoom/events"' zoom-manifest.json
  cmp zoom-board-manifest.json setup/test/fixtures/board-manifest.golden.json
  [[ "$output" == *'redirect URI https://bwat.test/auth/callback'* ]]
  [[ "$output" == *"Zoom app manifest: $WORK/zoom-manifest.json"* ]]
}

@test "an address filled in with a trailing slash prints the Google URIs without it" {
  ./bwat prep
  answer BWAT_MODE production
  answer BWAT_PUBLIC_URL https://bwat.test/
  run ./bwat prep
  [[ "$output" == *'JavaScript origin https://bwat.test, redirect URI https://bwat.test/auth/callback'* ]]
}

@test "--check names the blanks, never a value, and passes once everything is there" {
  ./bwat prep
  answer BWAT_MODE production
  answer BWAT_PUBLIC_URL https://bwat.test
  answer BWAT_GOOGLE_CLIENT_SECRET googlesecret-xyz
  run ./bwat prep --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'blank: ZOOM_CLIENT_SECRET'* ]]
  [[ "$output" == *'blank: BOARD_APP_ADDED'* ]]
  [[ "$output" == *'missing: the Zoom Meeting SDK for Linux x86_64'* ]]
  if [[ "$output" == *googlesecret-xyz* || "$output" == *BWAT_GOOGLE_CLIENT_SECRET* ]]; then
    echo 'a filled value or key was listed' >&2; return 1
  fi

  answer BWAT_ALLOWED_DOMAINS example.com
  answer BWAT_GOOGLE_CLIENT_ID 1-web.apps.googleusercontent.com
  answer BWAT_GOOGLE_DESKTOP_CLIENT_ID 2-desktop.apps.googleusercontent.com
  answer BWAT_GOOGLE_DESKTOP_CLIENT_SECRET desk-secret
  answer ZOOM_CLIENT_ID zid1
  answer ZOOM_CLIENT_SECRET zsecret-xyz
  answer ZOOM_BOARD_CLIENT_SECRET zboard-xyz
  answer BWAT_ZOOM_COMPANY Example
  answer BWAT_ZOOM_CONTACT_NAME Ada
  answer BWAT_ZOOM_CONTACT_EMAIL ada@example.com
  answer OPENROUTER_API_KEY sk-or-xyz
  answer BOARD_APP_ADDED yes
  answer BWAT_TLS external
  answer ZOOM_WEBHOOK_SECRET zwebhook-xyz
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz"
  run ./bwat prep --check
  [ "$status" -eq 0 ]
  [[ "$output" == *'complete'* ]]
  if [[ "$output" == *-xyz* ]]; then echo 'a secret was printed' >&2; return 1; fi
}

@test "--check asks for the TLS choice and the event secret only in production mode, and names the Server-to-Server app in every mode" {
  ./bwat prep
  grep -qx 'BWAT_MODE=developer' bwat.answers
  run ./bwat prep --check
  if [[ "$output" == *BWAT_TLS* || "$output" == *ZOOM_WEBHOOK_SECRET* ]]; then
    echo 'named a value only production mode needs' >&2; return 1
  fi
  [[ "$output" == *'optional, blank: ZOOM_S2S_ACCOUNT_ID, ZOOM_S2S_CLIENT_ID, ZOOM_S2S_CLIENT_SECRET (recommended)'* ]]
  answer BWAT_MODE production
  run ./bwat prep --check
  [[ "$output" == *'blank: BWAT_TLS'* ]]
  [[ "$output" == *'blank: ZOOM_WEBHOOK_SECRET'* ]]
  [[ "$output" == *'optional, blank: ZOOM_S2S_ACCOUNT_ID'* ]]
}

@test "the manifest prep writes subscribes to meeting events only in production mode" {
  ./bwat prep
  answer BWAT_PUBLIC_URL https://bwat.test
  answer BWAT_ZOOM_COMPANY Example
  answer BWAT_ZOOM_CONTACT_NAME Ada
  answer BWAT_ZOOM_CONTACT_EMAIL ada@example.com
  answer BWAT_MODE production
  answer BWAT_TLS external
  ./bwat prep
  grep -q '"event_subscription"' zoom-manifest.json
  answer BWAT_MODE developer
  ./bwat prep
  cmp zoom-manifest.json setup/test/fixtures/manifest.golden.json
}

@test "with no tier chosen, --check reads it from the answers as setup does: on this computer local, with no Google" {
  ./bwat prep
  answer BWAT_PUBLIC_URL http://localhost:8080
  run ./bwat prep --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'tier: local (from your answers'* ]]
  [[ "$output" == *'blank: BWAT_FIRST_OWNER_EMAIL'* ]]
  [[ "$output" == *'blank: OPENROUTER_API_KEY'* ]]
  if [[ "$output" == *BWAT_GOOGLE* || "$output" == *BWAT_ALLOWED_DOMAINS* ]]; then
    echo 'asked a local install for Google' >&2; return 1
  fi
  # Production mode is production: Google, and no owner email.
  answer BWAT_MODE production
  answer BWAT_PUBLIC_URL https://bwat.test
  run ./bwat prep --check
  [[ "$output" == *'tier: production (from your answers'* ]]
  [[ "$output" == *'blank: BWAT_GOOGLE_CLIENT_ID'* ]]
  [[ "$output" != *BWAT_FIRST_OWNER_EMAIL* ]]
  # A tier written down is the tier.
  answer BWAT_MODE developer
  answer BWAT_TIER production
  run ./bwat prep --check
  [[ "$output" == *'tier: production'$'\n'* ]]
}

@test "on localhost, --check asks for the main app's keys but not the board app's" {
  ./bwat prep
  answer BWAT_PUBLIC_URL http://localhost:8080
  run ./bwat prep --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'blank: ZOOM_CLIENT_ID'* ]]
  [[ "$output" == *'blank: ZOOM_CLIENT_SECRET'* ]]
  if [[ "$output" == *ZOOM_BOARD_CLIENT_SECRET* || "$output" == *BOARD_APP_ADDED* ]]; then
    echo 'asked for the board app on localhost' >&2; return 1
  fi
}

@test "on localhost, prep writes the main app's manifest and no board manifest" {
  ./bwat prep
  answer BWAT_PUBLIC_URL http://localhost:8080
  answer BWAT_ZOOM_COMPANY Example
  answer BWAT_ZOOM_CONTACT_NAME Ada
  answer BWAT_ZOOM_CONTACT_EMAIL ada@example.com
  : > zoom-board-manifest.json
  run ./bwat prep
  [ "$status" -eq 0 ]
  cmp zoom-manifest.json setup/test/fixtures/manifest-localhost.golden.json
  [ ! -e zoom-board-manifest.json ]
  [[ "$output" == *"Zoom app manifest: $WORK/zoom-manifest.json"* ]]
  [[ "$output" != *'board app manifest'* ]]
}

@test "setup/paths prints a path with > and quotes exactly, and refuses an unknown name" {
  run setup/paths docker-rosetta
  [ "$status" -eq 0 ]
  [ "$output" = 'Docker Desktop > Settings > General > untick "Use Rosetta for x86_64/amd64 emulation on Apple Silicon" (not yet checked)' ]
  run setup/paths zoom-new-app
  [ "$status" -eq 0 ]
  [ "$output" = 'https://marketplace.zoom.us/ > Develop (top right) > Build app > General App > Create (as of November 2026)' ]
  # from another directory, and with a name the file lacks
  cd /
  run "$WORK/setup/paths" zoom-new-app
  [ "$status" -eq 0 ]
  run "$WORK/setup/paths" no-such-path
  [ "$status" -eq 2 ]
  [[ "$output" == *'no-such-path'* ]]
  run "$WORK/setup/paths"
  [ "$status" -eq 2 ]
}

@test "the bwat.answers template's comments carry the master's Zoom app path" {
  ./bwat prep
  path=$(setup/paths zoom-new-app)
  grep -qF -- "$path" bwat.answers
}

@test "the bwat.answers template names all three Server-to-Server scopes, as setup/zoom-secrets does" {
  ./bwat prep
  grep -A1 '^# add scopes' bwat.answers | tr '\n' ' ' | grep -qF 'meeting:read:meeting:admin, meeting:read:local_recording_token:admin and # user:read:user:admin'
}

@test "--check takes Zoom's latest SDK, and names a too-old one and why it is not used" {
  ./bwat prep
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-6.5.0.1.tar.xz"
  run ./bwat prep --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'missing: the Zoom Meeting SDK for Linux x86_64'*'found zoom-meeting-sdk-linux_x86_64-6.5.0.1.tar.xz: bwat needs the Linux x86_64 SDK, 7.0.2.5001 or later'* ]]
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz"
  run ./bwat prep --check
  [[ "$output" != *'missing: the Zoom Meeting SDK'* ]]
}

@test "the answers file says outright that names take no apostrophe" {
  ./bwat prep
  grep -B2 '^BWAT_ZOOM_COMPANY=' bwat.answers | grep -q 'no apostrophe, comma or &'
}

@test "an answers file saved with t0, the local tier's old name, reads as local" {
  ./bwat prep
  answer BWAT_TIER t0
  run ./bwat prep --check
  [[ "$output" == *'tier: local'* ]]
}

@test "a blank contact email is the owner's: prep writes the manifest with it" {
  ./bwat prep
  answer BWAT_TIER local
  answer BWAT_FIRST_OWNER_EMAIL owner@example.com
  answer BWAT_ZOOM_COMPANY Example
  answer BWAT_ZOOM_CONTACT_NAME Ada
  run ./bwat prep
  grep -q 'owner@example.com' zoom-manifest.json
}

@test "on local a blank address is this computer's: prep writes the manifest without waiting for it" {
  ./bwat prep
  answer BWAT_TIER local
  answer BWAT_EDGE_PORT 8090
  answer BWAT_ZOOM_COMPANY Example
  answer BWAT_ZOOM_CONTACT_NAME Ada
  answer BWAT_ZOOM_CONTACT_EMAIL ada@example.com
  run ./bwat prep
  grep -q 'http://localhost:8090' zoom-manifest.json
  [[ "$output" != *'The Zoom manifests come once'* ]]
}
