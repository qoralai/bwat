#!/usr/bin/env bash
# Local smoke test of the claim lifecycle (QOR-4571) against the docker compose stack:
# heartbeat, occurrence, recall, release, GET /allocations and GET /fleet.
# Prints status codes and response shapes, never a token, link, meeting number or passcode.
#
#   docker compose -p lifecycle up -d --build --wait
#   scripts/smoke.sh lifecycle && scripts/smoke-lifecycle.sh lifecycle
#   docker compose -p lifecycle down -v
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person
# A request's status code, then its body on the next line.
call() { curl -s -w '\n%{http_code}' -H 'content-type: application/json' "$@"; }

# Values that must never reach the backend log; fresh each run, so a rerun on the same
# stack does not meet the tombstone the last run left.
meeting="849$(printf '%08d' $((RANDOM * 32768 + RANDOM)) | tail -c 8)"
other="${meeting%?}$(( (${meeting: -1} + 1) % 10 ))"
third="${meeting%?}$(( (${meeting: -1} + 2) % 10 ))"
pass=lifesmoke
occ="$(python -c "import base64,os;print(base64.b64encode(os.urandom(15)).decode()[:18]+'/+Q==')")"
sha="$(printf 'd%.0s' $(seq 64))"
err=mic_lost_smoke
reason=host_ended_smoke
junk="Smoke free text $RANDOM$RANDOM"

fleet="$(docker compose -p "$project" exec -T backend node dist/scripts/fleet-credential.js 2>/dev/null | tail -1)"
reg="$(call -X POST "$api/bots/register" -H "authorization: Bearer $fleet" -d '{}' | body)"
bot="$(echo "$reg" | json "d['bot_token']")"
bot_id="$(echo "$reg" | json "d['bot_id']")"
call -X POST "$api/bots/ready" -H "authorization: Bearer $bot" -d '{}' >/dev/null
P=(-H "authorization: Bearer $person")
B=(-H "authorization: Bearer $bot")

sent="$(call -X POST "$api/allocations" "${P[@]}" -d "{\"zoom_url\":\"https://zoom.us/j/$meeting?pwd=$pass\"}")"
id="$(echo "$sent" | body | json "d['id']")"
echo "send:                    $(echo "$sent" | status) $(echo "$sent" | body | json "d['claim_state']")  (want 202 claimed)"

hb="$(call -X POST "$api/assignment/heartbeat" "${B[@]}" -d "{\"claim_id\":\"$id\",\"generation\":1,\"transcript_epoch\":1,\"state\":\"in_meeting\",\"joined\":true,\"recording\":true,\"hearing\":true,\"muted\":false,\"error\":\"$err\",\"dictionary_sha256\":\"$sha\",\"version\":\"smoke\"}")"
echo "heartbeat:               $(echo "$hb" | status) $(echo "$hb" | body | json "sorted(d)")"
# A report the backend cannot store (free text, a dictionary) is dropped; the lease is still renewed.
hb2="$(call -X POST "$api/assignment/heartbeat" "${B[@]}" -d "{\"claim_id\":\"$id\",\"generation\":1,\"joined\":true,\"error\":\"$junk\"}")"
echo "heartbeat, bad report:   $(echo "$hb2" | status)  (want 200)"
oc="$(call -X POST "$api/assignment/occurrence" "${B[@]}" -d "{\"claim_id\":\"$id\",\"generation\":1,\"occurrence_uuid\":\"$occ\"}")"
echo "occurrence:              $(echo "$oc" | status)  (want 200)"
# The epoch is per occurrence: the one declared before promotion is kept (it is the first), an older one is
# refused. The status is a snapshot stored even on a refused beat, so this one sends the full report.
echo "occurrence epoch:        $(echo "$oc" | body | json "d['transcript_epoch']")  (want 1)"
hb3="$(call -X POST "$api/assignment/heartbeat" "${B[@]}" -d "{\"claim_id\":\"$id\",\"generation\":1,\"transcript_epoch\":0,\"state\":\"in_meeting\",\"joined\":true,\"recording\":true,\"hearing\":true,\"muted\":false,\"error\":\"$err\",\"dictionary_sha256\":\"$sha\",\"version\":\"smoke\"}")"
echo "heartbeat, used epoch:   $(echo "$hb3" | status) $(echo "$hb3" | body | json "d['error']")  (want 409 stale_epoch)"
echo "patch, no person:        $(call -X PATCH "$api/allocations/$id" -d '{"recall":true}' | status)  (want 401)"
al="$(call "$api/allocations" "${P[@]}")"
echo "allocations:             $(echo "$al" | status) $(echo "$al" | body | json "[a['error'] for a in d['allocations'] if a['id']=='$id']")"
fl="$(call "$api/fleet" "${P[@]}")"
echo "fleet:                   $(echo "$fl" | status) $(echo "$fl" | body | json "[{k: r[k] for k in ('busy','stale','claim_state','joined','error')} for r in d['fleet'] if r['claim_id']=='$id']")"
echo "fleet, bot token:        $(call "$api/fleet" "${B[@]}" | status)  (want 401)"
stale="$(call -X POST "$api/assignment/heartbeat" "${B[@]}" -d "{\"claim_id\":\"$id\",\"generation\":9}")"
echo "heartbeat, old gen:      $(echo "$stale" | status) $(echo "$stale" | body | json "d['error']")  (want 409 stale_claim)"
rel="$(call -X POST "$api/assignment/release" "${B[@]}" -d "{\"claim_id\":\"$id\",\"generation\":1,\"reason\":\"$reason\",\"meeting_ended\":true}")"
echo "release (meeting ended): $(echo "$rel" | status) $(echo "$rel" | body | json "d['status']")  (want 200 released)"
echo "fleet busy after:        $(call "$api/fleet" "${P[@]}" | body | json "[r['busy'] for r in d['fleet'] if r['bot_id']=='$bot_id']")  (want [False])"

second="$(call -X POST "$api/allocations" "${P[@]}" -d "{\"zoom_url\":\"https://zoom.us/j/$other\"}" | body | json "d['id']")"
rc="$(call -X PATCH "$api/allocations/$second" "${P[@]}" -d '{"recall":true}')"
echo "recall held:             $(echo "$rc" | status) $(echo "$rc" | body | json "(d['claim_state'], d['refused_reason'])")  (want 200 refused recalled)"
echo "heartbeat after recall:  $(call -X POST "$api/assignment/heartbeat" "${B[@]}" -d "{\"claim_id\":\"$second\",\"generation\":1}" | status)  (want 409)"

# A failed placement is requeued by the backend from its reason; recall it afterwards.
third_id="$(call -X POST "$api/allocations" "${P[@]}" -d "{\"zoom_url\":\"https://zoom.us/j/$third\"}" | body | json "d['id']")"
rq="$(call -X POST "$api/assignment/release" "${B[@]}" -d "{\"claim_id\":\"$third_id\",\"generation\":1,\"reason\":\"waiting_room_timeout\"}")"
echo "release (failed join):   $(echo "$rq" | status) $(echo "$rq" | body | json "d['status']")  (want 200 requeued)"
echo "after the retry:         $(call "$api/allocations" "${P[@]}" | body | json "[a['claim_state'] for a in d['allocations'] if a['id']=='$third_id']")  (want ['claimed'] or ['pending'])"
call -X PATCH "$api/allocations/$third_id" "${P[@]}" -d '{"recall":true}' >/dev/null

# Withdraw this run's bot, so a rerun on the same stack is not handed to it.
echo "withdraw:                $(call -X POST "$api/bots/ready" "${B[@]}" -d '{"ready":false}' | status)"

leaks="$(docker compose -p "$project" logs backend 2>&1 | grep -c -E "$meeting|$other|$third|waiting_room_timeout|pwd=|$pass|${occ//+/\\+}|$sha|$err|$reason|$junk|Bearer " || true)"
echo "log lines with a meeting number, passcode, occurrence, status, free text or token: $leaks  (want 0)"
