#!/usr/bin/env bash
# Rate-limit smoke test (QOR-4625) against the docker compose stack, after scripts/smoke.sh:
# it recreates the backend with Google sign-in on and a budget of 3 failed sign-ins a
# minute, sends bad bearers until it answers 429, then recreates it as it was. Prints
# status codes only.
#
#   docker compose -p <project> up -d --build --wait
#   bash scripts/smoke.sh <project> && bash scripts/smoke-rate-limits.sh <project>
#   docker compose -p <project> down -v
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person
fails=0
want() { # label, got, wanted
  printf '%-36s %s  (want %s)\n' "$1:" "$2" "$3"
  [ "$2" = "$3" ] || fails=$((fails + 1))
}
me() { curl -s -o /dev/null -w '%{http_code}' "$api/me" -H "authorization: Bearer $1"; }
# The backend as compose has it, whatever happens below.
restore() { docker compose -p "$project" up -d --wait --no-deps backend >/dev/null 2>&1; }
trap restore EXIT

BWAT_GOOGLE_CLIENT_IDS=smoke.apps.invalid BWAT_ALLOWED_DOMAINS=smoke.invalid BWAT_RATE_LIMIT_SIGNIN_FAILURES_PER_MIN=3 \
  docker compose -p "$project" up -d --wait --no-deps backend >/dev/null 2>&1
want "bad bearers 1-3" "$(me not.a.token) $(me not.a.token) $(me not.a.token)" "401 401 401"
want "bad bearer 4" "$(me not.a.token)" 429
retry="$(curl -s -o /dev/null -D - "$api/me" -H 'authorization: Bearer not.a.token' | grep -ci '^retry-after: [1-9]' || true)"
want "Retry-After on it" "$retry" 1
want "dev token, same IP" "$(me "$person")" 200
want "rate_limited log lines" "$(docker compose -p "$project" logs backend 2>&1 | grep -c '"event":"rate_limited"' || true)" 2
[ "$fails" = 0 ] || { echo "FAIL: $fails step(s) did not answer as wanted"; exit 1; }
