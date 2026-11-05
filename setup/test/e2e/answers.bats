#!/usr/bin/env bats
# ./bwat setup with a complete bwat.answers asks nothing: it reads every value
# from the file and stores the Zoom credentials and the model key itself.

load helpers

setup_file() {
  harness_reset
  rm -rf "$WORK/.env" "$WORK/.bwat" "$WORK/zoom-manifest.json" "$WORK/zoom-board-manifest.json" "$WORK/bwat.answers"
}

teardown_file() {
  harness_reset
  rm -f "$WORK/bwat.answers"
}

setup() {
  cd "$WORK"
}

answer() {
  sed -i "s|^$1=.*|$1=$2|" bwat.answers
}

@test "with every answer in bwat.answers, setup runs end to end without asking" {
  ./bwat prep
  answer BWAT_MODE production
  answer BWAT_PUBLIC_URL https://bwat.test
  answer BWAT_TLS external
  answer BWAT_ALLOWED_DOMAINS example.com
  answer BWAT_GOOGLE_CLIENT_ID 1-web.apps.googleusercontent.com
  answer BWAT_GOOGLE_CLIENT_SECRET googlesecret-xyz
  answer BWAT_GOOGLE_DESKTOP_CLIENT_ID 2-desktop.apps.googleusercontent.com
  answer BWAT_GOOGLE_DESKTOP_CLIENT_SECRET desk-secret
  answer ZOOM_CLIENT_ID zid-xyz
  answer ZOOM_CLIENT_SECRET zsecret-xyz
  answer ZOOM_BOARD_CLIENT_SECRET zboard-xyz
  answer OPENROUTER_API_KEY sk-or-xyz

  # Any question would read the empty stdin and stop setup.
  run ./bwat setup < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *'bwat is installed and running.'* ]]
  grep -qx 'BWAT_GOOGLE_CLIENT_SECRET=googlesecret-xyz' .env
  [ "$(docker compose exec -T postgres psql -U postgres -d bwat -tAc \
    "select string_agg(name, ',' order by name) from bwat.secrets")" = \
    'provider.openrouter,zoom.board_client_secret,zoom.client_id,zoom.client_secret' ]
  if grep -rq -e zsecret-xyz -e zboard-xyz -e sk-or-xyz .bwat/logs/; then
    echo 'a secret from bwat.answers reached the log' >&2; return 1
  fi
}

@test "a re-run keeps what is already stored and passes over a blank answer" {
  # A value rotated in the admin panel since: bwat.answers is now the stale one.
  answer ZOOM_CLIENT_SECRET zsecret-stale
  answer ZOOM_BOARD_CLIENT_SECRET ''
  run ./bwat setup < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *'ZOOM_BOARD_CLIENT_SECRET is blank in bwat.answers'* ]]
  [[ "$output" == *'kept 1 already stored'*'zoom.client_secret'* ]]
  [[ "$output" == *'bwat is installed and running.'* ]]
}

@test "with BWAT_JEV blank in bwat.answers, setup asks about Jev, and n turns it off for the backend" {
  answer BWAT_JEV ''
  run bash -c "printf '%s\n' n | ./bwat setup"
  [ "$status" -eq 0 ]
  [[ "$output" == *'Use Jev (TypeSafe, via OpenRouter) for faster cards? Recommended. [Y/n]'* ]]
  grep -qx 'BWAT_JEV=off' .env
  [ "$(docker compose exec -T backend printenv BWAT_JEV)" = off ]
}

@test "Enter keeps Jev off, and BWAT_JEV=on in bwat.answers turns it back on without asking" {
  run bash -c "printf '\n' | ./bwat setup --no-start"
  [ "$status" -eq 0 ]
  [[ "$output" == *'for faster cards? Recommended. [y/N]'* ]]
  grep -qx 'BWAT_JEV=off' .env

  answer BWAT_JEV on
  run ./bwat setup < /dev/null
  [ "$status" -eq 0 ]
  if [[ "$output" == *'Use Jev'* ]]; then echo 'asked about Jev with an answer given' >&2; return 1; fi
  grep -qx 'BWAT_JEV=on' .env
  [ "$(docker compose exec -T backend printenv BWAT_JEV)" = on ]
}
