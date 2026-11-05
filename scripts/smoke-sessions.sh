#!/usr/bin/env bash
# Sessions, hand-offs and inbox smoke test (QOR-4589) against the docker compose stack,
# after scripts/smoke.sh. Prints status codes and shapes only: never a token, a brief's
# subject or body, or a session's machine, name or cwd.
#
#   docker compose -p <project> up -d --build --wait
#   bash scripts/smoke.sh <project>
#   bash scripts/smoke-sessions.sh <project>
#   docker compose -p <project> down -v
#
# The dev token (BWAT_DEV_PERSON_TOKEN) signs in as the dev member, who registers two
# sessions, hands a brief to the live one and reads it back from its inbox. It exits 1
# unless every step answers as wanted and no backend log line holds the brief or the
# session's descriptor.
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person
uuid() { python -c 'import uuid;print(uuid.uuid4())'; }

# Values that must never reach a log.
machine='smokemachine'
name='smoke session name'
cwd='smokecwd'
subject='Smoke subject line'
brief_body='Smoke brief body: write the release notes'

live="smoke-live-$(uuid)"
gone="smoke-gone-$(uuid)"
descriptor='{"kind":"claude-code","wake":"push","machine":"'"$machine"'","platform":"linux","plugin_version":"0.1.0","name":"'"$name"'","cwd":"'"$cwd"'"}'
fails=0
want() { # label, got, wanted
  printf '%-34s %s  (want %s)\n' "$1:" "$2" "$3"
  [ "$2" = "$3" ] || fails=$((fails + 1))
}

want "session put, no person" "$(curl -s -w '\n%{http_code}' -X PUT "$api/sessions/$live" -H 'content-type: application/json' -d '{}' | status)" 401
want "session put" "$(call PUT "/sessions/$live" -d '{"client":'"$descriptor"',"instance_id":"i-1"}' | status)" 200
want "session put, path in cwd" "$(call PUT "/sessions/$live" -d '{"client":{"kind":"codex","wake":"pull","machine":"m","platform":"p","plugin_version":"1","cwd":"a/b"},"instance_id":"i-1"}' | status)" 400
want "second session put" "$(call PUT "/sessions/$gone" -d '{"client":'"$descriptor"',"instance_id":"i-1"}' | status)" 200
want "second session ended" "$(call PUT "/sessions/$gone" -d '{"client":'"$descriptor"',"instance_id":"i-1","ended":true}' | status)" 200
listed="$(call GET /sessions | body | python -c "import sys,json;d=json.load(sys.stdin);ids=[s['session_id'] for s in d];print(sorted(d[0]) if d else [], '$live' in ids, '$gone' in ids)")"
want "sessions list" "$listed" "['client', 'last_seen_at', 'session_id'] True False"

handoff() { # target, request_key
  call POST /handoffs -d '{"source_kind":"todo","source_id":"'"$(uuid)"'","target_session_id":"'"$1"'","request_key":"'"$2"'","subject":"'"$subject"'","body":"'"$brief_body"'"}'
}
key="$(uuid)"
sent="$(handoff "$live" "$key")"
want "handoff to the live session" "$(echo "$sent" | status)" 202
want "handoff answer" "$(echo "$sent" | body | json "(sorted(d), d['status'])")" "(['handoff_id', 'status'], 'queued')"
want "handoff repeated" "$(handoff "$live" "$key" | body | json "d['handoff_id']")" "$(echo "$sent" | body | json "d['handoff_id']")"
unreachable="$(handoff "$gone" "$(uuid)")"
want "handoff to the ended session" "$(echo "$unreachable" | status) $(echo "$unreachable" | body | json "d['error']")" "409 session_unreachable"
want "handoff to no session of mine" "$(handoff "smoke-none-$(uuid)" "$(uuid)" | status)" 403

inbox="$(call GET "/me/inbox?unread_only=true&scope=session&client_session=$live" | body)"
want "inbox list" "$(echo "$inbox" | json "(len(d['messages']), 'body' in d['messages'][0], d['messages'][0]['read_at'])")" "(1, False, None)"
want "inbox scope=session, no session" "$(call GET "/me/inbox?scope=session" | status)" 400
id="$(echo "$inbox" | json "d['messages'][0]['id']")"
want "inbox read" "$(call GET "/me/inbox/$id" | body | json "(d['message_type'], d['body']=='$brief_body')")" "('handoff', True)"
read_at="$(call PATCH "/me/inbox/$id" | body | json "d['read_at']")"
want "inbox mark read, again" "$(call PATCH "/me/inbox/$id" | body | json "d['read_at']")" "$read_at"
want "inbox unread after read" "$(call GET "/me/inbox?unread_only=true&scope=session&client_session=$live" | body | json "len(d['messages'])")" 0
want "inbox delete" "$(call DELETE "/me/inbox/$id" | status)" 204
want "inbox delete again" "$(call DELETE "/me/inbox/$id" | status)" 204
want "inbox read after delete" "$(call GET "/me/inbox/$id" | status)" 404

logs="$(docker compose -p "$project" logs backend 2>&1)"
leaks="$(printf '%s' "$logs" | grep -c -E "$machine|$name|$cwd|$subject|$brief_body|Bearer " || true)"
want "log lines with a brief or a descriptor" "$leaks" 0
[ "$fails" = 0 ] || { echo "FAIL: $fails step(s) did not answer as wanted"; exit 1; }
