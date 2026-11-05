#!/usr/bin/env bash
# Test people smoke test (QOR-4590) against the docker compose stack, after the others:
# it recreates the backend container with BWAT_TEST_PEOPLE set (the database is kept).
# Prints status codes and shapes only: never a token, a test email or a brief.
#
#   docker compose -p <project> up -d --build --wait
#   bash scripts/smoke.sh <project>     # and the other smokes
#   bash scripts/smoke-test-people.sh <project>
#   docker compose -p <project> down -v
#
# Three test people with fresh tokens: carol (owner), alice and bob (members). Alice hands
# a brief to her own session; bob can neither read, mark, delete nor list it, nor hand off
# to her session (D148). It also checks that the image refuses BWAT_TEST_PEOPLE under
# NODE_ENV=production. It exits 1 unless every step answers as wanted and no backend log
# line holds a token, a test email or the brief.
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
token() { python -c 'import secrets;print(secrets.token_urlsafe(32))'; }
uuid() { python -c 'import uuid;print(uuid.uuid4())'; }
carol="$(token)"; alice="$(token)"; bob="$(token)"
people="carol:owner:$carol,alice:member:$alice,bob:member:$bob"
# A request as the holder of token $1: prints the body, then the status on its own line.
call() {
  local who="$1" method="$2" path="$3"; shift 3
  local type=(); [ $# -gt 0 ] && type=(-H 'content-type: application/json')
  curl -s -w '\n%{http_code}' -X "$method" "$api$path" -H "authorization: Bearer $who" "${type[@]}" "$@"
}
fails=0
want() { # label, got, wanted
  printf '%-40s %s  (want %s)\n' "$1:" "$2" "$3"
  [ "$2" = "$3" ] || fails=$((fails + 1))
}

# The image (NODE_ENV=production) refuses to start with it, before it reads anything else.
refused="$(docker compose -p "$project" run --rm --no-deps -e NODE_ENV=production -e BWAT_DEV_PERSON_TOKEN= \
  -e BWAT_TEST_PEOPLE="$people" backend 2>&1 || true)"
want "production start refused" "$(printf '%s' "$refused" | grep -c 'BWAT_TEST_PEOPLE is refused unless NODE_ENV is development or test' || true)" 1
want "production refusal holds no token" "$(printf '%s' "$refused" | grep -c -E "$carol|$alice|$bob" || true)" 0

BWAT_TEST_PEOPLE="$people" docker compose -p "$project" up -d --wait --no-deps backend >/dev/null 2>&1

for who in carol alice bob; do
  me="$(call "${!who}" GET /me)"
  want "GET /me as $who" "$(echo "$me" | status) $(echo "$me" | body | json "','.join([str(d['email'].endswith('@test.bwat.invalid')), d['email'].split('@')[0], d['role']])")" \
    "200 True,$who,$([ "$who" = carol ] && echo owner || echo member)"
done
want "a wrong token" "$(call "${alice}x" GET /me | status)" 401

session="smoke-alice-$(uuid)"
descriptor='{"kind":"claude-code","wake":"push","machine":"m","platform":"linux","plugin_version":"0.1.0"}'
brief_body="Smoke test-people brief $(uuid)"
handoff() { # token, target
  call "$1" POST /handoffs -d '{"source_kind":"todo","source_id":"'"$(uuid)"'","target_session_id":"'"$2"'","request_key":"'"$(uuid)"'","subject":"s","body":"'"$brief_body"'"}'
}
want "alice registers a session" "$(call "$alice" PUT "/sessions/$session" -d '{"client":'"$descriptor"',"instance_id":"i-1"}' | status)" 200
want "alice hands off to it" "$(handoff "$alice" "$session" | status)" 202
id="$(call "$alice" GET "/me/inbox?scope=session&client_session=$session" | body | json "d['messages'][0]['id']")"
want "bob reads alice's message" "$(call "$bob" GET "/me/inbox/$id" | status)" 404
want "bob marks alice's message read" "$(call "$bob" PATCH "/me/inbox/$id" | status)" 404
call "$bob" DELETE "/me/inbox/$id" >/dev/null
want "bob's inbox" "$(call "$bob" GET /me/inbox | body | json "len(d['messages'])")" 0
want "bob hands off to alice's session" "$(handoff "$bob" "$session" | status)" 403
kept="$(call "$alice" GET "/me/inbox/$id")"
want "alice's message, after bob" "$(echo "$kept" | status) $(echo "$kept" | body | json "d['read_at'] is None and d['body']=='$brief_body'")" "200 True"

logs="$(docker compose -p "$project" logs backend 2>&1)"
want "test people on, at startup" "$(printf '%s' "$logs" | grep -c '"event":"auth.test_people_on"' || true)" 1
leaks="$(printf '%s' "$logs" | grep -c -E "$carol|$alice|$bob|test\.bwat\.invalid|$brief_body|Bearer " || true)"
want "log lines with a token, an email, a brief" "$leaks" 0
[ "$fails" = 0 ] || { echo "FAIL: $fails step(s) did not answer as wanted"; exit 1; }
