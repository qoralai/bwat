#!/usr/bin/env bats
# Harness self-test. Runs inside the test host that setup/test/run.sh starts:
# a privileged docker:dind container holding a copy of the tree at /work.
# It proves the two things every installer test relies on: the host's own
# dockerd answers, and the Pebble ACME test CA answers over verified HTTPS.

load helpers

setup_file() {
  harness_pebble_up
}

@test "the test host's inner dockerd answers docker info" {
  run docker info --format '{{.ServerVersion}}'
  [ "$status" -eq 0 ]
  [ -n "$output" ]
}

@test "Pebble's ACME directory answers over HTTPS signed by its test root" {
  run curl -fsS --retry 30 --retry-delay 1 --retry-all-errors \
    --cacert "$PEBBLE_LISTENER_ROOT" "$PEBBLE_DIRECTORY"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"newNonce"'* ]]
  [[ "$output" == *'"newOrder"'* ]]
}

@test "Pebble's listener root is a CA certificate, not a leaf" {
  run openssl x509 -in "$PEBBLE_LISTENER_ROOT" -noout -ext basicConstraints
  [ "$status" -eq 0 ]
  [[ "$output" == *'CA:TRUE'* ]]
}

@test "the streamed tree keeps git's file modes, not the checkout's" {
  # 100755 in the index.
  [ -x "$WORK/setup/test/run.sh" ]
  # 100644 in the index, though each starts with a shebang.
  [ ! -x "$WORK/setup/test/e2e/harness.bats" ]
}

@test "the harness leaves the compose project name to the installer" {
  [ -z "${COMPOSE_PROJECT_NAME+set}" ]
}
