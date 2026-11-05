#!/usr/bin/env bats
# A host where Docker already runs some other stack named bwat (an older
# checkout, say): the install takes the name bwat-local and leaves it alone.

load helpers

setup_file() {
  harness_reset
  (cd / && docker compose -p bwat-local down -v --remove-orphans)
  rm -rf "$WORK/.env" "$WORK/.bwat" "$WORK/zoom-manifest.json" "$WORK/zoom-board-manifest.json" "$WORK/bwat.answers"
  echo 'services: {other: {image: "busybox:1.36", command: [sleep, 1d]}}' |
    (cd / && docker compose -p bwat -f - up -d)
}

teardown_file() {
  (cd / && docker compose -p bwat-local down -v --remove-orphans)
  harness_reset
}

setup() {
  cd "$WORK"
}

@test "the install is named bwat-local and the other bwat stack keeps running" {
  BWAT_PUBLIC_URL=http://localhost:8080 BWAT_FIRST_OWNER_EMAIL=owner@example.com run ./bwat setup -y
  [ "$status" -eq 0 ]
  [[ "$output" == *'this install is named bwat-local'* ]]
  grep -qx 'COMPOSE_PROJECT_NAME=bwat-local' .env
  [ -n "$(docker ps -q --filter label=com.docker.compose.project=bwat)" ]
  run curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health
  [ "$output" = 200 ]
}
