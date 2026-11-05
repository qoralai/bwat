#!/usr/bin/env bats
# The installer runs on macOS, whose bash is 3.2, as well as on Linux and Windows
# (Git Bash, WSL). These run prep and setup's question phase under bash 3.2 itself.

load helpers

# macOS ships bash 3.2.57.
BASH32=bash:3.2@sha256:0fd7cb8499c63a3c9345e7088a9cd83bb69f6e895e83833859aff838a0312091

setup_file() {
  docker pull -q "$BASH32" > /dev/null
}

setup() {
  cd "$WORK"
  rm -rf .env .bwat bwat.answers zoom-manifest.json zoom-board-manifest.json
}

teardown() {
  rm -rf "$WORK/.env" "$WORK/.bwat" "$WORK/bwat.answers"
}

# Runs a command in bash 3.2 on this tree, with a docker that passes setup's up-front check
# (running, Compose 2.29) and fails everything else: the question phase runs, and setup
# stops at its first real docker call.
in_bash32() {
  docker run --rm -v "$WORK:$WORK" -w "$WORK" -e HOME=/tmp/home "$BASH32" bash -c '
    set -e
    mkdir -p /tmp/home/Downloads /tmp/bin
    printf "#!/bin/sh\ncase \"\$*\" in version*) echo 27.0.0; exit 0 ;; \"compose version\"*) echo 2.29.0; exit 0 ;; esac\nexit 1\n" > /tmp/bin/docker && chmod +x /tmp/bin/docker
    export PATH=/tmp/bin:$PATH
    '"$1"
}

@test "under bash 3.2, prep writes the file, the manifests and a complete check" {
  run in_bash32 '
    [ "${BASH_VERSINFO[0]}" = 3 ]
    ./bwat prep > /dev/null
    for pair in BWAT_MODE=production BWAT_PUBLIC_URL=https://bwat.test BWAT_TLS=external BWAT_ALLOWED_DOMAINS=example.com \
      BWAT_GOOGLE_CLIENT_ID=1-web BWAT_GOOGLE_CLIENT_SECRET=gs BWAT_GOOGLE_DESKTOP_CLIENT_ID=2-desktop BWAT_GOOGLE_DESKTOP_CLIENT_SECRET=ds \
      ZOOM_CLIENT_ID=zid ZOOM_CLIENT_SECRET=zs ZOOM_WEBHOOK_SECRET=zt ZOOM_BOARD_CLIENT_SECRET=zb OPENROUTER_API_KEY=sk BOARD_APP_ADDED=yes \
      BWAT_ZOOM_COMPANY=Example BWAT_ZOOM_CONTACT_NAME=Ada BWAT_ZOOM_CONTACT_EMAIL=ada@example.com; do
      sed -i "s|^${pair%%=*}=.*|$pair|" bwat.answers
    done
    ./bwat prep
    : > /tmp/home/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz
    ./bwat prep --check'
  [ "$status" -eq 0 ]
  grep -q '"production_webhook_url": "https://bwat.test/v1/callbacks/zoom/events"' zoom-manifest.json
  cmp zoom-board-manifest.json setup/test/fixtures/board-manifest.golden.json
  [[ "$output" == *'complete: run ./bwat setup'* ]]
}

@test "under bash 3.2, setup reads bwat.answers and writes .env before starting docker" {
  run in_bash32 '
    ./bwat prep > /dev/null
    for pair in BWAT_MODE=production BWAT_PUBLIC_URL=https://bwat.test BWAT_TLS=external BWAT_ALLOWED_DOMAINS=example.com \
      BWAT_GOOGLE_CLIENT_ID=1-web BWAT_GOOGLE_CLIENT_SECRET=gs BWAT_GOOGLE_DESKTOP_CLIENT_ID=2-desktop BWAT_GOOGLE_DESKTOP_CLIENT_SECRET=ds \
      BWAT_ZOOM_COMPANY=Example BWAT_ZOOM_CONTACT_NAME=Ada BWAT_ZOOM_CONTACT_EMAIL=ada@example.com; do
      sed -i "s|^${pair%%=*}=.*|$pair|" bwat.answers
    done
    ./bwat setup -y'
  [[ "$output" == *'Step 5 of 7: Start bwat'* ]]
  grep -qx 'BWAT_GOOGLE_CLIENT_IDS=1-web,2-desktop' .env
  grep -qx 'BWAT_GOOGLE_DESKTOP_CLIENT_SECRET=ds' .env
  grep -qx 'BWAT_MODE=production' .env
  grep -qx 'BWAT_TLS=external' .env
  grep -qx 'BWAT_ZOOM_OWNER_NAME=Ada' .env
  grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}$' .env
  grep -qE '^BWAT_SESSION_SECRET=.{44}$' .env
}

@test "under bash 3.2, the Zoom copy-back and the SDK check run" {
  run in_bash32 '
    printf "%s\n" id1 secret1 token1 board1 "" | BWAT_MODE=production BWAT_BOARD_APP=1 setup/zoom-secrets /tmp/seed.json 2> /dev/null
    cat /tmp/seed.json
    : > /tmp/home/Downloads/zoom-plugin-sdk-windows-7.2.0.3001.zip
    setup/zoom-sdk /tmp/home/Downloads/zoom-plugin-sdk-windows-7.2.0.3001.zip || echo "zoom-sdk exit $?"'
  [[ "$output" == *'{"zoom.client_id":"id1","zoom.client_secret":"secret1","zoom.webhook_secret":"token1","zoom.board_client_secret":"board1"}'* ]]
  # docker run carries stdout and stderr on separate streams, so their order can vary.
  [[ "$output" == *'is not the Zoom Meeting SDK for Linux x86_64, 7.0.2.5001 or later'* ]]
  [[ "$output" == *'zoom-sdk exit 2'* ]]
}
