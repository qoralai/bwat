#!/usr/bin/env bash
# Run the installer's end-to-end tests on a throwaway Docker-in-Docker host.
#
#   bash setup/test/run.sh                         # every file in setup/test/e2e
#   bash setup/test/run.sh setup/test/e2e/harness.bats
#
# Needs bash, git, GNU tar and Docker with Compose on the machine running it.
# The test host is removed on exit; KEEP=1 leaves it up for debugging.
set -euo pipefail

# Git Bash would otherwise rewrite /work into a Windows path.
export MSYS_NO_PATHCONV=1

repo=$(git rev-parse --show-toplevel)
cd "$repo"
# HARNESS_PROJECT lets two checkouts run the harness at once without sharing a host.
compose=(docker compose -p "${HARNESS_PROJECT:-bwat-installer-test}" -f setup/test/compose.yml)

# GNU tar: gtar where the system tar is bsdtar (macOS).
tar=$(command -v gtar || command -v tar)
if ! "$tar" --version 2>/dev/null | grep -q "GNU tar"; then
  echo "run.sh needs GNU tar (on macOS: brew install gnu-tar)" >&2
  exit 2
fi

# A fresh host each run; the inner Engine's image cache volume is kept.
"${compose[@]}" down --remove-orphans
if [ -z "${KEEP:-}" ]; then
  trap '"${compose[@]}" down --remove-orphans' EXIT
fi
"${compose[@]}" up -d --build --wait host

# The inner Engine's state survives in docker-cache, so containers an install
# left with a restart policy start again with the host. Remove them before the
# tree arrives: one with a bind mount would otherwise create its source as a
# directory (setup/Caddyfile) first, so that goes too.
"${compose[@]}" exec -T host sh -c 'docker ps -aq | xargs -r docker rm -f; rm -rf /work/setup'

# Stream in the tree as git sees it (tracked plus untracked, minus ignored),
# never a bind mount: a Windows mount reports every file as 0777 and can
# carry CRLF, which would hide the installer's line-ending checks.
git ls-files -z -co --exclude-standard |
  "$tar" --null --ignore-failed-read -T - -cf - |
  "${compose[@]}" exec -T host tar -xf - -C /work

# Set file modes from git's index, not the checkout: tar on Windows marks any
# file with a shebang executable. Every file becomes 0644, then the index's
# 100755 entries 0755, as a Linux clone has them.
git ls-files -s -z | while IFS= read -r -d '' entry; do
  path=${entry#*$'\t'}
  if [[ $entry == 100755* && -e $path ]]; then printf '%s\0' "$path"; fi
done | "${compose[@]}" exec -T host sh -c \
  'find . -type f -exec chmod 0644 {} + && xargs -0 -r chmod 0755 --'
"${compose[@]}" exec -T host cp setup/test/compose.pebble.yml compose.local.yml

if [ "$#" -eq 0 ]; then
  set -- setup/test/e2e
fi
"${compose[@]}" exec -T host bats --print-output-on-failure "$@"
