#!/usr/bin/env bats
# ./bwat setup --web: the onboarding page. It finds or fetches a Node to run on, starts
# a server on this machine's loopback and prints a link to open.

load helpers

setup() {
  cd "$WORK"
  export HOME=$BATS_TEST_TMPDIR/home
  mkdir -p "$HOME"
  export BWAT_NO_BROWSER=1
  rm -rf .bwat/onboard .bwat/tools/node-*
}

teardown() {
  [ -z "${server:-}" ] || kill "$server" 2> /dev/null || true
}

# A stand-in node on PATH that reports $1 as its version and, unless $2 is no-ts, runs
# the finder's TypeScript check.
fake_node() {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  local ts='echo ok; exit 0'
  [ "${2:-}" = no-ts ] && ts='exit 9'
  printf '#!/bin/sh\ncase "$*" in *strip-check.ts*) %s ;; esac\necho %s\n' "$ts" "$1" > "$BATS_TEST_TMPDIR/bin/node"
  chmod +x "$BATS_TEST_TMPDIR/bin/node"
}

@test "setup --web prints a loopback link with the token in its fragment, and the page answers" {
  ./bwat setup --web > "$BATS_TEST_TMPDIR/out" 2>&1 &
  server=$!
  for _ in $(seq 50); do
    grep -q 'http://127.0.0.1:' "$BATS_TEST_TMPDIR/out" && break
    sleep 0.2
  done
  link=$(grep -o 'http://127.0.0.1:[0-9]*/#[0-9a-f]*' "$BATS_TEST_TMPDIR/out")
  [[ $link =~ ^http://127\.0\.0\.1:[0-9]+/#[0-9a-f]{64}$ ]]
  [ "$(stat -c %a .bwat/onboard/session)" = 600 ]
  run curl -fsS "${link%%#*}"
  [ "$status" -eq 0 ]
  [[ "$output" == *'bwat'* ]]
}

@test "setup --web refuses -y and --no-start" {
  run ./bwat setup --web -y
  [ "$status" -eq 2 ]
  run ./bwat setup --no-start --web
  [ "$status" -eq 2 ]
}

@test "the node finder uses a node on PATH at 22.6 or later" {
  fake_node 22.6.0
  PATH=$BATS_TEST_TMPDIR/bin:$PATH run setup/onboard/node
  [ "$status" -eq 0 ]
  [ "$output" = "$BATS_TEST_TMPDIR/bin/node" ]
}

@test "the node finder passes over a node built without TypeScript support" {
  fake_node 22.23.2 no-ts
  printf '#!/bin/sh\necho "musl libc (x86_64)" >&2\n' > "$BATS_TEST_TMPDIR/bin/ldd"
  chmod +x "$BATS_TEST_TMPDIR/bin/ldd"
  PATH=$BATS_TEST_TMPDIR/bin:$PATH run setup/onboard/node
  [ "$status" -eq 2 ]
  [[ "$output" != "$BATS_TEST_TMPDIR/bin/node" ]]
}

@test "the node finder fetches when PATH's node is too old, and refuses a download that fails its checksum" {
  fake_node 22.5.9
  # A Linux glibc host is what the fetch serves; the harness is Alpine (musl), so the
  # check stops before downloading. Pretend otherwise with a ldd that says glibc.
  printf '#!/bin/sh\necho "ldd (GNU libc) 2.39"\n' > "$BATS_TEST_TMPDIR/bin/ldd"
  chmod +x "$BATS_TEST_TMPDIR/bin/ldd"
  mkdir -p "$BATS_TEST_TMPDIR/dist/v22.23.3"
  arch=x64
  [ "$(uname -m)" = aarch64 ] && arch=arm64
  echo 'not node' > "$BATS_TEST_TMPDIR/dist/v22.23.3/node-v22.23.3-linux-$arch.tar.gz"
  PATH=$BATS_TEST_TMPDIR/bin:$PATH BWAT_NODE_DIST=file://$BATS_TEST_TMPDIR/dist run setup/onboard/node
  [ "$status" -eq 1 ]
  [[ "$output" == *"does not match node.lock's checksum"* ]]
  [ ! -e ".bwat/tools/node-v22.23.3-linux-$arch" ]
}

@test "the node finder refuses a musl system it cannot fetch for" {
  fake_node 20.0.0
  printf '#!/bin/sh\necho "musl libc (x86_64)" >&2\n' > "$BATS_TEST_TMPDIR/bin/ldd"
  chmod +x "$BATS_TEST_TMPDIR/bin/ldd"
  PATH=$BATS_TEST_TMPDIR/bin:$PATH run setup/onboard/node
  [ "$status" -eq 2 ]
  [[ "$output" == *musl* ]]
}

# Starts setup --web and sets $base and $auth for curl.
start_page() {
  ./bwat setup --web > "$BATS_TEST_TMPDIR/out" 2>&1 &
  server=$!
  for _ in $(seq 50); do
    grep -q 'http://127.0.0.1:' "$BATS_TEST_TMPDIR/out" && break
    sleep 0.2
  done
  link=$(grep -o 'http://127.0.0.1:[0-9]*/#[0-9a-f]*' "$BATS_TEST_TMPDIR/out")
  base=${link%%/#*}
  auth="authorization: Bearer ${link##*#}"
}

# POST JSON to the page's API, as the page does.
post() {
  curl -fsS -H "$auth" -H "origin: $base" -H 'content-type: application/json' -d "$2" "$base$1"
}

# Waits for the command's run to finish and prints its record.
finished_run() {
  for _ in $(seq 100); do
    run_json=$(curl -fsS -H "$auth" "$base/api/runs")
    if python3 -c "import json,sys; r=[x for x in json.load(sys.stdin)['runs'] if x['id']=='$1']; sys.exit(0 if r and 'exit' in r[0] else 1)" <<< "$run_json"; then
      echo "$run_json"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

@test "the page runs ./bwat prep on its own when there is no bwat.answers, and a secret saved through it lands there" {
  rm -f bwat.answers
  start_page
  runs=$(finished_run prep-manifests)
  [[ "$runs" == *'"exit":0'* ]]
  # The page fills the answers in its later steps: no terminal steps, no key names.
  [[ "$runs" == *'Answers file created.'* ]]
  [[ "$runs" != *'Fill '* ]]
  [[ "$runs" != *'manifests come once'* ]]
  [ -f bwat.answers ]
  [ "$(stat -c %a bwat.answers)" = 600 ]
  run post /api/secret '{"key":"ZOOM_CLIENT_SECRET","value":"zsecret-from-the-page-9876"}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"last4":"9876"'* ]]
  [[ "$output" != *zsecret* ]]
  grep -qx 'ZOOM_CLIENT_SECRET=zsecret-from-the-page-9876' bwat.answers
  post /api/run '{"id":"prep-check","command":"./bwat prep --check"}'
  runs=$(finished_run prep-check)
  [[ "$runs" == *'"id":"prep-check"'*'"exit":1'* ]]
  rm -f bwat.answers
}

@test "./bwat onboard mcp answers MCP's initialize over stdio, and says when no page runs" {
  rm -f .bwat/onboard/session
  run sh -c 'printf "%s\n%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_state\",\"arguments\":{}}}" | timeout 10 ./bwat onboard mcp'
  [[ "$output" == *'"protocolVersion":"2025-06-18"'* ]]
  [[ "$output" == *'"serverInfo":{"name":"bwat-onboard"'* ]]
  [[ "$output" == *'./bwat setup --web first'* ]]
}

@test "./bwat docs leaves nothing to change on a clean tree, and names what it writes after a hand edit" {
  cp docs/onboarding.md "$BATS_TEST_TMPDIR/guide.md"
  run ./bwat docs
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  cmp docs/onboarding.md "$BATS_TEST_TMPDIR/guide.md"
  echo "a hand edit" >> docs/onboarding.md
  run ./bwat docs
  [ "$status" -eq 0 ]
  [[ "$output" == *"wrote docs/onboarding.md"* ]]
  cmp docs/onboarding.md "$BATS_TEST_TMPDIR/guide.md"
}
