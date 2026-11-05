#!/usr/bin/env bash
# Local smoke test of Zoom webhooks and auto-join (QOR-4576) against the docker compose
# stack, after scripts/smoke.sh. Prints status codes and outcome codes, never a token,
# secret, meeting number, occurrence, topic, name or email.
#
#   docker compose -p <project> up -d --build --wait
#   bash scripts/smoke.sh <project>
#   bash scripts/smoke-zoom.sh <project>
#   docker compose -p <project> down -v
#
# docker-compose.yml passes the Zoom variables from .env (empty by default). This
# recreates the backend container with an override that sets a webhook secret generated
# here (it lives only in that container, whatever .env holds) and the deployment ceiling
# on without waiting for the host. The stored switch is settings' key auto_join_enabled
# (QOR-4578); nothing here saves it, so it reads as unset and auto-join opens nothing:
# this checks that a fresh install joins nothing and that ends still release.
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# One path every tool here can open: on Windows (Git Bash) a C:/... path, which bash,
# Python, curl and Docker all read; elsewhere the path itself.
work="$(cygpath -m "$tmp" 2>/dev/null || echo "$tmp")"
secret="$(python -c 'import secrets;print(secrets.token_hex(24))')"
cat > "$work/zoom.override.yml" <<'YAML'
services:
  backend:
    environment:
      BWAT_ZOOM_WEBHOOK_SECRET: ${ZOOM_SMOKE_SECRET}
      BWAT_AUTO_JOIN: "true"
      BWAT_AUTO_JOIN_REQUIRE_HOST: "false"
      BWAT_ALLOWED_DOMAINS: ${ZOOM_SMOKE_DOMAINS}
YAML
# The stack's own domains, and one for the member a join event links by email (QOR-5111).
domains="$(env_value BWAT_ALLOWED_DOMAINS)"
ZOOM_SMOKE_DOMAINS="${domains:+$domains,}smoke.invalid" ZOOM_SMOKE_SECRET="$secret" docker compose -p "$project" -f docker-compose.yml -f "$work/zoom.override.yml" \
  up -d --no-deps --no-build --wait backend >/dev/null 2>&1 \
  || { echo 'could not recreate the backend with the Zoom override'; exit 1; }
echo "backend with zoom:   $(curl -s "$base/health")"

meeting=85512345678
person_meeting=85512345679
unknown_meeting=85512345670
passcode='SmokePass42'
topic='Smoke topic do-not-log'

# Writes a Zoom event body to $work/$1.json: $2 event, $3 meeting id, $4 occurrence.
event() {
  python - "$work/$1.json" "$2" "$3" "SmokeOcc/uuid+${4:-1}==" "$topic" <<'PY'
import json, sys, time
path, kind, mid, uuid, topic = sys.argv[1:]
body = {"event": kind, "event_ts": int(time.time() * 1000), "payload": {"account_id": "smoke", "object": {
    "id": int(mid), "uuid": uuid, "host_id": "smokehost", "topic": topic, "start_time": "2026-10-02T00:00:00Z",
    "participant": {"id": "smokehost", "user_name": "Smoke Person", "email": "smoke.person@example.com"}}}}
open(path, "w").write(json.dumps(body))
PY
}
# POSTs $work/$1.json signed with the secret ($2: seconds offset from now, default 0) to
# /callbacks/zoom/events, or to $3 when given; prints "<code> <body>".
deliver() {
  local ts sig
  ts=$(( $(date +%s) + ${2:-0} ))
  sig="$(python -c "import hmac,hashlib,sys;b=open(sys.argv[1],'rb').read();print('v0='+hmac.new(sys.argv[2].encode(),b'v0:'+sys.argv[3].encode()+b':'+b,hashlib.sha256).hexdigest())" "$work/$1.json" "$secret" "$ts")"
  curl -s -w '\n%{http_code}' -X POST "${3:-$api/callbacks/zoom/events}" -H 'content-type: application/json' \
    -H "x-zm-request-timestamp: $ts" -H "x-zm-signature: $sig" --data-binary "@$work/$1.json"
}
status() { local out; out="$(cat)"; echo "$(echo "$out" | tail -1) $(echo "$out" | head -1 | json "d.get('status')")"; }

echo '{"event":"endpoint.url_validation","payload":{"plainToken":"smokeplaintoken"}}' | tr -d '\n' > "$work/validate.json"
echo "unsigned:            $(code -X POST "$api/callbacks/zoom/events" -H 'content-type: application/json' --data-binary "@$work/validate.json")  (want 401)"
old="$(deliver validate 0 "$base/zoom/events" | tail -1)"
echo "old /zoom/events:    $old  (want 404, signed and fresh)"
[ "$old" = 404 ] || { echo "old /zoom/events answered $old, not 404"; exit 1; }
echo "stale (6 min):       $(deliver validate -360 | tail -1)  (want 401)"
want="$(python -c "import hmac,hashlib,sys;print(hmac.new(sys.argv[1].encode(),b'smokeplaintoken',hashlib.sha256).hexdigest())" "$secret")"
got="$(deliver validate | head -1 | json "d.get('encryptedToken')")"
echo "url validation:      $([ "$got" = "$want" ] && echo 'encryptedToken matches' || echo 'MISMATCH')"

fleet="$(docker compose -p "$project" exec -T backend node dist/scripts/fleet-credential.js 2>/dev/null | tail -1)"
bot="$(curl -s -X POST "$api/bots/register" -H "authorization: Bearer $fleet" -H 'content-type: application/json' -d '{}' | json "d.get('bot_token','')")"
echo "bot ready:           $(code -X POST "$api/bots/ready" -H "authorization: Bearer $bot" -H 'content-type: application/json' -d '{}')"

# A person sends bwat once (the link carries the passcode); the bot reports the
# occurrence it is in, and that occurrence ends; the bot then leaves (its meeting_ended release).
sent="$(curl -s -X POST "$api/allocations" -H "authorization: Bearer $person" -H 'content-type: application/json' -d "{\"zoom_url\":\"https://zoom.us/j/${meeting}?pwd=${passcode}\"}" | json "d.get('id','')")"
echo "person send:         $([ -n "$sent" ] && echo 'an allocation' || echo 'NONE')  (want an allocation)"
echo "occurrence report:   $(code -X POST "$api/assignment/occurrence" -H "authorization: Bearer $bot" -H 'content-type: application/json' -d "{\"claim_id\":\"$sent\",\"generation\":1,\"occurrence_uuid\":\"SmokeOcc/uuid+1==\"}")  (want 200)"
event ended1 meeting.ended "$meeting" 1
echo "its meeting.ended:   $(deliver ended1 | status)  (want 200 tombstoned: the held claim stays live to drain)"
echo "re-delivery:         $(deliver ended1 | status)  (want 200 duplicate)"
echo "still held (bot):    $(curl -s "$api/assignment" -H "authorization: Bearer $bot" | json "'a claim' if d else None")  (want a claim)"
echo "bot leaves:          $(curl -s -X POST "$api/assignment/release" -H "authorization: Bearer $bot" -H 'content-type: application/json' -d "{\"claim_id\":\"$sent\",\"generation\":1,\"meeting_ended\":true}" | json "d.get('status')")  (want released)"

# The next occurrence: the stored switch is unset, so auto-join opens nothing.
event started meeting.started "$meeting" 2
echo "meeting.started:     $(deliver started | status)  (want 200 switched_off: nothing stored)"
echo "assignment (bot):    $(curl -s "$api/assignment" -H "authorization: Bearer $bot" | json "'a claim' if d else None")  (want None)"
event unknown meeting.started "$unknown_meeting" 3
echo "never-sent meeting:  $(deliver unknown | status)  (want 200 switched_off)"

echo "person send:         $(code -X POST "$api/allocations" -H "authorization: Bearer $person" -H 'content-type: application/json' -d "{\"zoom_url\":\"https://zoom.us/j/${person_meeting}\"}")  (want 202)"
# An end of an earlier occurrence, before this send's bot reports one: the send stays open.
event person_ended meeting.ended "$person_meeting" 4
echo "an earlier end:      $(deliver person_ended | status)  (want 200 tombstoned)"

# QOR-5111: a join naming the account and its email links nobody until Zoom's API confirms
# the email, which needs the S2S app this stack does not have; a guest's email, without the
# account, is never tried. Either way the delivery is answered.
psql_c "INSERT INTO bwat.members (email, role, activated_at) VALUES ('smoke.linked@smoke.invalid', 'member', now()), ('smoke.guest@smoke.invalid', 'member', now()) ON CONFLICT (email) DO UPDATE SET zoom_user_id = NULL, activated_at = now()" >/dev/null
joined() {
  python - "$work/$1.json" "$meeting" "$2" "$3" <<'PY'
import json, sys, time
path, mid, account, email = sys.argv[1:]
participant = {"user_id": "16778250", "user_name": "Smoke Person", "email": email, **({"participant_user_id": account} if account else {})}
body = {"event": "meeting.participant_joined", "event_ts": int(time.time() * 1000), "payload": {"account_id": "smoke", "object": {
    "id": int(mid), "uuid": "SmokeOcc/uuid+9==", "participant": participant}}}
open(path, "w").write(json.dumps(body))
PY
}
joined linked smokezoomuser 'Smoke.Linked@Smoke.Invalid'
echo "join with email:     $(deliver linked | status)"
linked="$(psql_c "SELECT zoom_user_id IS NULL FROM bwat.members WHERE email = 'smoke.linked@smoke.invalid'")"
echo "unconfirmed, no S2S: $linked  (want t: not linked)"
joined guest '' 'smoke.guest@smoke.invalid'
echo "guest's email:       $(deliver guest | status)"
guest="$(psql_c "SELECT zoom_user_id IS NULL FROM bwat.members WHERE email = 'smoke.guest@smoke.invalid'")"
echo "guest not linked:    $guest  (want t)"
[ "$linked" = t ] && [ "$guest" = t ] || { echo 'linking by email went wrong'; exit 1; }

leaks="$(docker compose -p "$project" logs backend 2>&1 \
  | grep -c -F -e "$meeting" -e "$person_meeting" -e "$unknown_meeting" -e "$passcode" -e 'SmokeOcc' -e 'Smoke topic' -e 'Smoke Person' -e 'smoke.person@' \
               -e 'smokehost' -e 'smokezoomuser' -e 'smoke.linked@' -e 'smoke.guest@' -e 'smokeplaintoken' -e "$secret" -e 'Bearer ' -e 'x-zm-signature' || true)"
echo "log lines with a meeting, occurrence, topic, name, email, token or secret: $leaks  (want 0)"
