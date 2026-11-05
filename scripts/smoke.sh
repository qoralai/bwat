#!/usr/bin/env bash
# Local smoke test against the docker compose stack: the "run it in Docker" check every
# backend PR does before merge. Prints status codes and response shapes, never a token,
# link, meeting number or passcode.
#
#   docker compose -p bwat-smoke up -d --build --wait
#   scripts/smoke.sh bwat-smoke
#   docker compose -p bwat-smoke down -v
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person

echo "health:              $(curl -s "$base/health")"
fleet="$(docker compose -p "$project" exec -T backend node dist/scripts/fleet-credential.js 2>/dev/null | tail -1)"
echo "fleet credential:    issued (${#fleet} chars)"
reg="$(curl -s -X POST "$api/bots/register" -H "authorization: Bearer $fleet" -H 'content-type: application/json' -d '{}')"
echo "register keys:       $(echo "$reg" | json 'sorted(d)')"
bot="$(echo "$reg" | json "d.get('bot_token','')")"
echo "assignment (fleet):  $(code "$api/assignment" -H "authorization: Bearer $fleet")  (want 409 unregistered_bot)"
echo "ready:               $(code -X POST "$api/bots/ready" -H "authorization: Bearer $bot" -H 'content-type: application/json' -d '{}')"
echo "send, no person:     $(code -X POST "$api/allocations" -H 'content-type: application/json' -d '{"zoom_url":"https://zoom.us/j/84949765022"}')  (want 401)"
echo "send, bad link:      $(code -X POST "$api/allocations" -H "authorization: Bearer $person" -H 'content-type: application/json' -d '{"zoom_url":"https://example.com/j/1"}')  (want 422)"
send="$(curl -s -w '\n%{http_code}' -X POST "$api/allocations" -H "authorization: Bearer $person" -H 'content-type: application/json' -d '{"zoom_url":"https://zoom.us/j/84949765022?pwd=smoke"}')"
echo "send:                $(echo "$send" | tail -1) $(echo "$send" | head -1 | json "{k: d[k] for k in ('claim_state','status') if k in d}")"
again="$(curl -s -w '\n%{http_code}' -X POST "$api/allocations" -H "authorization: Bearer $person" -H 'content-type: application/json' -d '{"zoom_url":"https://zoom.us/j/84949765022?pwd=smoke"}')"
echo "send again:          $(echo "$again" | tail -1) $(echo "$again" | head -1 | json "d.get('status')")  (want already_claimed)"
echo "assignment (bot):    $(curl -s "$api/assignment" -H "authorization: Bearer $bot" | json "sorted(d) if d else None")"
leaks="$(docker compose -p "$project" logs backend 2>&1 | grep -c -E '84949765022|pwd=|smoke|Bearer ' || true)"
echo "log lines with a link, meeting number, passcode or token: $leaks  (want 0)"
