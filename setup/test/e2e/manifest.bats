#!/usr/bin/env bats
# The Zoom app manifest and the credential copy-back step that follows it.
# Needs no compose project: both scripts only read their input and write a file.

load helpers

setup() {
  cd "$WORK"
}

@test "the manifest for https://bwat.test equals the golden byte for byte" {
  BWAT_PUBLIC_URL=https://bwat.test setup/zoom-manifest > "$BATS_TEST_TMPDIR/manifest.json"
  cmp "$BATS_TEST_TMPDIR/manifest.json" setup/test/fixtures/manifest.golden.json
}

@test "only in production mode does the main app subscribe to meeting events, whoever gives it HTTPS" {
  for tls in caddy external; do
    BWAT_PUBLIC_URL=https://bwat.test BWAT_MODE=production BWAT_TLS=$tls setup/zoom-manifest > "$BATS_TEST_TMPDIR/$tls.json"
    python3 -m json.tool "$BATS_TEST_TMPDIR/$tls.json" > /dev/null
    grep -q '"event_subscription"' "$BATS_TEST_TMPDIR/$tls.json"
    grep -q '"production_webhook_url": "https://bwat.test/v1/callbacks/zoom/events"' "$BATS_TEST_TMPDIR/$tls.json"
  done
  BWAT_PUBLIC_URL=https://bwat.test BWAT_MODE=developer setup/zoom-manifest > "$BATS_TEST_TMPDIR/developer.json"
  cmp "$BATS_TEST_TMPDIR/developer.json" setup/test/fixtures/manifest.golden.json
}

@test "the board's manifest for https://bwat.test equals its golden byte for byte" {
  BWAT_PUBLIC_URL=https://bwat.test setup/zoom-manifest --board > "$BATS_TEST_TMPDIR/board.json"
  cmp "$BATS_TEST_TMPDIR/board.json" setup/test/fixtures/board-manifest.golden.json
}

@test "the apps are named for the installer: the contact's first name, or the owner name given" {
  BWAT_PUBLIC_URL=https://bwat.test BWAT_ZOOM_CONTACT_NAME='Ada Lovelace' setup/zoom-manifest > "$BATS_TEST_TMPDIR/main.json"
  BWAT_PUBLIC_URL=https://bwat.test BWAT_ZOOM_CONTACT_NAME='Ada Lovelace' setup/zoom-manifest --board > "$BATS_TEST_TMPDIR/board.json"
  grep -qx '    "display_name": "bwat Ada bot",' "$BATS_TEST_TMPDIR/main.json"
  grep -qx '    "display_name": "bwat Ada board",' "$BATS_TEST_TMPDIR/board.json"
  BWAT_PUBLIC_URL=https://bwat.test BWAT_ZOOM_OWNER_NAME=Priya setup/zoom-manifest > "$BATS_TEST_TMPDIR/main.json"
  BWAT_PUBLIC_URL=https://bwat.test BWAT_ZOOM_OWNER_NAME=Priya setup/zoom-manifest --board > "$BATS_TEST_TMPDIR/board.json"
  grep -qx '    "display_name": "bwat Priya bot",' "$BATS_TEST_TMPDIR/main.json"
  grep -qx '    "display_name": "bwat Priya board",' "$BATS_TEST_TMPDIR/board.json"
}

@test "an owner name that would break the manifest or Zoom's 50-character limit is refused" {
  for name in 'Ada "A"' 'back\slash' "$(printf 'x%.0s' {1..40})"; do
    BWAT_PUBLIC_URL=https://bwat.test BWAT_ZOOM_OWNER_NAME=$name run setup/zoom-manifest
    [ "$status" -eq 2 ]
    [[ "$output" == *'BWAT_ZOOM_OWNER_NAME'* ]]
  done
  BWAT_PUBLIC_URL=https://bwat.test BWAT_ZOOM_OWNER_NAME="$(printf 'x%.0s' {1..39})" setup/zoom-manifest --board > /dev/null
}

@test "the main manifest for http://localhost:8080 equals its golden: no home page or domain list" {
  BWAT_PUBLIC_URL=http://localhost:8080 setup/zoom-manifest > "$BATS_TEST_TMPDIR/manifest.json"
  python3 -m json.tool "$BATS_TEST_TMPDIR/manifest.json" > /dev/null
  cmp "$BATS_TEST_TMPDIR/manifest.json" setup/test/fixtures/manifest-localhost.golden.json
}

@test "the board's manifest refuses a localhost address: Zoom opens an in-meeting app only over https" {
  BWAT_PUBLIC_URL=http://localhost:8080 run setup/zoom-manifest --board
  [ "$status" -eq 2 ]
  [[ "$output" == *'the board app needs an https:// address'* ]]
}

@test "an address that is not https and a bare host name is refused" {
  for url in http://bwat.test http://localhost https://bwat.test/ https://bwat.test:8443 https://Bwat.test ''; do
    BWAT_PUBLIC_URL=$url run setup/zoom-manifest
    [ "$status" -eq 2 ]
    [[ "$output" == *'BWAT_PUBLIC_URL'* ]]
  done
}

@test "in production mode the copy-back writes a mode-600 seed file with the seven zoom names" {
  seed=$BATS_TEST_TMPDIR/zoom-seed.json
  printf '%s\n' id1 secret1 token1 board1 acct1 s2sid1 s2ssecret1 | BWAT_MODE=production BWAT_BOARD_APP=1 setup/zoom-secrets "$seed"
  [ "$(stat -c %a "$seed")" = 600 ]
  [ "$(cat "$seed")" = '{"zoom.client_id":"id1","zoom.client_secret":"secret1","zoom.webhook_secret":"token1","zoom.board_client_secret":"board1","zoom.s2s_account_id":"acct1","zoom.s2s_client_id":"s2sid1","zoom.s2s_client_secret":"s2ssecret1"}' ]
}

@test "in production mode the copy-back takes one app at a time and walks through creating the Server-to-Server app" {
  run bash -c "printf '%s\n' id1 secret1 token1 board1 acct1 s2sid1 s2ssecret1 | BWAT_MODE=production BWAT_BOARD_APP=1 setup/zoom-secrets '$BATS_TEST_TMPDIR/seed.json'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Open the bwat app you just created, at $(setup/paths zoom-app-credentials)"*'Client ID'*"$(setup/paths zoom-event-secret)"*"Now open the board app, at $(setup/paths zoom-app-credentials)"*'Now open your Server-to-Server OAuth app'* ]]
  [[ "$output" == *"To create one: $(setup/paths zoom-s2s-new), name it 'bwat s2s'"* ]]
  [[ "$output" == *'meeting:read:meeting:admin, meeting:read:local_recording_token:admin and user:read:user:admin, then Activate it'* ]]
  [[ "$output" == *'Enter to skip). Auto-join needs it too.'* ]]
}

@test "Enter at the Server-to-Server Account ID skips that app" {
  seed=$BATS_TEST_TMPDIR/zoom-seed.json
  printf '%s\n' id1 secret1 token1 board1 '' | BWAT_MODE=production BWAT_BOARD_APP=1 setup/zoom-secrets "$seed"
  [ "$(cat "$seed")" = '{"zoom.client_id":"id1","zoom.client_secret":"secret1","zoom.webhook_secret":"token1","zoom.board_client_secret":"board1"}' ]
}

@test "in developer mode the copy-back asks for the Server-to-Server app, recommended, but not the event secret" {
  run bash -c "printf '%s\n' id1 secret1 board1 acct1 s2sid1 s2ssecret1 | BWAT_MODE=developer BWAT_BOARD_APP=1 setup/zoom-secrets '$BATS_TEST_TMPDIR/seed.json'"
  [ "$status" -eq 0 ]
  [ "$(cat "$BATS_TEST_TMPDIR/seed.json")" = '{"zoom.client_id":"id1","zoom.client_secret":"secret1","zoom.board_client_secret":"board1","zoom.s2s_account_id":"acct1","zoom.s2s_client_id":"s2sid1","zoom.s2s_client_secret":"s2ssecret1"}' ]
  [[ "$output" == *'(optional, recommended: bwat then records your account'"'"'s'$'\n''meetings without the host allowing it; Enter to skip)'* ]]
  if [[ "$output" == *'Secret Token'* ]]; then echo 'asked for the event secret' >&2; return 1; fi
}

@test "without the board app (an install on localhost) the copy-back never asks for the board app" {
  run bash -c "printf '%s\n' id1 secret1 | BWAT_MODE=developer setup/zoom-secrets '$BATS_TEST_TMPDIR/seed.json'"
  [ "$status" -eq 0 ]
  [ "$(cat "$BATS_TEST_TMPDIR/seed.json")" = '{"zoom.client_id":"id1","zoom.client_secret":"secret1"}' ]
  if [[ "$output" == *'board app'* ]]; then echo 'asked for the board app' >&2; return 1; fi
}

@test "a pasted value outside the expected characters is refused and no seed file is left" {
  seed=$BATS_TEST_TMPDIR/zoom-seed.json
  run bash -c "printf '%s\n' 'id\"1' secret1 token1 board1 acct1 s2sid1 s2ssecret1 | BWAT_BOARD_APP=1 setup/zoom-secrets '$seed'"
  [ "$status" -eq 2 ]
  [ ! -e "$seed" ]
}

@test "at a terminal the copy-back shows the Client IDs and Account ID as typed and hides the secrets" {
  # A pty, so the terminal echoes what is typed unless the script turns echo off.
  run python3 - "$BATS_TEST_TMPDIR/seed.json" <<'PY'
import os, pty, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.environ['BWAT_MODE'] = 'developer'
    os.execv('setup/zoom-secrets', ['setup/zoom-secrets', sys.argv[1]])
out = b''
for answer in [b'id1', b'secret1', b'acct1', b's2sid1', b's2ssecret1']:
    while not out.endswith(b'): '):
        out += os.read(fd, 4096)
    time.sleep(0.3)  # the prompt is printed before read turns echo off
    os.write(fd, answer + b'\n')
    out += os.read(fd, 4096)
os.waitpid(pid, 0)
sys.stdout.write(out.decode())
PY
  [ "$status" -eq 0 ]
  [[ "$output" == *'(zoom.client_id): id1'* ]]
  [[ "$output" == *'(zoom.s2s_account_id): acct1'* ]]
  [[ "$output" == *'(zoom.s2s_client_id): s2sid1'* ]]
  if [[ "$output" == *secret1* ]]; then echo 'a secret was shown' >&2; return 1; fi
}
