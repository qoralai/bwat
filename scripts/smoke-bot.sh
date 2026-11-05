#!/usr/bin/env bash
# Local smoke test of the bot (QOR-4593, T067) against the docker compose stack.
# 1. The no-training guard (QOR-4628, D139): on its default route (OpenRouter) with no model
#    key served, the bot reads GET /v1/bot/settings and stays unready.
# 2. The lifecycle: pointed at a trusted stand-in transcription host, the bot goes ready, is
#    sent to a meeting, joins it (the fake bridge), heartbeats, and on SIGTERM withdraws and
#    hands the claim back.
# Prints status codes and states, never a token, link, meeting number or passcode.
#
#   docker compose -p botsmoke up -d --build --wait
#   scripts/smoke-bot.sh botsmoke
#   docker compose -p botsmoke -f docker-compose.yml -f docker-compose.bot.yml --profile bot down -v
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person
compose=(docker compose -p "$project" -f docker-compose.yml -f docker-compose.bot.yml --profile bot)
failed=0
# Prints one result line; a value outside the accepted ones fails the run (exit 1 at the end).
check() {  # check <label> <actual> <accepted>...
  local label="$1" actual="$2"; shift 2
  local ok=no want
  for want in "$@"; do [ "$actual" = "$want" ] && ok=yes; done
  [ "$ok" = yes ] || failed=1
  printf '%-25s %s  (want %s)%s\n' "$label:" "$actual" "$*" "$([ "$ok" = yes ] || echo '  FAIL')"
}
# Runs a command every 0.5 s until it succeeds, for up to 30 s.
poll() {
  for _ in $(seq 60); do "$@" && return 0; sleep 0.5; done
  return 1
}
fleet_has() { person_curl "$api/fleet" | json "(lambda rows: bool($1))(d['fleet'])" | grep -q True; }
# Waits up to 30 s for a Python expression over GET /fleet's rows (`rows`) to be true.
wait_fleet() { poll fleet_has "$1"; }

meeting="849$(printf '%08d' $((RANDOM * 32768 + RANDOM)) | tail -c 8)"
pass="botsmoke$RANDOM"

fleet="$(docker compose -p "$project" exec -T backend node dist/scripts/fleet-credential.js 2>/dev/null | tail -1)"
case "$fleet" in bwf_*) ;; *) echo "could not mint a fleet credential; is the stack up?" >&2; exit 1 ;; esac
# The bot's log events matching a Python expression over each event `e`, one per line.
bot_events() {
  "${compose[@]}" logs bot 2>/dev/null | python -c "
import sys, json
for line in sys.stdin:
    try: e = json.loads(line.split('|', 1)[-1])
    except ValueError: continue
    if $1: print(json.dumps(e))"
}
logged() { [ -n "$(bot_events "$1")" ]; }
# Waits up to 30 s for the bot to log an event matching the expression; prints yes or no.
wait_event() { poll logged "$1" && echo yes || echo no; }
# Starts a fresh bot container with the given env and waits for it to register; sets bot_id.
start_bot() {
  env BWAT_FLEET_CREDENTIAL="$fleet" "$@" "${compose[@]}" up -d --build --force-recreate --no-deps bot >/dev/null 2>&1
  registered="e.get('event') == 'bot.registered'"
  poll logged "$registered" || true
  bot_id="$(bot_events "$registered" | head -1 | json "d['bot_id']" 2>/dev/null || true)"
  check registered "$([ -n "$bot_id" ] && echo yes || echo no)" yes
  mine="[r for r in rows if r['bot_id'] == '$bot_id']"
}

# 1. Default route, no model key served: unready, never sent a meeting.
start_bot BWAT_ASR_URL= BWAT_ASR_TRUSTED_HOSTS=
check "no key: guard refused" "$(wait_event "e.get('event') == 'transcription.refused' and e.get('reason') == 'no_key'")" yes
check "no key: unready" "$(wait_event "e.get('event') == 'bot.not_ready' and e.get('reason') == 'transcription_unavailable'")" yes
check "no key: fleet" "$(person_curl "$api/fleet" | json "[r['ready'] for r in d['fleet'] if r['bot_id']=='$bot_id']")" "[False]"
reads="$("${compose[@]}" logs backend 2>/dev/null | grep -F "\"bot_id\":\"$bot_id\"" | grep -c -F '"bot.settings_read"' || true)"
check "settings read" "$([ "${reads:-0}" -ge 1 ] && echo yes || echo no)" yes

# 2. A trusted stand-in host: the lifecycle end to end.
start_bot BWAT_ASR_URL=http://asr.smoke.test/v1/audio/transcriptions BWAT_ASR_TRUSTED_HOSTS=asr.smoke.test

wait_fleet "$mine and $mine[0]['ready']" && r=ready || r=not-ready
check ready "$r" ready

sent="$(person_curl -X POST "$api/allocations" -d "{\"zoom_url\":\"https://zoom.us/j/$meeting?pwd=$pass\"}")"
id="$(echo "$sent" | json "d['id']")"
wait_fleet "$mine and $mine[0]['claim_id'] == '$id' and $mine[0].get('joined')" && j=joined || j=not-joined
check "sent, then joined" "$j" joined
check "claim state" "$(person_curl "$api/allocations" | json "[a['claim_state'] for a in d['allocations'] if a['id']=='$id']")" "['attending']"

"${compose[@]}" stop bot >/dev/null 2>&1   # SIGTERM: withdraw, leave, requeue
check "after SIGTERM, claim" "$(person_curl "$api/allocations" | json "[a['claim_state'] for a in d['allocations'] if a['id']=='$id']")" "['pending']" "['claimed']"
check "after SIGTERM, bot" "$(person_curl "$api/fleet" | json "[(r['ready'], r['busy']) for r in d['fleet'] if r['bot_id']=='$bot_id']")" "[(False, False)]"
person_curl -X PATCH "$api/allocations/$id" -d '{"recall":true}' >/dev/null

# Fixed strings from a file descriptor, so no secret sits in grep's arguments.
leaks="$("${compose[@]}" logs bot backend 2>&1 \
  | grep -c -F -f <(printf '%s\n' "$meeting" "$pass" "pwd=" "zoom.us" "Bearer " "$fleet" "bwb_") || true)"
check "log leaks" "$leaks" 0
exit "$failed"
