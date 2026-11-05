#!/usr/bin/env bash
# End-to-end slice (QOR-4654): a commitment spoken in a meeting becomes a card on the board.
# Brings up a fresh compose stack (docker-compose.yml + .bot.yml + .slice.yml) whose bot runs
# the fake bridge, whose transcription host and card model are scripts/slice-stub.py, then:
# the dev person sends the bot to a meeting; within 15 s of Joined the board's own path through
# the compose edge (GET /v1/occurrences/{id}/cards) shows one card quoting "ship it on friday"
# owned by the dev member; PUT owner with its revision is 200, with the old revision 409; and
# the backend-only GET /v1/cards/{id}/brief is not on the door (404, D169). The card service's
# first stored poll is 10 minutes away, so the card arrives in time only through its dial of
# the bot's live feed, and no dial may fail: the feed handshake (backend token, bot proof, card
# service MAC) holds end to end.
# Prints status codes and states, never a token, link, meeting number or passcode.
#
#   scripts/smoke-slice.sh [project]     # needs .env (see .env.docker.example); KEEP=1 keeps the stack
set -euo pipefail
project="${1:-bwat-slice}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
edge_port="$(env_value BWAT_EDGE_PORT)"; edge_port="${edge_port:-8080}"
need_person
[ -n "$(env_value BWAT_FEED_KEY)" ] || { echo "set BWAT_FEED_KEY in .env: the card comes over the live feed" >&2; exit 1; }
api="http://127.0.0.1:${edge_port}/v1"  # the board's relative /v1 paths, through the edge
compose=(docker compose -p "$project" -f docker-compose.yml -f docker-compose.bot.yml -f docker-compose.slice.yml)
failed=0
check() {  # check <label> <actual> <accepted>...
  local label="$1" actual="$2"; shift 2
  local ok=no want
  for want in "$@"; do [ "$actual" = "$want" ] && ok=yes; done
  [ "$ok" = yes ] || failed=1
  printf '%-25s %s  (want %s)%s\n' "$label:" "$actual" "$*" "$([ "$ok" = yes ] || echo '  FAIL')"
}
# Stops the run at a check whose later steps cannot go on without it.
require() { check "$@"; [ "$failed" = 0 ] || exit 1; }
# Runs a command every 0.5 s until it succeeds, for up to $1 seconds.
poll() {
  local secs="$1"; shift
  for _ in $(seq $((secs * 2))); do "$@" && return 0; sleep 0.5; done
  return 1
}

"${compose[@]}" --profile bot down -v --remove-orphans >/dev/null 2>&1
[ -n "${KEEP:-}" ] || trap '"${compose[@]}" --profile bot down -v --remove-orphans >/dev/null 2>&1' EXIT
# The backend first: the two credentials are minted in its image, before the card service
# and the bot start with them.
"${compose[@]}" up -d --build --wait --quiet-pull backend >/dev/null
mint() { "${compose[@]}" exec -T backend node "dist/scripts/$1.js" --label "$2" 2>/dev/null | tail -1 || true; }
fleet="$(mint fleet-credential slice)"; cards="$(mint cards-credential cards)"
require "fleet credential" "${fleet%%_*}" bwf
require "cards credential" "${cards%%_*}" bwc
BWAT_FLEET_CREDENTIAL="$fleet" BWAT_CARDS_CREDENTIAL="$cards" \
  "${compose[@]}" --profile bot up -d --build --wait --quiet-pull >/dev/null

me="$(person_curl -w '\n%{http_code}' "$api/me" || true)"
require "GET /me via edge" "$(tail -1 <<<"$me")" 200
member="$(head -1 <<<"$me" | json "d['id']")"

fleet_has() { person_curl "$api/fleet" | json "(lambda rows: bool($1))(d['fleet'])" | grep -q True; }
poll 60 fleet_has "rows and rows[0]['ready']" && r=ready || r=not-ready
require "bot ready" "$r" ready

meeting="849$(printf '%08d' $((RANDOM * 32768 + RANDOM)) | tail -c 8)"
pass="slice$RANDOM"
person_curl -X POST "$api/allocations" -d "{\"zoom_url\":\"https://zoom.us/j/$meeting?pwd=$pass\"}" >/dev/null
poll 30 fleet_has "rows[0].get('joined')" && j=joined || j=not-joined
require "sent, then joined" "$j" joined
joined_at=$SECONDS

# The allocation's meeting: the only one on a fresh stack. The card API names it by its id.
has_meeting() { person_curl "$api/meetings" | json "d['meetings'][0]['id']" 2>/dev/null; }
occ="$(poll 15 has_meeting || true)"
require "meeting listed" "$([ -n "$occ" ] && echo yes || echo no)" yes

cards_json() { person_curl "$api/occurrences/$occ/cards"; }
board="[]"
# Keeps the response it judged, so the deadline is measured on the card actually seen.
has_card() { board="$(cards_json)"; [ "$(json "len(d) if isinstance(d, list) else -1" <<<"$board" 2>/dev/null)" = 1 ]; }
poll 15 has_card || true
waited=$((SECONDS - joined_at))
check "cards on the board" "$(json "len(d) if isinstance(d, list) else -1" <<<"$board" 2>/dev/null || echo none)" 1
check "within 15 s of Joined" "$([ "$waited" -le 15 ] && echo yes || echo "no (${waited}s)")" yes
check "quote" "$(json "d[0]['evidence'][0]['quote']" <<<"$board" 2>/dev/null)" "ship it on friday"
check "owner is the dev member" "$(json "d[0]['owner_member_id'] == '$member'" <<<"$board" 2>/dev/null)" True
card="$(json "d[0]['id']" <<<"$board" 2>/dev/null || true)"
revision="$(json "d[0]['revision']" <<<"$board" 2>/dev/null || true)"

put_owner() {
  person_curl -o /dev/null -w '%{http_code}' -X PUT "$api/cards/$card/owner" \
    -d "{\"owner_member_id\":null,\"revision\":$1}"
}
check "PUT owner, revision" "$(put_owner "${revision:-0}")" 200
check "PUT owner, old revision" "$(put_owner "${revision:-0}")" 409
check "brief not on the door" "$(person_curl -o /dev/null -w '%{http_code}' "$api/cards/$card/brief")" 404

# Fixed strings from a file descriptor, so no secret sits in grep's arguments.
logs="$("${compose[@]}" --profile bot logs 2>&1)"
check "logs captured" "$([ -n "$logs" ] && echo yes || echo no)" yes
# The card in time means the card service dialled the feed; it logs every dial that was
# refused, broke or closed, so none means the handshake held.
check "feed dials that failed" "$(grep -c -F 'feed for claim' <<<"$logs" || true)" 0
leaks="$(grep -c -F -f <(printf '%s\n' "$meeting" "$pass" "pwd=" "$person" "$fleet" "$cards") <<<"$logs" || true)"
check "log leaks" "$leaks" 0
exit "$failed"
