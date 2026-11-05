# Shared helpers for the installer's end-to-end tests.
# Loaded with `load helpers` from a .bats file in this directory.

# The tree streamed in by setup/test/run.sh.
WORK=${WORK:-/work}
# The install's compose project. Passed with -p here only: the installer must
# pin its own project name, so the tests never set COMPOSE_PROJECT_NAME.
BWAT_PROJECT=bwat

# Pebble's HTTPS listener certificate is signed by this root (its "minica"),
# copied out of the Pebble container. Certificates Pebble *issues* chain to a
# different root, served on its management port at /roots/0.
PEBBLE_LISTENER_ROOT=${BATS_FILE_TMPDIR:-/tmp}/pebble-listener-root.pem
PEBBLE_DIRECTORY=https://localhost:14000/dir

# Remove every container, network and volume of the bwat project. Runs by
# project name from outside the tree, so it needs no .env: the base compose
# file refuses to load without its required variables.
harness_reset() {
  (cd / && docker compose -p "$BWAT_PROJECT" down -v --remove-orphans)
}

# Start Pebble from compose.local.yml, from nothing, and fetch its listener root.
harness_pebble_up() {
  harness_reset
  cd "$WORK" || return 1
  # compose.local.yml also adjusts the install's edge, which only the base file
  # defines; a stand-in from stdin lets it load on its own.
  local pebble=(docker compose -p "$BWAT_PROJECT" -f compose.local.yml -f -)
  echo 'services: {edge: {image: scratch}}' | "${pebble[@]}" up -d pebble
  echo 'services: {edge: {image: scratch}}' | "${pebble[@]}" cp pebble:/test/certs/pebble.minica.pem "$PEBBLE_LISTENER_ROOT"
}

# What Zoom's Beta Test asks for; zoom-manifest and setup -y refuse to go without them.
export BWAT_ZOOM_COMPANY=Example BWAT_ZOOM_CONTACT_NAME=Ada BWAT_ZOOM_CONTACT_EMAIL=ada@example.com
