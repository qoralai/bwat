#!/usr/bin/env bats
# A person who stops setup and runs it again may be correcting an answer: an
# interactive run asks every typed value again, the saved one as its default.
# Answers come in on stdin, as a person types them.

load helpers

setup_file() {
  harness_reset
  rm -rf "$WORK/.env" "$WORK/.bwat" "$WORK/zoom-manifest.json" "$WORK/zoom-board-manifest.json" "$WORK/bwat.answers"
  cd "$WORK"
  BWAT_PUBLIC_URL=http://localhost:8080 BWAT_FIRST_OWNER_EMAIL=owner@example.com ./bwat setup -y
}

teardown_file() {
  harness_reset
}

setup() {
  cd "$WORK"
}

@test "a second interactive run replaces what is typed and keeps what Enter leaves" {
  cp .env "$BATS_FILE_TMPDIR/env.before"
  # owner's email, bot name, Zoom app made, Jev, spare (the saved tier asks no tier, and local
  # no address).
  # --no-start: what is tested is the questions and .env, not the restart.
  run bash -c "printf '%s\n' '' 'bwat notes' '' '' '' | ./bwat setup --no-start"
  [ "$status" -eq 0 ]
  [[ "$output" != *'Which one?'* ]]
  [[ "$output" != *"bwat's address"* ]]
  [[ "$output" == *"Your email, the owner's (an email address) [current: owner@example.com]"* ]]
  [[ "$output" != *'The port bwat listens on'* ]]
  grep -qx 'BWAT_EDGE_PORT=8080' .env
  [[ "$output" == *'Name the bot shows in meetings (letters, digits'*'[current: bwat]'* ]]
  grep -qx 'BWAT_BOT_NAME=bwat notes' .env
  [[ "$output" == *'Use Jev (TypeSafe, via OpenRouter) for faster cards? Recommended. [Y/n]'* ]]
  grep -qx 'BWAT_JEV=on' .env

  grep -qx 'BWAT_PUBLIC_URL=http://localhost:8080' .env
  grep -qx 'BWAT_FIRST_OWNER_EMAIL=owner@example.com' .env
  # Generated secrets stay: the database volume was made with them.
  for name in POSTGRES_PASSWORD BWAT_ENC_KEY BWAT_FLEET_CREDENTIAL; do
    [ "$(grep "^$name=" .env)" = "$(grep "^$name=" "$BATS_FILE_TMPDIR/env.before")" ]
  done
}
