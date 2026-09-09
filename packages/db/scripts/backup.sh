#!/usr/bin/env bash
#
# Back the price history up with PostgreSQL's own pg_dump.
#
#   HISTORY_DATABASE_URL=postgres://user:pass@host:5432/deal_sentinel_history \
#     packages/db/scripts/backup.sh [OUTPUT_FILE]
#
# The dump is written in pg_dump's custom format (-Fc), which pg_restore reads
# and which restores into an empty database without editing. A backup that has
# never been restored is not a backup, so the restore side of this pair is
# exercised by an automated test: test/integration/restore-proof.test.ts, at the
# repo root because it composes this package with the extractor.
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
# The URL is never written to a command line this script controls: the docker
# runner forwards the variable by name, so the password does not appear in
# `docker inspect` or in this host's process list.
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  grep '^#' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
  exit 0
fi

if [[ -z "${HISTORY_DATABASE_URL:-}" ]]; then
  echo "backup: HISTORY_DATABASE_URL is not set, so there is no history to dump." >&2
  exit 2
fi

backup_dir="${HISTORY_BACKUP_DIR:-backups}"
output="${1:-}"
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

redacted="$(printf '%s' "$HISTORY_DATABASE_URL" | sed -E 's#//([^:@/]+):[^@/]*@#//\1:***@#')"
echo "backup: dumping ${redacted} to ${output_dir}/${output_name} (runner: ${runner})"

case "$runner" in
  local)
    pg_dump \
      --format=custom \
      --no-owner \
      --no-privileges \
      --file "${output_dir}/${output_name}" \
      "$HISTORY_DATABASE_URL"
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
    docker run --rm \
      "${network_args[@]}" \
      --user "$(id -u):$(id -g)" \
      -v "${output_dir}:/backup" \
      -e HISTORY_DATABASE_URL \
      -e "HISTORY_OUTPUT_NAME=${output_name}" \
      "$image" \
      sh -c 'exec pg_dump --format=custom --no-owner --no-privileges --file "/backup/${HISTORY_OUTPUT_NAME}" "$HISTORY_DATABASE_URL"'
    ;;
  *)
    echo "backup: unknown HISTORY_PG_RUNNER '${runner}' (expected local or docker)" >&2
    exit 2
    ;;
esac

echo "backup: wrote ${output_dir}/${output_name}"
