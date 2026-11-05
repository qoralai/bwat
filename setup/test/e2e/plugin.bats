#!/usr/bin/env bats
# setup/plugin (./bwat plugin): connects this computer's Claude Code to this install. A fake
# claude on PATH records every call; files in the test's directory say what it has installed
# and which address its bwat plugin holds.

load helpers

setup() {
  cd "$WORK"
  bin=$BATS_TEST_TMPDIR/bin
  mkdir -p "$bin"
  cat > "$bin/claude" <<EOF
#!/bin/sh
echo "\$*" >> "$BATS_TEST_TMPDIR/calls"
case "\$*" in
  "plugin marketplace list --json") [ -f "$BATS_TEST_TMPDIR/known" ] && echo '[{"name":"qoral-plugin-marketplace","source":"git"}]' || echo '[]' ;;
  "plugin list --json") [ -f "$BATS_TEST_TMPDIR/installed" ] && echo '[{"id":"bwat@qoral-plugin-marketplace"}]' || echo '[]' ;;
  "plugin configure bwat@qoral-plugin-marketplace --json") printf '{"inputs":{"base_url":"%s"}}\n' "\$(cat "$BATS_TEST_TMPDIR/url" 2>/dev/null)" ;;
  "plugin configure bwat@qoral-plugin-marketplace --values-stdin") cat > "$BATS_TEST_TMPDIR/stdin" ;;
esac
EOF
  chmod +x "$bin/claude"
  export PATH="$bin:$PATH"
  # The work tree's own .env, if a test before this one left one, comes back afterwards.
  [ ! -f .env ] || mv .env "$BATS_TEST_TMPDIR/env.kept"
  printf 'BWAT_PUBLIC_URL=http://localhost:8090\nBWAT_EDGE_PORT=8090\n' > .env
}

teardown() {
  rm -f .env
  [ ! -f "$BATS_TEST_TMPDIR/env.kept" ] || mv "$BATS_TEST_TMPDIR/env.kept" .env
}

@test "installs the plugin at 127.0.0.1 and the install's port, not localhost" {
  run ./bwat plugin
  [ "$status" -eq 0 ]
  grep -qx 'plugin marketplace add qoralai/qoral-plugin-marketplace' "$BATS_TEST_TMPDIR/calls"
  grep -qx 'plugin install bwat@qoral-plugin-marketplace --config base_url=http://127.0.0.1:8090/v1' "$BATS_TEST_TMPDIR/calls"
  [[ "$output" == *'/bwat:login'* ]]
}

@test "a marketplace this Claude Code already knows is refreshed, not added again" {
  touch "$BATS_TEST_TMPDIR/known"
  run ./bwat plugin
  [ "$status" -eq 0 ]
  grep -qx 'plugin marketplace update qoral-plugin-marketplace' "$BATS_TEST_TMPDIR/calls"
  run grep -q 'marketplace add' "$BATS_TEST_TMPDIR/calls"
  [ "$status" -eq 1 ]
  grep -qx 'plugin install bwat@qoral-plugin-marketplace --config base_url=http://127.0.0.1:8090/v1' "$BATS_TEST_TMPDIR/calls"
}

@test "an https address is the plugin's base URL as it is" {
  printf 'BWAT_PUBLIC_URL=https://bwat.test\n' > .env
  run ./bwat plugin
  grep -qx 'plugin install bwat@qoral-plugin-marketplace --config base_url=https://bwat.test/v1' "$BATS_TEST_TMPDIR/calls"
}

@test "a plugin already pointed here is updated and its address left as it is" {
  touch "$BATS_TEST_TMPDIR/installed"
  echo http://127.0.0.1:8090/v1 > "$BATS_TEST_TMPDIR/url"
  run ./bwat plugin
  [ "$status" -eq 0 ]
  grep -qx 'plugin update bwat@qoral-plugin-marketplace' "$BATS_TEST_TMPDIR/calls"
  [[ "$output" == *'already points at this bwat'* ]]
  ! grep -q 'install\|values-stdin' "$BATS_TEST_TMPDIR/calls"
}

@test "a plugin pointed at another bwat, or one whose address cannot be read, is left alone and named, with its own exit code" {
  touch "$BATS_TEST_TMPDIR/installed"
  echo https://other.example/v1 > "$BATS_TEST_TMPDIR/url"
  run ./bwat plugin
  [ "$status" -eq 3 ]
  [[ "$output" == *'points at another bwat, https://other.example/v1'*'./bwat plugin --repoint'* ]]
  : > "$BATS_TEST_TMPDIR/url"
  run ./bwat plugin
  [ "$status" -eq 3 ]
  [[ "$output" == *'could not read which address'* ]]
  ! grep -q 'values-stdin' "$BATS_TEST_TMPDIR/calls"
}

@test "--repoint points an installed plugin here, saying where it pointed before" {
  touch "$BATS_TEST_TMPDIR/installed"
  echo https://other.example/v1 > "$BATS_TEST_TMPDIR/url"
  run ./bwat plugin --repoint
  [ "$status" -eq 0 ]
  [ "$(cat "$BATS_TEST_TMPDIR/stdin")" = '{"base_url":"http://127.0.0.1:8090/v1"}' ]
  [[ "$output" == *'(it was https://other.example/v1)'* ]]
}

@test "without Claude Code it prints the commands to run where Claude Code is" {
  run env PATH=/usr/bin:/bin ./bwat plugin
  [ "$status" -eq 2 ]
  [[ "$output" == *'Claude Code is not installed'*'claude plugin install bwat@qoral-plugin-marketplace --config base_url=http://127.0.0.1:8090/v1'* ]]
}

@test "before setup it says to run setup first" {
  rm .env
  run ./bwat plugin
  [ "$status" -eq 2 ]
  [[ "$output" == *'run ./bwat setup first'* ]]
  [ ! -e "$BATS_TEST_TMPDIR/calls" ]
}
