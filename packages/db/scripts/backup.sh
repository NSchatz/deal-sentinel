#!/usr/bin/env bash
#
# pnpm db:backup - back the price history up with PostgreSQL's own pg_dump.
#
# usage: HISTORY_DATABASE_URL=postgres://user:pass@host:5432/deal_sentinel_history \
#          packages/db/scripts/backup.sh [OUTPUT_FILE]
#
# The dump is written in pg_dump's custom format (-Fc), which pg_restore reads
# and which restores into an empty database without editing. A backup that has
# never been restored is not a backup, so the restore side of this pair is
# exercised by an automated test: test/integration/restore-proof.test.ts, at the
# repo root because it composes this package with the extractor.
#
# Arguments:
#   OUTPUT_FILE            optional. Where the dump lands. Default: a timestamped
#                          name under HISTORY_BACKUP_DIR.
#
# Flags:
#   -h, --help             print this help, with every exit code and its
#                          meaning, and exit 0
#
# Environment:
#   HISTORY_DATABASE_URL   required. libpq URL of the database to dump.
#   HISTORY_BACKUP_DIR     default ./backups. Where a generated name lands.
#   HISTORY_PG_RUNNER      local | docker. Default: local when pg_dump is on
#                          PATH, docker otherwise. The homelab case is docker:
#                          PostgreSQL runs in a container and the host has no
#                          client binaries installed.
#   HISTORY_PG_IMAGE       default
#                          postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
#                          The image the docker runner takes pg_dump from. Keep
#                          its major version at or above the server's. It must
#                          carry a tag AND an @sha256: digest: an override with
#                          no digest is REFUSED with exit status 3 rather than
#                          run, because a floating tag is a different pg_dump
#                          every time it resolves. See
#                          docs/decisions/0005-container-image-pinning.md.
#   HISTORY_PG_NETWORK     docker network to attach the runner container to,
#                          when the database is reachable by container name
#                          rather than from the host.
#
# Exit codes:
#   0  it ran and the answer is yes
#   1  it could not run or could not finish
#   2  the caller got the invocation wrong
#   3  it ran, every input was legible, and a constraint said no
#
# Example:
#   HISTORY_DATABASE_URL=postgres://sentinel@127.0.0.1:5432/deal_sentinel_history \
#     packages/db/scripts/backup.sh backups/history.dump
#
# The URL is never written to a command line this script controls: the docker
# runner forwards the variable by name, so the password does not appear in
# `docker inspect` or in this host's process list.
set -euo pipefail

help_text() {
  grep '^#' "$0" | sed '1d;s/^#\{1,2\} \{0,1\}//'
}

usage_error() {
  echo "backup: $1" >&2
  help_text >&2
  exit 2
}

output=""
positional=0
for argument in "$@"; do
  case "$argument" in
    -h | --help)
      help_text
      exit 0
      ;;
    -?*)
      usage_error "unrecognized flag '${argument}'"
      ;;
    *)
      positional=$((positional + 1))
      if [[ "$positional" -gt 1 ]]; then
        usage_error "${positional} arguments given and this command takes at most 1 (OUTPUT_FILE)"
      fi
      output="$argument"
      ;;
  esac
done

if [[ -z "${HISTORY_DATABASE_URL:-}" ]]; then
  echo "backup: HISTORY_DATABASE_URL is not set, so there is no history to dump." >&2
  exit 2
fi

backup_dir="${HISTORY_BACKUP_DIR:-backups}"
if [[ -z "$output" ]]; then
  mkdir -p "$backup_dir"
  output="${backup_dir}/deal-sentinel-history-$(date -u +%Y%m%dT%H%M%SZ).dump"
fi

mkdir -p "$(dirname "$output")"
output_dir="$(cd "$(dirname "$output")" && pwd)"
output_name="$(basename "$output")"

runner="${HISTORY_PG_RUNNER:-}"
if [[ -z "$runner" ]]; then
  if command -v pg_dump >/dev/null 2>&1; then
    runner="local"
  else
    runner="docker"
  fi
fi

step_failed() {
  echo "backup: the pg_dump step failed (runner: ${runner}, status ${1})." >&2
  echo "backup: nothing was backed up. This is not a refusal and not a usage error: the command could not finish, so it is worth retrying once pg_dump can reach the database." >&2
  exit 1
}

redacted="$(printf '%s' "$HISTORY_DATABASE_URL" | sed -E 's#//([^:@/]+):[^@/]*@#//\1:***@#')"
echo "backup: dumping ${redacted} to ${output_dir}/${output_name} (runner: ${runner})"

case "$runner" in
  local)
    status=0
    pg_dump \
      --format=custom \
      --no-owner \
      --no-privileges \
      --file "${output_dir}/${output_name}" \
      "$HISTORY_DATABASE_URL" || status=$?
    [[ "$status" -eq 0 ]] || step_failed "$status"
    ;;
  docker)
    image="${HISTORY_PG_IMAGE:-postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685}"
    if [[ "$image" != *"@sha256:"* ]]; then
      echo "backup: HISTORY_PG_IMAGE supplied '${image}', which carries no @sha256: digest." >&2
      echo "backup: pinning-conventions P1 - a container image is pinned by tag AND digest - so this refuses rather than running an image whose contents nobody has named." >&2
      echo "backup: supply the digest, as in HISTORY_PG_IMAGE=name:tag@sha256:<64 hex>. docs/decisions/0005-container-image-pinning.md says how to resolve one." >&2
      exit 3
    fi
    network_args=()
    if [[ -n "${HISTORY_PG_NETWORK:-}" ]]; then
      network_args=(--network "$HISTORY_PG_NETWORK")
    fi
    status=0
    docker run --rm \
      "${network_args[@]}" \
      --user "$(id -u):$(id -g)" \
      -v "${output_dir}:/backup" \
      -e HISTORY_DATABASE_URL \
      -e "HISTORY_OUTPUT_NAME=${output_name}" \
      "$image" \
      sh -c 'exec pg_dump --format=custom --no-owner --no-privileges --file "/backup/${HISTORY_OUTPUT_NAME}" "$HISTORY_DATABASE_URL"' || status=$?
    [[ "$status" -eq 0 ]] || step_failed "$status"
    ;;
  *)
    echo "backup: unknown HISTORY_PG_RUNNER '${runner}' (expected local or docker)" >&2
    exit 2
    ;;
esac

echo "backup: wrote ${output_dir}/${output_name}"
