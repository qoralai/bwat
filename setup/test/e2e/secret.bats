#!/usr/bin/env bats
# ./bwat secret KEY: saves the clipboard to KEY's line in bwat.answers, so a secret is
# never typed, shown or left in the clipboard. A stand-in pbpaste and pbcopy on PATH
# hold the clipboard in a file.

load helpers

setup() {
  cd "$WORK"
  rm -f bwat.answers zoom-manifest.json zoom-board-manifest.json
  export HOME=$BATS_TEST_TMPDIR/home
  mkdir -p "$HOME/Downloads" "$BATS_TEST_TMPDIR/bin"
  clip=$BATS_TEST_TMPDIR/clip
  printf '#!/bin/sh\ncat "%s"\n' "$clip" > "$BATS_TEST_TMPDIR/bin/pbpaste"
  printf '#!/bin/sh\ncat > "%s"\n' "$clip" > "$BATS_TEST_TMPDIR/bin/pbcopy"
  chmod +x "$BATS_TEST_TMPDIR/bin/pbpaste" "$BATS_TEST_TMPDIR/bin/pbcopy"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  ./bwat prep > /dev/null
}

teardown() {
  rm -f "$WORK/bwat.answers"
}

@test "secret saves the clipboard to that key's line only, shows its last four, and clears the clipboard" {
  sed 's|^ZOOM_CLIENT_SECRET=.*|ZOOM_CLIENT_SECRET=zsecret-abcd1234|' bwat.answers > "$BATS_TEST_TMPDIR/expected"
  printf 'zsecret-abcd1234\n' > "$clip"
  run ./bwat secret ZOOM_CLIENT_SECRET
  [ "$status" -eq 0 ]
  [ "$output" = 'saved ZOOM_CLIENT_SECRET (…1234)' ]
  cmp bwat.answers "$BATS_TEST_TMPDIR/expected"
  [ "$(stat -c %a bwat.answers)" = 600 ]
  [ ! -s "$clip" ]
}

@test "a key with no line in bwat.answers is refused and nothing is written" {
  cp bwat.answers "$BATS_TEST_TMPDIR/before"
  printf 'zsecret-abcd1234' > "$clip"
  run ./bwat secret ZOOM_CLIENT_SECRT
  [ "$status" -eq 2 ]
  [[ "$output" == *'ZOOM_CLIENT_SECRT'* ]]
  [[ "$output" != *abcd1234* ]]
  cmp bwat.answers "$BATS_TEST_TMPDIR/before"
}

@test "a pattern instead of a key name is refused and nothing is written" {
  cp bwat.answers "$BATS_TEST_TMPDIR/before"
  printf 'zsecret-abcd1234' > "$clip"
  run ./bwat secret 'ZOOM.*'
  [ "$status" -eq 2 ]
  [[ "$output" != *saved* ]]
  cmp bwat.answers "$BATS_TEST_TMPDIR/before"
}

@test "an empty clipboard is refused and nothing is written" {
  cp bwat.answers "$BATS_TEST_TMPDIR/before"
  : > "$clip"
  run ./bwat secret ZOOM_CLIENT_SECRET
  [ "$status" -eq 2 ]
  [[ "$output" == *'clipboard is empty'* ]]
  cmp bwat.answers "$BATS_TEST_TMPDIR/before"
}

@test "secret KEY - saves stdin instead, leaves the clipboard alone, and shows only its last four" {
  sed 's|^ZOOM_CLIENT_SECRET=.*|ZOOM_CLIENT_SECRET=zsecret-from-the-page-9876|' bwat.answers > "$BATS_TEST_TMPDIR/expected"
  printf 'in the clipboard' > "$clip"
  run sh -c 'printf "zsecret-from-the-page-9876\r\n" | ./bwat secret ZOOM_CLIENT_SECRET -'
  [ "$status" -eq 0 ]
  [ "$output" = 'saved ZOOM_CLIENT_SECRET (…9876)' ]
  cmp bwat.answers "$BATS_TEST_TMPDIR/expected"
  [ "$(cat "$clip")" = 'in the clipboard' ]
}

@test "secret KEY - refuses empty stdin and writes nothing" {
  cp bwat.answers "$BATS_TEST_TMPDIR/before"
  run sh -c './bwat secret ZOOM_CLIENT_SECRET - < /dev/null'
  [ "$status" -eq 2 ]
  [[ "$output" == *'nothing on stdin'* ]]
  cmp bwat.answers "$BATS_TEST_TMPDIR/before"
}
