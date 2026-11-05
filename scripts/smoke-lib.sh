# Sourced by scripts/smoke-*.sh from the repository root: the local stack's address and the
# dev person's token, read from .env without exporting the rest of it.

# One value from .env, unquoted; empty if the line is absent.
env_value() {
  local value
  value="$(grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true)"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

port="$(env_value BWAT_PORT)"; port="${port:-3000}"
person="$(env_value BWAT_DEV_PERSON_TOKEN)"
base="http://127.0.0.1:${port}"
api="$base/v1"
py="$(command -v python || command -v python3 || true)"
# One field of the JSON on stdin, as a Python expression over `d`.
json() {
  [ -n "$py" ] || { echo "python or python3 is needed on PATH" >&2; return 1; }
  "$py" -c "import sys,json;d=json.load(sys.stdin);print($1)"
}
# Stops the script unless .env sets the dev person's token.
need_person() {
  [ -n "$person" ] || { echo "set BWAT_DEV_PERSON_TOKEN in .env (see .env.docker.example)" >&2; exit 1; }
}
# Calls a people's route. The token's header reaches curl as config on stdin, so it never sits
# in curl's arguments (ps, /proc/*/cmdline). Works with Linux and Windows curl alike.
person_curl() {
  printf 'header = "authorization: Bearer %s"\n' "$person" \
    | curl -s --config - -H 'content-type: application/json' "$@"
}
# The status code alone.
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# A people's route as the dev person: `call <method> <path> [curl args]`, the body then the
# status on its own last line. A JSON content-type only with a body: Fastify answers 400 to an
# empty JSON body.
call() {
  local method="$1" path="$2"; shift 2
  local type=(); [ $# -gt 0 ] && type=(-H 'content-type: application/json')
  curl -s -w '\n%{http_code}' -X "$method" "$api$path" -H "authorization: Bearer $person" "${type[@]}" "$@"
}
status() { tail -1; }
body() { sed '$d'; }
# One SQL statement against the stack's database (the script's $project).
psql_c() { docker compose -p "$project" exec -T postgres psql -U postgres -d bwat -qtAc "$1"; }
