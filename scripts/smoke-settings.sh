#!/usr/bin/env bash
# Settings track smoke test (QOR-4578) against the docker compose stack, after
# scripts/smoke.sh. Prints status codes and shapes only: never a token, key, setting
# value or dictionary word.
#
#   docker compose -p <project> up -d --build --wait
#   bash scripts/smoke.sh <project>
#   bash scripts/smoke-settings.sh <project>
#   docker compose -p <project> down -v
#
# Part 1: settings, the corrections dictionary and /bot/settings. Part 2: model keys on
# the local secret store. docker-compose.yml passes BWAT_ENC_KEY from .env; when .env has
# none, only the backend is recreated with a throwaway key generated here (never printed,
# never written into the repository). It exits 1 unless a model-key set and remove both
# answer 200, no status body carries the key and its last4 is right, the one secrets row
# is encrypted, no audit row holds a key or a word, and no log line holds content.
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person
# The status code only. The body goes to stdout and is dropped here: a native Windows
# curl cannot write to /dev/null and exits 23, which `set -e` stops on in an assignment.
code() { curl -s -w '\n%{http_code}' "$@" | tail -n 1; }
as_person=(-H "authorization: Bearer $person" -H 'content-type: application/json')

# Values that must never reach a log: a setting value, dictionary words, a model key.
name_value='Smoke Scribe'
word='Zedekiahsmoke'
heard='bee whatsmoke'
model_key="sk-smoke-$(python -c 'import secrets;print(secrets.token_hex(16))')"

logs=""
collect_logs() { logs="$logs$(docker compose -p "$project" logs backend 2>&1)"; }

echo "-- part 1: settings, corrections and bot settings"
echo "settings, no person:     $(code "$api/console/settings")  (want 401)"
echo "settings:                $(curl -s "$api/console/settings" "${as_person[@]}" | json "(sorted(d), len(d['settings']), d['settingsVersion'], d['canManage'])")"
save='{"changes":{"display_name":{"value":"'"$name_value"'","expectedRevision":null}}}'
echo "save joining:            $(code -X PUT "$api/console/settings/joining" "${as_person[@]}" -d "$save")  (want 200)"
echo "save joining again:      $(code -X PUT "$api/console/settings/joining" "${as_person[@]}" -d "$save")  (want 409 stale)"
echo "save unknown section:    $(code -X PUT "$api/console/settings/speech" "${as_person[@]}" -d "$save")  (want 404)"
dict='{"expectedRevision":null,"payload":{"targets":[{"id":"z","canonical":"'"$word"'","hardness":"hard","proper_noun":true}],"people":[],"aliases":[{"alias":"'"$heard"'","target_id":"z"}]}}'
echo "corrections save:        $(curl -s -X PUT "$api/console/corrections" "${as_person[@]}" -d "$dict" | json "{k: d['dictionary'][k] for k in ('state','revision')}")"
echo "corrections stale:       $(code -X PUT "$api/console/corrections" "${as_person[@]}" -d "$dict")  (want 409)"
fleet="$(docker compose -p "$project" exec -T backend node dist/scripts/fleet-credential.js 2>/dev/null | tail -1)"
bot="$(curl -s -X POST "$api/bots/register" -H "authorization: Bearer $fleet" -H 'content-type: application/json' -d '{}' | json "d['bot_token']")"
echo "bot settings, fleet:     $(code "$api/bot/settings" -H "authorization: Bearer $fleet")  (want 409)"
echo "bot settings, no token:  $(code "$api/bot/settings")  (want 401)"
echo "bot settings:            $(curl -s "$api/bot/settings" -H "authorization: Bearer $bot" | json "(sorted(d), sorted(d['settings']), d['settingsVersion'], d['dictionary']['state'])")"
# QOR-4760: per_participant_audio is no longer a setting: never served, and a save is refused.
audio='{"changes":{"per_participant_audio":{"value":false,"expectedRevision":null}}}'
audio_code="$(code -X PUT "$api/console/settings/behaviour" "${as_person[@]}" -d "$audio")"
audio_served="$(curl -s "$api/bot/settings" -H "authorization: Bearer $bot" | json "d['settings'].get('per_participant_audio')")"
echo "per-participant:         $audio_code $audio_served  (want 400 None)"
# Headers and body on stdout (-i): a temp-file path may not be one a native curl can open.
etag="$(curl -s -i "$api/bot/settings" -H "authorization: Bearer $bot" | tr -d '\r' | grep -i '^etag:' | cut -d' ' -f2-)"
echo "bot settings, unchanged: $(code "$api/bot/settings" -H "authorization: Bearer $bot" -H "if-none-match: $etag")  (want 304)"
collect_logs

echo "-- part 2: model keys on the local secret store"
if grep -qE '^BWAT_ENC_KEY=.+' .env; then
  echo "secret store key:        from .env, as composed"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  override="$tmp/settings-override.yml"
  printf 'services:\n  backend:\n    environment:\n      BWAT_SECRET_STORE: local\n      BWAT_ENC_KEY: "%s"\n' \
    "$(python -c 'import secrets;print(secrets.token_hex(32))')" > "$override"
  if command -v cygpath >/dev/null 2>&1; then override="$(cygpath -m "$override")"; fi
  docker compose -p "$project" -f docker-compose.yml -f "$override" up -d --no-deps --wait backend >/dev/null 2>&1
  echo "secret store key:        none in .env; backend recreated with a throwaway one: $(curl -s "$base/health")"
fi
# Status only: set, source, and whether last4 is the key's last 4 characters, never the key.
status() { MODEL_KEY="$model_key" python -c "import os,sys,json;b=sys.stdin.read();d=json.loads(b);k=os.environ['MODEL_KEY'];print(d.get('set'), d.get('source'), 'last4 ok' if d.get('last4')==k[-4:] else ('last4 none' if d.get('last4') is None else 'last4 WRONG'), 'KEY IN BODY' if k in b else 'no key in body')"; }
put_code="$(code -X PUT "$api/console/model-keys/openai" "${as_person[@]}" -d '{"key":"'"$model_key"'"}')"
echo "model key set:           $put_code  (want 200)"
key_status="$(curl -s -X PUT "$api/console/model-keys/openai" "${as_person[@]}" -d '{"key":"'"$model_key"'"}' | status)"
echo "model key status:        $key_status  (want True store last4 ok no key in body)"
key_list="$(curl -s "$api/console/model-keys" "${as_person[@]}" | MODEL_KEY="$model_key" python -c "import os,sys;b=sys.stdin.read();import json;d=json.loads(b);print([(k['provider'], k['set'], k['source']) for k in d['keys']], 'KEY IN BODY' if os.environ['MODEL_KEY'] in b else 'no key in body')")"
echo "model keys list:         $key_list"
echo "model key bad provider:  $(code -X PUT "$api/console/model-keys/zoom" "${as_person[@]}" -d '{"key":"'"$model_key"'"}')  (want 404)"
echo "model key startup name:  $(code -X PUT "$api/console/model-keys/BWAT_ENC_KEY" "${as_person[@]}" -d '{"key":"'"$model_key"'"}')  (want 404)"
echo "bot settings, no header: $(curl -s "$api/bot/settings" -H "authorization: Bearer $bot" | json "d['providerKeys']")  (want {})"
served="$(curl -s "$api/bot/settings" -H "authorization: Bearer $bot" -H 'x-bwat-provider-keys: memory-only')"
echo "bot settings, in memory: $(echo "$served" | MODEL_KEY="$model_key" python -c "import os,sys,json;d=json.load(sys.stdin);print(sorted(d['providerKeys']), d['providerKeys'].get('openai')==os.environ['MODEL_KEY'], d['settingsVersion'])")  (want ['openai'] True)"
plain="$(docker compose -p "$project" exec -T postgres psql -U postgres -d bwat -tAc "SELECT count(*) FROM bwat.secrets WHERE ciphertext LIKE 'pk1:%' AND position('$model_key' in ciphertext) = 0" 2>/dev/null | tr -d '[:space:]')"
echo "secrets rows encrypted:  $plain  (want 1)"
del_code="$(code -X DELETE "$api/console/model-keys/openai" "${as_person[@]}" -d '{}')"
echo "model key remove:        $del_code  (want 200)"
echo "model key after remove:  $(curl -s "$api/console/model-keys" "${as_person[@]}" | json "[(k['set'], k['source']) for k in d['keys'] if k['provider']=='openai']")  (want [(False, None)])"
echo "audit rows:              $(docker compose -p "$project" exec -T postgres psql -U postgres -d bwat -tAc "SELECT string_agg(action, ',' ORDER BY at) FROM bwat.audit WHERE target_type <> 'member'" 2>/dev/null | tr -d '[:space:]')"
audit_leaks="$(docker compose -p "$project" exec -T postgres psql -U postgres -d bwat -tAc "SELECT count(*) FROM bwat.audit WHERE position('$model_key' in coalesce(before::text,'') || coalesce(after::text,'')) > 0 OR position('$word' in coalesce(before::text,'') || coalesce(after::text,'')) > 0" 2>/dev/null | tr -d '[:space:]')"
echo "audit rows with a key or a word: $audit_leaks  (want 0)"
collect_logs

leaks="$(printf '%s' "$logs" | grep -c -E "84949765022|pwd=|Bearer |$model_key|$word|$heard|$name_value" || true)"
echo "log lines with meeting content, a token, a key, a setting value or a dictionary word: $leaks  (want 0)"
# -- gate
[ "$audio_code" = 400 ] && [ "$audio_served" = None ] || { echo "FAIL: per_participant_audio is still a setting"; exit 1; }
[ "$put_code" = 200 ] && [ "$del_code" = 200 ] || { echo "FAIL: a model-key set or remove did not answer 200"; exit 1; }
[ "$key_status" = "True store last4 ok no key in body" ] || { echo "FAIL: a model-key status body is wrong or carries the key"; exit 1; }
case "$key_list" in *"KEY IN BODY"*|"") echo "FAIL: the model-key list carries the key"; exit 1 ;; esac
[ "$plain" = 1 ] || { echo "FAIL: secrets rows encrypted is not 1"; exit 1; }
[ "$audit_leaks" = 0 ] || { echo "FAIL: an audit row holds a key or a word"; exit 1; }
[ "$leaks" = 0 ] || { echo "FAIL: content in the backend log"; exit 1; }
# -- end gate
