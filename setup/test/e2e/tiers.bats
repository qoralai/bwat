#!/usr/bin/env bats
# The tiered install (QOR-5007, QOR-5009, D202): local on this computer with no Google, signed
# in with a code; moving up to production; what setup says it left for later.

load helpers

setup_file() {
  harness_reset
  rm -rf "$WORK/.env" "$WORK/.bwat" "$WORK/zoom-manifest.json" "$WORK/zoom-board-manifest.json" "$WORK/bwat.answers"
}

teardown_file() {
  harness_reset
}

setup() {
  cd "$WORK"
}

# The code setup left for the page (no terminal under bats), read once.
code() {
  cat .bwat/signin-code
}
code_signin() {
  curl -sS -o "$BATS_TEST_TMPDIR/body" -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"code\":\"$1\",\"email\":\"$2\"}" http://127.0.0.1:8080/v1/code-signin
}

@test "local: a fresh install with no Google, at this computer's address, with a sign-in code" {
  run env BWAT_TIER=local BWAT_FIRST_OWNER_EMAIL=Owner@Home.Example ./bwat setup -y
  [ "$status" -eq 0 ]
  [[ "$output" == *'Tier: local'*'Step 2 of 7: Sign-in'*'Step 3 of 7: Your Zoom app'*'bwat is installed and running.'* ]]
  if [[ "$output" == *'Google'*'client'* ]]; then
    echo 'asked about Google on a local install' >&2; return 1
  fi
  grep -qx 'BWAT_TIER=local' .env
  grep -qx 'BWAT_MODE=developer' .env
  grep -qx 'BWAT_PUBLIC_URL=http://localhost:8080' .env
  grep -qx 'BWAT_FIRST_OWNER_EMAIL=owner@home.example' .env
  grep -qx 'BWAT_GOOGLE_CLIENT_IDS=' .env
  grep -qx 'BWAT_ALLOWED_DOMAINS=' .env
  grep -qE '^BWAT_SIGNIN_CODE_SHA256=[0-9a-f]{64}$' .env

  # No terminal: the code waits for the setup page in a file only this user reads, and is
  # in no log.
  [[ "$output" == *'The setup page shows it once and deletes it'* ]]
  [ "$(stat -c %a .bwat/signin-code)" = 600 ]
  [[ "$(code)" =~ ^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){7}$ ]]
  ! grep -rqF "$(code)" .bwat/logs/

  # The closing lines: how to sign in, what is still missing, and the next tier.
  [[ "$output" == *'1. Open http://localhost:8080 and sign in with the code below and your email, owner@home.example'* ]]
  [[ "$output" == *'Still missing'*'The Zoom credentials'*'The OpenRouter key'* ]]
  [[ "$output" == *'This install is local (this computer only). For a cloud server that joins meetings on its own: ./bwat setup --tier production.'* ]]

  # The backend signs the owner in with the code, typed loosely.
  [ "$(code_signin "$(code | tr 'A-Z' 'a-z' | tr -d -)" owner@home.example)" = 200 ]
  grep -q '"role":"owner"' "$BATS_TEST_TMPDIR/body"
  grep -q '"token":"bwz_' "$BATS_TEST_TMPDIR/body"
  [ "$(code_signin WRONG-CODE owner@home.example)" = 401 ]
  # Anyone with the code is a member under the email they type.
  [ "$(code_signin "$(code)" teammate@anywhere.example)" = 200 ]
  grep -q '"role":"member"' "$BATS_TEST_TMPDIR/body"

  # The board's own sign-in takes the code too, never Google.
  run curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' http://127.0.0.1:8080/
  [[ "$output" == '302 '*'/auth/login'* ]]
  run curl -sS http://127.0.0.1:8080/auth/login
  [[ "$output" == *'Install code'* ]]
  run curl -sS -c "$BATS_TEST_TMPDIR/jar" -H 'content-type: application/json' \
    -d "{\"code\":\"$(code)\",\"email\":\"owner@home.example\"}" http://127.0.0.1:8080/auth/code
  [ "$output" = '{"next":"/"}' ]
  run curl -sS -b "$BATS_TEST_TMPDIR/jar" http://127.0.0.1:8080/whoami
  [[ "$output" == *'"email":"owner@home.example"'* ]]
}

@test "local: a second run keeps the code; --new-code makes a new one and the old one stops" {
  old=$(code)
  digest=$(grep '^BWAT_SIGNIN_CODE_SHA256=' .env)
  rm -f .bwat/signin-code
  run ./bwat setup -y
  [ "$status" -eq 0 ]
  [ ! -e .bwat/signin-code ]
  grep -qx "$digest" .env
  [[ "$output" == *'Sign in with the code setup showed when it made this install'* ]]

  run ./bwat setup -y --new-code
  [ "$status" -eq 0 ]
  [[ "$output" == *'made a new sign-in code'* ]]
  ! grep -qx "$digest" .env
  [ "$(code)" != "$old" ]
  [ "$(code_signin "$old" owner@home.example)" = 401 ]
  [ "$(code_signin "$(code)" owner@home.example)" = 200 ]
}

@test "local: an install saved as t0, the tier's old name, carries on as local" {
  sed -i 's/^BWAT_TIER=local$/BWAT_TIER=t0/' .env
  run ./bwat setup -y
  [ "$status" -eq 0 ]
  [[ "$output" == *'Tier t0 is now called local.'*'Tier: local'* ]]
  grep -qx 'BWAT_TIER=local' .env
}

@test "local to production: the owner must be one Google can sign in, and the code stops" {
  google=(BWAT_GOOGLE_CLIENT_ID=1-web.apps.googleusercontent.com BWAT_GOOGLE_CLIENT_SECRET=test-client-secret
    BWAT_GOOGLE_DESKTOP_CLIENT_ID=2-desktop.apps.googleusercontent.com BWAT_GOOGLE_DESKTOP_CLIENT_SECRET=desk-secret
    BWAT_PUBLIC_URL=https://bwat.test BWAT_TLS=external)
  # An owner outside the Google domains: setup stops before writing anything.
  run env "${google[@]}" BWAT_ALLOWED_DOMAINS=company.example ./bwat setup -y --tier production
  [ "$status" -eq 2 ]
  [[ "$output" == *'The owner, owner@home.example, is not in your Google domains (company.example)'* ]]
  grep -qx 'BWAT_TIER=local' .env

  run env "${google[@]}" BWAT_ALLOWED_DOMAINS=home.example ./bwat setup -y --tier production
  [ "$status" -eq 0 ]
  grep -qx 'BWAT_TIER=production' .env
  grep -qx 'BWAT_MODE=production' .env
  grep -qx 'BWAT_SIGNIN_CODE_SHA256=' .env
  [[ "$output" == *'Step 2 of 7: Google sign-in'* ]]
  [[ "$output" == *'This install is production, the last tier.'* ]]
  [ "$(code_signin "$(code)" owner@home.example)" = 404 ]
  # The owner stays; the teammate who joined by code is removed, their email kept.
  [ "$(docker compose exec -T postgres psql -U postgres -d bwat -tAc \
    "select string_agg(email || ':' || role, ',' order by email) from bwat.members")" = 'owner@home.example:owner' ]
  [ "$(docker compose exec -T postgres psql -U postgres -d bwat -tAc \
    "select string_agg(email, ',') from bwat.removed_members")" = 'teammate@anywhere.example' ]

  # A tier only adds steps.
  run ./bwat setup -y --tier local
  [ "$status" -eq 2 ]
  [[ "$output" == *'This install is production; a tier only adds steps, so it cannot go back to local.'* ]]
}

@test "--tier and --new-code refuse what they cannot do" {
  run ./bwat setup --tier team
  [ "$status" -eq 2 ]
  [[ "$output" == *'--tier must be local or production'* ]]
  run ./bwat setup --tier t0
  [ "$status" -eq 2 ]
  [[ "$output" == *"--tier must be local or production (got 't0')"* ]]
  run env BWAT_TIER=team ./bwat setup -y
  [ "$status" -eq 2 ]
  [[ "$output" == *"BWAT_TIER must be local or production (got 'team')"*'Run ./bwat setup --tier production to carry this install on'* ]]
  run ./bwat setup -y --new-code
  [ "$status" -eq 2 ]
  [[ "$output" == *'--new-code is for a local install; this one is production'* ]]
}
