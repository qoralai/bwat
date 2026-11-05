#!/usr/bin/env bats
# The end-to-end slice (scripts/smoke-slice.sh) on the test host: a spoken commitment
# becomes a card on the board through the compose edge.

load helpers

SLICE_PROJECT=bwat-slice

setup_file() {
  (cd / && docker compose -p "$SLICE_PROJECT" down -v --remove-orphans)
}

setup() {
  cd "$WORK"
}

@test "A3: a spoken commitment becomes a card on the board through the compose edge" {
  {
    for name in POSTGRES_PASSWORD BWAT_OWNER_PASSWORD BWAT_RUNTIME_PASSWORD BWAT_CARDS_PASSWORD \
      BWAT_DEV_PERSON_TOKEN BWAT_CARDS_BACKEND_TOKEN; do
      echo "$name=$(openssl rand -hex 24)"
    done
    echo "BWAT_FEED_KEY=$(openssl rand -hex 32)"
  } >.env
  run bash scripts/smoke-slice.sh "$SLICE_PROJECT"
  [ "$status" -eq 0 ]
}
