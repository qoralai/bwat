#!/usr/bin/env bash
# Zoom join-token smoke test (QOR-4581) against the docker compose stack, after
# scripts/smoke.sh. Prints status codes and error codes only: never a token, a passcode
# or a meeting number.
#
#   docker compose -p <project> up -d --build --wait
#   bash scripts/smoke.sh <project>
#   bash scripts/smoke-zoom-tokens.sh <project>
#   docker compose -p <project> down -v
#
# The local stack has no Zoom app credentials (zoom.client_id, zoom.client_secret and the
# zoom.s2s_* names are not seeded, and real ones are not available locally), so this
# checks the route, its fence and its not_configured answer. Minting the SDK JWT, the
# recording token, the S2S token cache and the meeting lookup are covered by the unit
# tests (test/join-token.test.ts, test/zoom-api.test.ts, test/zoom-passcode-lookup.test.ts),
# against a fake Zoom; nothing here calls Zoom. The claim is pinned to this script's bot
# with psql, so the script does not depend on which ready bot allocation picks.
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person
# A POST's body, then its status on its own line.
post() { curl -s -w '\n%{http_code}' -X POST "$api$1" -H "authorization: Bearer $2" -H 'content-type: application/json' -d "$3"; }
fails=0
want() { # label, got, wanted
  printf '%-34s %s  (want %s)\n' "$1:" "$2" "$3"
  [ "$2" = "$3" ] || fails=$((fails + 1))
}

# Must never reach a log; fresh each run.
meeting="851$(printf '%08d' $((RANDOM * 32768 + RANDOM)) | tail -c 8)"
pass="tokensmoke$RANDOM"

fleet="$(docker compose -p "$project" exec -T backend node dist/scripts/fleet-credential.js 2>/dev/null | tail -1)"
reg="$(post /bots/register "$fleet" '{}' | body)"
bot="$(echo "$reg" | json "d['bot_token']")"
bot_id="$(echo "$reg" | json "d['bot_id']")"
claim="$(post /allocations "$person" "{\"zoom_url\":\"https://zoom.us/j/$meeting?pwd=$pass\"}" | body | json "d['id']")"
psql_c "UPDATE bwat.claims SET bot_id = '$bot_id', state = 'claimed', generation = 1, lease_until = now() + interval '10 minutes' WHERE id = '$claim'" >/dev/null
want "claim pinned (psql)" "$(psql_c "SELECT count(*) FROM bwat.claims WHERE id = '$claim' AND bot_id = '$bot_id'")" 1

fence() { echo "{\"claim_id\":\"$claim\",\"generation\":$1}"; }
want "join-token, no token" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$api/assignment/join-token" -H 'content-type: application/json' -d "$(fence 1)")" 401
want "join-token, bad body" "$(post /assignment/join-token "$bot" '{}' | status)" 400
stale="$(post /assignment/join-token "$bot" "$(fence 9)")"
want "join-token, stale claim" "$(echo "$stale" | status) $(echo "$stale" | body | json "d['error']")" "409 stale_claim"
held="$(post /assignment/join-token "$bot" "$(fence 1)")"
want "join-token, no Zoom app" "$(echo "$held" | status) $(echo "$held" | body | json "d['error']")" "503 not_configured"
want "join-token, cache-control" "$(curl -s -o /dev/null -D - -X POST "$api/assignment/join-token" -H "authorization: Bearer $bot" -H 'content-type: application/json' -d "$(fence 1)" | tr -d '\r' | grep -i '^cache-control:' | cut -d' ' -f2)" no-store

# Leave nothing held for the next script: the claim ends, the bot was never ready.
want "release" "$(post /assignment/release "$bot" "{\"claim_id\":\"$claim\",\"generation\":1}" | status)" 200

leaks="$(docker compose -p "$project" logs backend 2>&1 | grep -c -E "$meeting|$pass|pwd=|Bearer |eyJ" || true)"
want "log lines with a secret" "$leaks" 0
[ "$fails" = 0 ] || { echo "FAIL: $fails step(s) did not answer as wanted"; exit 1; }
