#!/usr/bin/env bash
# Identity smoke test (QOR-4575) against the docker compose stack, after scripts/smoke.sh.
# Prints status codes, roles and counts, never an email, name, Zoom id or token.
#
#   docker compose -p identity up -d --build --wait
#   scripts/smoke.sh identity && scripts/smoke-identity.sh identity
#   docker compose -p identity down -v
#
# The stack does not set BWAT_GOOGLE_CLIENT_IDS, so Google sign-in is off there and the
# dev token (BWAT_DEV_PERSON_TOKEN) signs in as the dev member, the stack's owner. Nor does
# it set BWAT_ALLOWED_DOMAINS, so every invite is refused (D146: nobody invited could sign
# in); the member the rest of the script changes is added straight to the database.
set -euo pipefail
project="${1:-bwat-smoke}"
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
need_person
body() { head -1; }

echo "me, nobody:          $(curl -s -o /dev/null -w '%{http_code}' "$api/me")  (want 401)"
echo "me, a fake id token: $(curl -s -o /dev/null -w '%{http_code}' "$api/me" -H 'authorization: Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2ln')  (want 401: Google sign-in is off here)"
me="$(call GET /me)"
dev_id="$(echo "$me" | body | json "d['id']")"
echo "me, dev member:      $(echo "$me" | status) role=$(echo "$me" | body | json "d['role']") keys=$(echo "$me" | body | json "sorted(d)")  (want 200 owner ['display_name', 'email', 'id', 'role'])"
echo "members:             $(call GET /members | body | json "len(d['members'])") listed"
invite="$(call POST /members -d '{"email":"Smoke.Invitee@example.com","display_name":"Smoke Invitee","role":"owner"}')"
echo "invite:              $(echo "$invite" | status) $(echo "$invite" | body | json "d['error']")  (want 409 domain_not_allowed: no domain is allowed here)"
echo "invite, bad body:    $(call POST /members -d '{"email":"x@example.com","workspace_id":"w"}' | status)  (want 400)"
psql() { docker compose -p "$project" exec -T postgres psql -U postgres -d bwat -qtAc "$1"; }
id="$(psql "INSERT INTO bwat.members (email, display_name) VALUES ('smoke.invitee@example.com', 'Smoke Invitee') RETURNING id")"
echo "members, one added: $(call GET /members | body | json "len(d['members'])") listed  (want 2: the dev member and the one added)"
echo "make admin:          $(call PATCH "/members/$id" -d '{"role":"admin"}' | body | json "d['role']")  (want admin)"
echo "demote last owner:   $(call PATCH "/members/$dev_id" -d '{"role":"member"}' | body | json "d['error']")  (want last_owner)"
echo "remove last owner:   $(call DELETE "/members/$dev_id" | body | json "d['error']")  (want last_owner)"
echo "remove invitee:      $(call DELETE "/members/$id" | status)  (want 204)"
echo "unknown member:      $(call DELETE "/members/00000000-0000-4000-8000-000000000000" | status)  (want 404)"
echo "audit:               $(psql "SELECT string_agg(action || '=' || n, ' ' ORDER BY action) FROM (SELECT action, count(*) n FROM bwat.audit GROUP BY action) a")"
echo "audit, as runtime:   $(psql "SELECT has_table_privilege('bwat_runtime', 'bwat.audit', 'UPDATE') OR has_table_privilege('bwat_runtime', 'bwat.audit', 'DELETE')")  (want f: append-only)"
echo "dev member:          activated=$(psql "SELECT activated_at IS NOT NULL FROM bwat.members WHERE id = '$dev_id'")  (want t: it keeps the stack owned)"
logs="$(docker compose -p "$project" logs backend 2>&1)"
echo "startup, no domains: $(printf '%s\n' "$logs" | grep -c '"event":"auth.allowed_domains_unset"' || true)  (want 1 while BWAT_ALLOWED_DOMAINS is unset)"
leaks="$(printf '%s\n' "$logs" | grep -c -i -F -e 'smoke.invitee' -e 'smoke invitee' -e 'dev-person@' -e 'example.com' -e 'bearer ' -e '84949765022' -e 'pwd=' -e "$person" || true)"
echo "log lines with an email, name, Zoom id, meeting number, passcode or token: $leaks  (want 0)"
