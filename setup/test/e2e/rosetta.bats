#!/usr/bin/env bats
# On an Apple-silicon Mac, Docker Desktop's Rosetta emulation hangs the bot's x86_64
# build, so setup stops before building it. A stand-in uname plays the Mac, a fake
# HOME holds Docker Desktop's settings, and a fake docker records every call.

load helpers

setup() {
  cd "$WORK"
  rm -rf .env .bwat zoom-manifest.json zoom-board-manifest.json bwat.answers
  bin=$BATS_TEST_TMPDIR/bin
  mkdir -p "$bin" "$BATS_TEST_TMPDIR/home/Downloads"
  printf '#!/bin/sh\ncase "$*" in version*) echo 27.0.0; exit 0 ;; "compose version"*) echo 2.29.0; exit 0 ;; esac\necho "$*" >> "%s/docker.calls"\nexit 1\n' "$BATS_TEST_TMPDIR" > "$bin/docker"
  chmod +x "$bin/docker"
  export PATH="$bin:$PATH" HOME="$BATS_TEST_TMPDIR/home"
  docker_settings="$HOME/Library/Group Containers/group.com.docker"
  mkdir -p "$docker_settings"
}

teardown() {
  rm -rf "$WORK/.env" "$WORK/.bwat"
}

# A Mac with Apple silicon, as uname reports it.
apple_silicon() {
  printf '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n' > "$bin/uname"
  chmod +x "$bin/uname"
}

install() {
  run env BWAT_PUBLIC_URL=http://localhost:8080 BWAT_FIRST_OWNER_EMAIL=owner@example.com \
    ./bwat setup -y
}

@test "with Rosetta on in Docker Desktop, setup stops before building the bot and says how to turn it off" {
  apple_silicon
  printf '{\n  "UseVirtualizationFrameworkRosetta": true,\n  "AutoStart": false\n}\n' > "$docker_settings/settings-store.json"
  install
  [ "$status" -eq 2 ]
  [[ "$output" == *'Docker Desktop is using Rosetta for x86_64 emulation, which hangs the bot build.'* ]]
  [[ "$output" == *'untick "Use Rosetta for x86_64/amd64 emulation on Apple Silicon"'*'run ./bwat setup again.'* ]]
  if grep -q build "$BATS_TEST_TMPDIR/docker.calls"; then echo 'a docker build ran' >&2; return 1; fi
  [[ "$output" != *'No Zoom Meeting SDK archive found'* ]]
  # Before the first question: nobody collects every value first.
  [[ "$output" != *'Step 1 of'* ]]
}

@test "prep --check names Rosetta too, before setup is ever run" {
  apple_silicon
  printf '{"UseVirtualizationFrameworkRosetta": true}\n' > "$docker_settings/settings-store.json"
  ./bwat prep > /dev/null
  run ./bwat prep --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'Docker Desktop is using Rosetta'*'then run ./bwat prep --check again.'* ]]
}

@test "an older Docker Desktop's settings.json with Rosetta on stops setup too" {
  apple_silicon
  printf '{"useVirtualizationFrameworkRosetta": true}\n' > "$docker_settings/settings.json"
  install
  [ "$status" -eq 2 ]
  [[ "$output" == *'Docker Desktop is using Rosetta'* ]]
}

@test "with no Rosetta setting saved (Docker Desktop's default is on), setup stops too" {
  apple_silicon
  printf '{"AutoStart": false}
' > "$docker_settings/settings-store.json"
  install
  [ "$status" -eq 2 ]
  [[ "$output" == *'Docker Desktop is using Rosetta'* ]]
}

@test "with Rosetta off, setup goes on to the bot build" {
  apple_silicon
  printf '{"UseVirtualizationFrameworkRosetta": false}\n' > "$docker_settings/settings-store.json"
  install
  [[ "$output" == *'No Zoom Meeting SDK archive found'* ]]
  [[ "$output" != *'Docker Desktop is using Rosetta'* ]]
}

@test "on an Apple-silicon Mac without Docker Desktop's settings, there is no check" {
  apple_silicon
  rm -rf "$docker_settings"
  install
  [[ "$output" == *'No Zoom Meeting SDK archive found'* ]]
  [[ "$output" != *'Docker Desktop is using Rosetta'* ]]
}

@test "on a computer that is not an Apple-silicon Mac, Docker Desktop's settings are not checked" {
  printf '{"UseVirtualizationFrameworkRosetta": true}\n' > "$docker_settings/settings-store.json"
  install
  [[ "$output" == *'No Zoom Meeting SDK archive found'* ]]
  [[ "$output" != *'Docker Desktop is using Rosetta'* ]]
}

@test "when macOS keeps Docker Desktop's settings unreadable, setup says nothing and goes on" {
  apple_silicon
  # Unreadable as macOS makes it: a cat of it fails (here, it is a directory).
  mkdir "$docker_settings/settings-store.json"
  install
  [[ "$output" != *'Rosetta'* ]]
  [[ "$output" == *'No Zoom Meeting SDK archive found'* ]]
}

@test "BWAT_ROSETTA_CHECK=off skips the check" {
  apple_silicon
  printf '{"UseVirtualizationFrameworkRosetta": true}\n' > "$docker_settings/settings-store.json"
  BWAT_ROSETTA_CHECK=off install
  [[ "$output" != *'Docker Desktop is using Rosetta'* ]]
  [[ "$output" == *'No Zoom Meeting SDK archive found'* ]]
}
