#!/usr/bin/env bats
# setup/zoom-sdk: the bot image is built on this host from the Zoom Meeting SDK
# archive the company downloaded. A fake docker on PATH records every call, so
# these tests show what is refused before any build starts.

load helpers

setup() {
  cd "$WORK"
  mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/home/Downloads"
  printf '#!/bin/sh\necho "$*" >> "%s/docker.calls"\n' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/bin/docker"
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH" HOME="$BATS_TEST_TMPDIR/home"
}

@test "another Zoom SDK file exits 2 naming the SDK to download and where" {
  archive=$BATS_TEST_TMPDIR/zoom-plugin-sdk-windows-7.2.0.3001.zip
  : > "$archive"
  run setup/zoom-sdk "$archive"
  [ "$status" -eq 2 ]
  [[ "$output" == *'is not the Zoom Meeting SDK for Linux x86_64, 7.0.2.5001 or later'* ]]
  [[ "$output" == *'Features > Embed > Meeting SDK'* ]]
  [ ! -e "$BATS_TEST_TMPDIR/docker.calls" ]
}

@test "under WSL, the SDK downloaded in Windows is found" {
  mkdir -p /mnt/c/Users/someone/Downloads
  : > /mnt/c/Users/someone/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz
  run setup/zoom-sdk
  rm -rf /mnt/c
  [[ "$output" == *'building the bot from /mnt/c/Users/someone/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz'* ]]
}

@test "with no archive given or downloaded, it says where to get one" {
  run setup/zoom-sdk
  [ "$status" -eq 2 ]
  [[ "$output" == *'No Zoom Meeting SDK archive found'*"download the Linux x86_64 SDK (Zoom's latest is fine)"* ]]
  # Nobody at a terminal (bats gives no tty): no waiting.
  [[ "$output" != *'Waiting up to'* ]]
  [ ! -e "$BATS_TEST_TMPDIR/docker.calls" ]
}

@test "run by a relative path from inside setup/, a missing archive still gets the guidance" {
  cd setup
  run ./zoom-sdk /nonexistent
  [ "$status" -eq 2 ]
  [[ "$output" == *'No Zoom Meeting SDK archive found'*'Features > Embed > Meeting SDK'* ]]
}

@test "an archive named relative to where it is run from is found" {
  cd "$BATS_TEST_TMPDIR"
  : > zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz
  run "$WORK/setup/zoom-sdk" ./zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz
  [[ "$output" == *"building the bot from $BATS_TEST_TMPDIR/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz"* ]]
}

@test "a newer download of another SDK version is passed over for the pinned one" {
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz"
  touch -t 202001010000 "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz"
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.0.1000.tar.xz"
  run setup/zoom-sdk
  [[ "$output" == *"building the bot from $HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz"* ]]
}

@test "Zoom's latest alone is built, saying it is untested" {
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz"
  run setup/zoom-sdk
  [[ "$output" == *"building the bot from $HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz"*'This is version 7.1.5.4432; bwat is tested with 7.0.2.5001'* ]]
}

@test "of two newer versions, the newer one is built, by number, not by name" {
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.10.1.tar.xz"
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.9.9.tar.xz"
  run setup/zoom-sdk
  [[ "$output" == *"building the bot from $HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.10.1.tar.xz"* ]]
  [ "$(setup/zoom-sdk --find)" = "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.10.1.tar.xz" ]
}

@test "a version older than the tested one is named, and refused" {
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-6.5.0.1.tar.xz"
  run setup/zoom-sdk
  [ "$status" -eq 2 ]
  [[ "$output" == *"Found $HOME/Downloads/zoom-meeting-sdk-linux_x86_64-6.5.0.1.tar.xz, but bwat needs the Zoom Meeting SDK for Linux x86_64, 7.0.2.5001 or later"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/docker.calls" ]
  run setup/zoom-sdk --find
  [ "$status" -eq 1 ]
}

@test "a download still going is not built, and says so" {
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz.crdownload"
  run setup/zoom-sdk
  [ "$status" -eq 2 ]
  [[ "$output" == *'is still downloading'* ]]
}

@test "Firefox's empty file beside its .part is a download still going" {
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz"
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz.part"
  run setup/zoom-sdk
  [ "$status" -eq 2 ]
  [[ "$output" == *'is still downloading'* ]]
}

@test "on the setup page it opens the Marketplace, waits for the download, then builds it" {
  # The setup page runs every command with BWAT_NO_BROWSER set: that does not stop this page.
  printf '#!/bin/sh
echo "$*" >> "%s/opened"
' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/bin/xdg-open"
  chmod +x "$BATS_TEST_TMPDIR/bin/xdg-open"
  ( sleep 2; echo sdk > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz" ) &
  BWAT_NO_BROWSER=1 BWAT_ONBOARD_PAGE=1 BWAT_SDK_WAIT_SECONDS=30 run setup/zoom-sdk
  [[ "$output" == *'Waiting up to 1 minute for the download'*'building the bot from'*'7.1.5.4432'* ]]
  grep -qx 'https://marketplace.zoom.us/' "$BATS_TEST_TMPDIR/opened"
}

@test "BWAT_SDK_WAIT=off does not wait, even on the page" {
  BWAT_ONBOARD_PAGE=1 BWAT_SDK_WAIT=off run setup/zoom-sdk
  [ "$status" -eq 2 ]
  [[ "$output" != *'Waiting up to'* ]]
}

@test "a file dropped on the setup page is found, and taken over a newer download" {
  mkdir -p .bwat/sdk
  : > .bwat/sdk/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz
  touch -t 202001010000 .bwat/sdk/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.4.1.tar.xz"
  found=$(setup/zoom-sdk --find)
  rm -rf .bwat/sdk
  # A full path: prepare-vendor.sh runs from bot/sdk, and the page stats it from its own cwd.
  [ "$found" = "$WORK/.bwat/sdk/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz" ]
}

@test "a build the setup page started is waited for, not run twice at once" {
  mkdir -p .bwat/sdk/build.lock
  sleep 3 &
  holder=$!
  echo "$holder" > .bwat/sdk/build.lock/pid
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz"
  BWAT_SDK_LOCK_POLL=1 run setup/zoom-sdk
  [ ! -e .bwat/sdk/build.lock ] || { rm -rf .bwat/sdk; false; }
  rm -rf .bwat/sdk
  [[ "$output" == *'already being built (the setup page started it); waiting'*'building the bot from'* ]]
  # The waiting line is said once, however long the wait.
  [ "$(grep -c 'already being built' <<< "$output")" -eq 1 ]
}

@test "a lock left by a build that died is taken over at once" {
  mkdir -p .bwat/sdk/build.lock
  ( exit 0 ) &
  dead=$!
  wait "$dead"
  echo "$dead" > .bwat/sdk/build.lock/pid
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.0.2.5001.tar.xz"
  run setup/zoom-sdk
  rm -rf .bwat/sdk
  [[ "$output" != *'already being built'* ]]
  [[ "$output" == *'building the bot from'* ]]
}

@test "a newer version that built here before says so, not that it is untested" {
  mkdir -p .bwat/sdk
  echo "7.1.5.4432 $(printf 'c%.0s' {1..64})" > .bwat/sdk/built
  : > "$HOME/Downloads/zoom-meeting-sdk-linux_x86_64-7.1.5.4432.tar.xz"
  run setup/zoom-sdk
  rm -rf .bwat/sdk
  [[ "$output" == *'This is version 7.1.5.4432, which has built on this computer before'* ]]
  [[ "$output" != *'Building it all the same'* ]]
}
