#!/usr/bin/env bats
# Once setup/zoom-sdk has built the bot image on this host, setup runs the bot
# with the fleet credential it minted. A stand-in image takes the real one's
# name here: the Zoom SDK never reaches the test host.

load helpers

setup_file() {
  harness_reset
  rm -rf "$WORK/.env" "$WORK/.bwat" "$WORK/zoom-manifest.json" "$WORK/zoom-board-manifest.json" "$WORK/bwat.answers"
  printf 'FROM busybox:1.36\nCMD ["sleep", "1d"]\n' | docker build -q -t bwat-bot:zoom -
}

teardown_file() {
  harness_reset
  docker image rm bwat-bot:zoom
}

setup() {
  cd "$WORK"
}

@test "with the bot image built, setup runs the bot with the fleet credential" {
  BWAT_PUBLIC_URL=http://localhost:8080 BWAT_FIRST_OWNER_EMAIL=owner@example.com run ./bwat setup -y
  [ "$status" -eq 0 ]
  # No SDK archive on the test host: the image there, unlabelled, is kept and said so.
  [[ "$output" == *'keeping the meeting bot from an earlier bwat'* ]]
  grep -qx 'COMPOSE_PROFILES=zoom' .env
  [ -n "$(docker compose ps -q --status running bot-zoom)" ]
  fleet=$(sed -n 's/^BWAT_FLEET_CREDENTIAL=//p' .env)
  docker compose exec -T bot-zoom env | grep -qx "BWAT_FLEET_CREDENTIAL=$fleet"
}
