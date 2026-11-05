#!/usr/bin/env bash
# Local smoke test for meetings and transcripts (QOR-4577), against the docker compose
# stack, after scripts/smoke.sh. Prints status codes, counts and key names; never a token,
# link, meeting number, passcode, transcript text or name.
#
#   docker compose -p <project> up -d --build --wait
#   scripts/smoke.sh <project>
#   scripts/smoke-meetings.sh <project>
#   docker compose -p <project> down -v
#
# The claim is pinned to this script's bot, occurrence and epoch with psql inside the
# postgres container, so the script does not depend on which ready bot (an earlier smoke
# script's, say) allocation picks.
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person

meeting_number=84949765033
occurrence='mtg/Occ+1=='
occurrence_path='mtg%2FOcc%2B1%3D%3D'
member='00000000-0000-4000-8000-00000000a11a'
label='Grace Hopper'
said='the quarterly launch is on thursday'
title='Board offsite'
chat='deck is in the shared drive'

echo "migration 0006 applied: $(docker compose -p "$project" logs migrate 2>&1 | grep -c '0006_meetings_and_transcripts' || true)  (want 1)"
echo "health:                 $(curl -s "$base/health")"
fleet="$(docker compose -p "$project" exec -T backend node dist/scripts/fleet-credential.js 2>/dev/null | tail -1)"
reg="$(curl -s -X POST "$api/bots/register" -H "authorization: Bearer $fleet" -H 'content-type: application/json' -d '{}')"
bot="$(echo "$reg" | json "d['bot_token']")"
bot_id="$(echo "$reg" | json "d['bot_id']")"
echo "bot registered, ready:  $(code -X POST "$api/bots/ready" -H "authorization: Bearer $bot" -H 'content-type: application/json' -d '{}')"
claim="$(curl -s -X POST "$api/allocations" -H "authorization: Bearer $person" -H 'content-type: application/json' -d "{\"zoom_url\":\"https://zoom.us/j/${meeting_number}\"}" | json "d['id']")"
psql_c "UPDATE bwat.claims SET bot_id = '$bot_id', state = 'claimed', occurrence_uuid = '$occurrence', transcript_epoch = 1, lease_until = now() + interval '10 minutes' WHERE id = '$claim'" >/dev/null
echo "claim pinned (psql):    $(psql_c "SELECT count(*) FROM bwat.claims WHERE id = '$claim' AND bot_id = '$bot_id' AND occurrence_uuid = '$occurrence'")  (want 1)"

push() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$api/meetings/$occurrence_path/transcript" -H "authorization: Bearer $1" -H 'content-type: application/json' -d "$2"
}
body="{\"epoch\":1,\"segments\":[
  {\"seq\":0,\"speaker_label\":\"$label\",\"speaker_member_id\":\"$member\",\"text\":\"$said\",\"start_ms\":0,\"end_ms\":1500},
  {\"seq\":1,\"speaker_label\":\"$label\",\"text\":\"$said again\",\"start_ms\":1600,\"end_ms\":2500},
  {\"seq\":2,\"speaker_label\":\"Speaker 2\",\"text\":\"$said too\",\"start_ms\":2600,\"end_ms\":3000}]}"
echo "push, no token:         $(code -X POST "$api/meetings/$occurrence_path/transcript" -H 'content-type: application/json' -d "$body")  (want 401)"
echo "push:                   $(push "$bot" "$body")  (want 204)"
echo "push again:             $(push "$bot" "$body")  (want 204, idempotent)"
echo "push, chat line:        $(push "$bot" "{\"epoch\":1,\"segments\":[{\"seq\":3,\"speaker_label\":\"Speaker 2\",\"text\":\"$chat\",\"start_ms\":3100,\"end_ms\":3100,\"source\":\"chat\"}]}")  (want 204)"
echo "push, bad source:       $(push "$bot" '{"epoch":1,"segments":[{"seq":4,"speaker_label":"S","text":"x","start_ms":0,"end_ms":0,"source":"self"}]}')  (want 400)"
echo "push, stale epoch:      $(push "$bot" '{"epoch":2,"segments":[]}')  (want 409)"
echo "push, final:            $(push "$bot" '{"epoch":1,"complete":true,"segments":[]}')  (want 204)"
echo "push, final again:      $(push "$bot" '{"epoch":1,"complete":true,"segments":[]}')  (want 204, idempotent)"
echo "push, after final:      $(push "$bot" '{"epoch":1,"segments":[{"seq":9,"speaker_label":"Speaker 2","text":"late","start_ms":9000,"end_ms":9500}]}')  (want 409 transcript_complete)"
psql_c "UPDATE bwat.meetings SET title = '$title' WHERE occurrence_uuid = '$occurrence'" >/dev/null

echo "history, no person:     $(code "$api/meetings")  (want 401)"
hist="$(curl -s "$api/meetings" -H "authorization: Bearer $person")"
meeting="$(echo "$hist" | json "[m['id'] for m in d['meetings'] if m['occurrence_id'] == '$occurrence'][0]")"
echo "history:                $(echo "$hist" | json "sorted(d)") entry keys $(echo "$hist" | json "sorted(d['meetings'][0])")"
echo "history entry:          $(echo "$hist" | json "[(m['finalization'], m['transcript_available'], m['title'] is not None) for m in d['meetings'] if m['id'] == '$meeting']")"
tr="$(curl -s "$api/meetings/$meeting/transcript" -H "authorization: Bearer $person")"
echo "transcript:             $(echo "$tr" | json "(len(d['segments']), sorted(d['segments'][0]), d['next_cursor'])")  (want 4 segments)"
echo "transcript state:       $(echo "$tr" | json "(d['complete'], d['occurrence_state'])")  (want (True, 'ended'): the final push is stored)"
echo "transcript sources:     $(echo "$tr" | json "[s['source'] for s in d['segments']]")  (want asr x3, then chat)"
echo "erase a person, gone:   $(code -X DELETE "$api/members/$member/speech" -H "authorization: Bearer $person")  (want 404: no per-person erasure)"
echo "delete meeting, live:   $(curl -s -X DELETE "$api/meetings/$meeting" -H "authorization: Bearer $person" | json "d")  (want meeting_live: its claim is still open)"
echo "recall the claim:       $(code -X PATCH "$api/allocations/$claim" -H "authorization: Bearer $person" -H 'content-type: application/json' -d '{"recall":true}')  (want 200)"
# Its bot is free again: withdraw it, so a later smoke script's send goes to its own bot.
echo "withdraw the bot:       $(code -X POST "$api/bots/ready" -H "authorization: Bearer $bot" -H 'content-type: application/json' -d '{"ready":false}')  (want 200)"
echo "delete meeting:         $(curl -s -X DELETE "$api/meetings/$meeting" -H "authorization: Bearer $person" | json "(d['segments_deleted'], d['claims_cleared'])")  (want (4, 1): the recalled claim's briefing is cleared)"
echo "delete meeting again:   $(code -X DELETE "$api/meetings/$meeting" -H "authorization: Bearer $person")  (want 404)"
echo "retention script:       $(docker compose -p "$project" exec -T backend node dist/scripts/retention.js 2>&1 | tail -1)  (want 0 transcripts expired: nothing is old)"
echo "delete-meeting script:  $(docker compose -p "$project" exec -T backend node dist/scripts/delete-meeting.js --meeting 00000000-0000-4000-8000-000000000000 2>&1 | tail -1)  (want no such meeting)"
# Push latency: 100 sequential pushes of 20 segments each, on a second bot, claim and
# occurrence: curl's time_total per push, nearest-rank p50/p95 (a report; target p95
# 50 ms). The script fails if any push is not 204 or a push's row is missing. The bot
# is not made ready: its claim stays pending until psql pins it, as above.
timing_number=84949765044
timing_occurrence_path='mtg%2FTiming%2B1%3D%3D'
treg="$(curl -s -X POST "$api/bots/register" -H "authorization: Bearer $fleet" -H 'content-type: application/json' -d '{}')"
tbot="$(echo "$treg" | json "d['bot_token']")"
tbot_id="$(echo "$treg" | json "d['bot_id']")"
tclaim="$(curl -s -X POST "$api/allocations" -H "authorization: Bearer $person" -H 'content-type: application/json' -d "{\"zoom_url\":\"https://zoom.us/j/${timing_number}\"}" | json "d['id']")"
psql_c "UPDATE bwat.claims SET bot_id = '$tbot_id', state = 'claimed', occurrence_uuid = 'mtg/Timing+1==', transcript_epoch = 1, lease_until = now() + interval '10 minutes' WHERE id = '$tclaim'" >/dev/null
times=""
for i in $(seq 0 99); do
  segs=""
  for k in $(seq 0 19); do
    n=$((i * 20 + k))
    segs+="${segs:+,}{\"seq\":$n,\"speaker_label\":\"Speaker 3\",\"text\":\"timing segment $n\",\"start_ms\":$((n * 1000)),\"end_ms\":$((n * 1000 + 900))}"
  done
  # The status and time go on their own last line, after any body (a refusal has one):
  # only that line is kept, so every row is exactly "<code> <seconds>".
  out="$(curl -s -w '\n%{http_code} %{time_total}' -X POST "$api/meetings/$timing_occurrence_path/transcript" -H "authorization: Bearer $tbot" -H 'content-type: application/json' -d "{\"epoch\":1,\"segments\":[$segs]}")"
  times+="${out##*$'\n'}"$'\n'
done
latency_py='
import math, sys
rows = [l.split() for l in sys.stdin if l.strip()]
ms = sorted(float(t) * 1000 for _, t in rows)
bad = sum(c != "204" for c, _ in rows)
pct = lambda p: ms[math.ceil(p / 100 * len(ms)) - 1]  # nearest rank
print("pushes %d, non-204 %d, p50 %.1f ms, p95 %.1f ms, max %.1f ms" % (len(ms), bad, pct(50), pct(95), ms[-1]))
sys.exit(1 if bad or len(rows) != 100 else 0)
'
# A plain assignment, not inside echo, so a failed report stops the script.
latency="$(printf '%s' "$times" | python -c "$latency_py")" || { echo "push latency, 100 x 20: ${latency:-no report}  (FAIL: want 100 pushes, all 204)"; exit 1; }
echo "push latency, 100 x 20: $latency  (target p95 50 ms)"
echo "timing segments stored: $(psql_c "SELECT count(*) FROM bwat.transcript_segments s JOIN bwat.meetings m ON m.id = s.meeting_id WHERE m.occurrence_uuid = 'mtg/Timing+1=='")  (want 2000)"

# The read reports the occurrence: live while its claim is held, and not complete.
tmeeting="$(psql_c "SELECT id FROM bwat.meetings WHERE occurrence_uuid = 'mtg/Timing+1=='")"
echo "timing transcript read: $(curl -s "$api/meetings/$tmeeting/transcript?limit=500" -H "authorization: Bearer $person" | json "(len(d['segments']), d['complete'], d['occurrence_state'], d['next_cursor'] is not None)")  (want (500, False, 'live', True))"

# Retention expires the transcript only (QOR-4600, D163): recall the timing claim, age the
# meeting past the window with psql, run the job. The meeting stays, its segments go, the
# read says so, and a push (under a claim pinned live again with psql) stores nothing.
echo "recall timing claim:    $(code -X PATCH "$api/allocations/$tclaim" -H "authorization: Bearer $person" -H 'content-type: application/json' -d '{"recall":true}')  (want 200)"
psql_c "UPDATE bwat.meetings SET started_at = now() - interval '400 days', ended_at = now() - interval '400 days' WHERE id = '$tmeeting'" >/dev/null
echo "retention, aged:        $(docker compose -p "$project" exec -T backend node dist/scripts/retention.js 2>&1 | tail -1)  (want 1 transcripts expired)"
echo "expired meeting kept:   $(psql_c "SELECT count(*) FROM bwat.meetings WHERE id = '$tmeeting' AND transcript_expired_at IS NOT NULL")  (want 1)"
echo "expired segments left:  $(psql_c "SELECT count(*) FROM bwat.transcript_segments WHERE meeting_id = '$tmeeting'")  (want 0)"
echo "expired read:           $(curl -s "$api/meetings/$tmeeting/transcript" -H "authorization: Bearer $person" | json "(len(d['segments']), d['transcript_expired'], d['transcript_expired_at'] is not None, d['occurrence_state'])")  (want (0, True, True, 'ended'))"
echo "expired read status:    $(code "$api/meetings/$tmeeting/transcript" -H "authorization: Bearer $person")  (want 200)"
echo "expired history entry:  $(curl -s "$api/meetings?limit=100" -H "authorization: Bearer $person" | json "[(m['transcript_available'], m['transcript_expired']) for m in d['meetings'] if m['id'] == '$tmeeting']")  (want [(False, True)])"
psql_c "UPDATE bwat.claims SET state = 'claimed', refused_reason = NULL, ended_at = NULL, lease_until = now() + interval '10 minutes' WHERE id = '$tclaim'" >/dev/null
echo "push, after expiry:     $(curl -s -X POST "$api/meetings/$timing_occurrence_path/transcript" -H "authorization: Bearer $tbot" -H 'content-type: application/json' -d '{"epoch":1,"segments":[{"seq":5000,"speaker_label":"Speaker 3","text":"timing segment late","start_ms":0,"end_ms":1}]}' | json "d")  (want transcript_expired)"
echo "segments after push:    $(psql_c "SELECT count(*) FROM bwat.transcript_segments WHERE meeting_id = '$tmeeting'")  (want 0)"
echo "recall timing again:    $(code -X PATCH "$api/allocations/$tclaim" -H "authorization: Bearer $person" -H 'content-type: application/json' -d '{"recall":true}')  (want 200)"
echo "delete expired meeting: $(code -X DELETE "$api/meetings/$tmeeting" -H "authorization: Bearer $person")  (want 200: an admin's delete still removes it)"

leaks="$(docker compose -p "$project" logs backend 2>&1 | grep -c -E "$meeting_number|$timing_number|$label|quarterly launch|timing segment|$title|$chat|pwd=|Bearer " || true)"
echo "log lines with transcript text, a chat line, a name, a title, a meeting number, a passcode or a token: $leaks  (want 0)"
