#!/usr/bin/env bats
# The edge's port on this machine's loopback (BWAT_EDGE_PORT, 8080 unless given):
# never asked; prep and setup take the first free one, and the stack is deployed on it.
# A squatter container publishing 8080 stands in for whatever else holds the port.

load helpers

owner=(BWAT_FIRST_OWNER_EMAIL=owner@example.com)

squat() {
  docker rm -f squatter > /dev/null 2>&1 || true
  docker run -d --name squatter -p "$1:80" busybox:1.36 httpd -f -p 80 > /dev/null
}

setup_file() {
  harness_reset
  rm -rf "$WORK/.env" "$WORK/.bwat" "$WORK/zoom-manifest.json" "$WORK/zoom-board-manifest.json" "$WORK/bwat.answers"
}

# Later files bring up stacks of their own on the same ports.
teardown_file() {
  rm -f "$WORK/bwat.answers"
  docker rm -f squatter > /dev/null 2>&1 || true
  harness_reset
  rm -rf "$WORK/.env" "$WORK/.bwat"
}

setup() {
  cd "$WORK"
}

@test "--no-start writes .env and starts nothing, in either order with -y" {
  run env "${owner[@]}" BWAT_PUBLIC_URL=http://localhost:8080 ./bwat setup --no-start -y
  [ "$status" -eq 0 ]
  [[ "$output" == *'saved .env without starting bwat; run ./bwat setup to start it'* ]]
  grep -qx 'BWAT_EDGE_PORT=8080' .env
  grep -q '^POSTGRES_PASSWORD=.' .env
  [ -z "$(docker compose -p bwat ps -aq)" ]
  run env "${owner[@]}" BWAT_PUBLIC_URL=http://localhost:8080 ./bwat setup -y --no-start
  [ "$status" -eq 0 ]
  [[ "$output" == *'saved .env without starting bwat'* ]]
  [ -z "$(docker compose -p bwat ps -aq)" ]
  rm -rf .env .bwat
}

@test "with BWAT_EDGE_PORT=8181, -y installs on 127.0.0.1:8181 and nothing answers on 8080" {
  run env "${owner[@]}" BWAT_PUBLIC_URL=http://localhost:8181 BWAT_EDGE_PORT=8181 ./bwat setup -y
  [ "$status" -eq 0 ]
  grep -qx 'BWAT_EDGE_PORT=8181' .env
  grep -qx 'BWAT_PUBLIC_URL=http://localhost:8181' .env
  run curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8181/health
  [ "$output" = 200 ]
  run curl -sS -o /dev/null --max-time 5 http://127.0.0.1:8080/health
  [ "$status" -ne 0 ]
}

@test "a second -y run finds its own edge on the port and warns of nothing" {
  run ./bwat setup -y
  [ "$status" -eq 0 ]
  [[ "$output" == *'the stack is up and unchanged'* ]]
  [[ "$output" != *'is in use'* ]]
}

@test "a saved local address follows a new port" {
  run env BWAT_EDGE_PORT=8282 ./bwat setup -y
  [ "$status" -eq 0 ]
  grep -qx 'BWAT_PUBLIC_URL=http://localhost:8282' .env
  run curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8282/health
  [ "$output" = 200 ]
}

@test "prep writes the first free port from 8080 into bwat.answers" {
  harness_reset
  rm -rf .env .bwat bwat.answers
  squat 8080
  run ./bwat prep
  grep -qx 'BWAT_EDGE_PORT=8081' bwat.answers
  rm -f bwat.answers
}

@test "with -y, a busy port from bwat.answers moves to the next free one, and its local address follows" {
  harness_reset
  rm -rf .env .bwat
  squat 8080
  printf 'BWAT_EDGE_PORT=8080\nBWAT_PUBLIC_URL=http://localhost:8080\n' > bwat.answers
  run env "${owner[@]}" ./bwat setup -y --no-start
  rm -f bwat.answers
  [ "$status" -eq 0 ]
  [[ "$output" == *'Port 8080 is in use on this machine (not by bwat); bwat uses 8081. A proxy or tunnel forwarding to 8080 must now forward to 8081.'* ]]
  grep -qx 'BWAT_EDGE_PORT=8081' .env
  grep -qx 'BWAT_PUBLIC_URL=http://localhost:8081' .env
}

@test "interactive: a busy port is never asked about" {
  harness_reset
  rm -rf .env .bwat
  squat 8080
  # owner's email, bot name, Zoom app made, Jev, spare
  run bash -c "printf '%s\n' owner@example.com '' '' '' '' | ./bwat setup --tier local --no-start"
  [ "$status" -eq 0 ]
  [[ "$output" != *'Enter another port'* ]]
  [[ "$output" != *'The port bwat listens on'* ]]
  grep -qx 'BWAT_EDGE_PORT=8081' .env
  grep -qx 'BWAT_PUBLIC_URL=http://localhost:8081' .env
}

@test "a busy port with no free one above it stops setup instead of searching forever" {
  harness_reset
  rm -rf .env .bwat
  squat 65535
  printf 'BWAT_EDGE_PORT=65535\n' > bwat.answers
  run timeout 60 env "${owner[@]}" BWAT_PUBLIC_URL=http://localhost:65535 ./bwat setup -y --no-start
  rm -f bwat.answers
  docker rm -f squatter > /dev/null
  [ "$status" -eq 2 ]
  [[ "$output" == *'No free port from 65535 up to 65535 on this machine.'* ]]
}

@test "interactive: a local address typed on another port is refused, not replaced" {
  harness_reset
  rm -rf .env .bwat
  printf 'BWAT_EDGE_PORT=8080\n' > bwat.answers
  # The address: local asks none, production does.
  run bash -c "printf '%s\n' 'http://localhost:9999' | ./bwat setup --tier production --no-start"
  rm -f bwat.answers
  [ "$status" -eq 2 ]
  [[ "$output" == *'BWAT_PUBLIC_URL must be'*"(got 'http://localhost:9999')"* ]]
}

@test "interactive: a busy port from the environment is a warning, not a question" {
  harness_reset
  rm -rf .env .bwat
  squat 8080
  # owner's email, bot name, Zoom app made, Jev, spare
  run bash -c "printf '%s\n' owner@example.com '' '' '' '' | BWAT_EDGE_PORT=8080 ./bwat setup --tier local --no-start"
  [ "$status" -eq 0 ]
  [[ "$output" == *'warning: port 8080 is in use'* ]]
  [[ "$output" != *'Enter another port'* ]]
  [[ "$output" == *'Step 5 of 7: Start bwat'* ]]
}

@test "the backend's saved port, given as the edge's, is refused" {
  rm -rf .env .bwat
  printf 'BWAT_PORT=3000\n' > .env
  run env "${owner[@]}" BWAT_PUBLIC_URL=http://localhost:3000 BWAT_EDGE_PORT=3000 ./bwat setup -y
  [ "$status" -eq 2 ]
  rm -f .env
  [[ "$output" == *"BWAT_EDGE_PORT cannot be 3000, the backend's port (BWAT_PORT)"* ]]
}

@test "a port saved in .env wins over bwat.answers" {
  harness_reset
  rm -rf .env .bwat
  printf 'BWAT_EDGE_PORT=9090\n' > .env
  printf 'BWAT_EDGE_PORT=8080\n' > bwat.answers
  run env "${owner[@]}" BWAT_PUBLIC_URL=http://localhost:9090 ./bwat setup -y
  rm -f bwat.answers
  [ "$status" -eq 0 ]
  grep -qx 'BWAT_EDGE_PORT=9090' .env
  run curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:9090/health
  [ "$output" = 200 ]
}

@test "a port that is not a number from 1 to 65535, or 80 or 443 under caddy, is refused before anything is written" {
  rm -rf .env .bwat
  for port in 0 65536 80a 08080; do
    run env "${owner[@]}" BWAT_PUBLIC_URL=http://localhost:8080 BWAT_EDGE_PORT=$port ./bwat setup -y
    [ "$status" -eq 2 ]
    [[ "$output" == *'BWAT_EDGE_PORT must be a number from 1 to 65535'* ]]
  done
  run env "${owner[@]}" BWAT_PUBLIC_URL=https://bwat.test BWAT_TLS=caddy BWAT_EDGE_PORT=443 ./bwat setup -y
  [ "$status" -eq 2 ]
  [[ "$output" == *'BWAT_EDGE_PORT cannot be 80 or 443'* ]]
  [ ! -e .env ]
}
