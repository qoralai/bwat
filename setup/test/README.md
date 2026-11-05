# Installer tests

End-to-end tests for the installer run on a throwaway Linux host: a privileged
`docker:dind` container with its own Docker Engine, plus bash, bats and curl.

```
bash setup/test/run.sh                               # every file in setup/test/e2e
bash setup/test/run.sh setup/test/e2e/harness.bats   # one file
bash setup/test/run.sh $(setup/test/shard 2)         # one shard's files
```

You need bash, git, GNU tar and Docker with Compose (on macOS, `gtar` from
Homebrew in place of the system bsdtar). On Windows, Git Bash with Docker
Desktop works; a CI job can run the same command on Ubuntu, split into the three
shards whose files `setup/test/shard` names. A new test file joins the last shard
unless it is named in another; name it in the first two only to rebalance them.

## What `run.sh` does

1. Recreates the test host from `setup/test/compose.yml` (project
   `bwat-installer-test`). The inner Engine keeps its images in the
   `docker-cache` volume, so later runs pull less. The host is removed when the
   run ends; `KEEP=1 bash setup/test/run.sh` leaves it up for debugging
   (`docker compose -f setup/test/compose.yml exec host sh`). To start from
   nothing: `docker compose -f setup/test/compose.yml down -v`.
2. Streams the tree into `/work` on the host: `git ls-files -co --exclude-standard`
   piped through `tar` (tracked and untracked files, minus ignored ones). It is
   not a bind mount, so line endings arrive as saved: uncommitted edits are
   included, and a file saved with CRLF arrives with CRLF. File modes are then
   set from git's index (`100755` gives 0755, all else 0644), whatever the
   checkout's own modes; an untracked file gets 0644, as `git add` on Windows
   would give it.
3. Copies `setup/test/compose.pebble.yml` to `/work/compose.local.yml`, so
   Pebble, the ACME test CA, joins the same compose project as the install.
4. Runs bats on the given files inside the host.

## Writing a test

- Put it in `setup/test/e2e/` and `load helpers`.
- Start each file from nothing: call `harness_reset` (the `bwat` compose project
  `down -v --remove-orphans`) or `harness_pebble_up` (reset, then start Pebble)
  in `setup_file`.
- Pebble's directory is `$PEBBLE_DIRECTORY` on the host's loopback. Its HTTPS
  listener is signed by `$PEBBLE_LISTENER_ROOT`; certificates it issues chain to
  a different root, served at `https://localhost:15000/roots/0`.
- Use example names only (`bwat.test`, `example.com`).
- Never set `COMPOSE_PROJECT_NAME`: the installer must pin its own project
  name. The helpers pass `-p "$BWAT_PROJECT"` themselves.

`harness.bats` is the harness's own check: the inner Engine answers and Pebble
answers over verified HTTPS. `install.bats` holds the acceptance tests A1 and A2,
skipped until `./bwat` exists.
