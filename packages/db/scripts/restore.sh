#!/usr/bin/env bash
#
# Restore the price history from a pg_dump custom-format dump.
#
#   HISTORY_DATABASE_URL=postgres://user:pass@host:5432/deal_sentinel_history \
#     packages/db/scripts/restore.sh backups/deal-sentinel-history-....dump
#
# The target is expected to be an EMPTY database on a freshly created volume:
# the ordinary recovery is "the volume is gone, make a new one, restore into
# it". The restore runs in a single transaction, so a dump that fails part way
# leaves the target as it was rather than half a history.
#
# `--clean --if-exists` is passed so restoring over an existing schema replaces
# it rather than colliding with it. That is destructive by design and by
# request: this script is the thing you run when the history you have is the
# one you want to replace. It is refused unless the dump exists and is
# readable.
#
# Environment:
#   HISTORY_DATABASE_URL   required. libpq URL of the database to restore INTO.
#   HISTORY_PG_RUNNER      local | docker. Default: local when pg_restore is on
#                          PATH, docker otherwise.
#   HISTORY_PG_IMAGE       default
#                          postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
#                          It must carry a tag AND an @sha256: digest: an
#                          override with no digest is REFUSED with exit status 3
#                          rather than run, because a floating tag is a
#                          different pg_restore every time it resolves. See
#                          docs/decisions/0005-container-image-pinning.md.
#   HISTORY_PG_NETWORK     docker network to attach the runner container to.
#
# The URL is never written to a command line this script controls: the docker
# runner forwards the variable by name, so the password does not appear in
# `docker inspect` or in this host's process list.
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -eq 0 ]]; then
  grep '^#' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
  [[ $# -eq 0 ]] && exit 2
  exit 0
fi

if [[ -z "${HISTORY_DATABASE_URL:-}" ]]; then
  echo "restore: HISTORY_DATABASE_URL is not set, so there is no target to restore into." >&2
  exit 2
fi

dump="$1"
if [[ ! -r "$dump" ]]; then
  echo "restore: cannot read dump file '${dump}'." >&2
  exit 2
fi

dump_dir="$(cd "$(dirname "$dump")" && pwd)"
dump_name="$(basename "$dump")"

runner="${HISTORY_PG_RUNNER:-}"
if [[ -z "$runner" ]]; then
  if command -v pg_restore >/dev/null 2>&1; then
    runner="local"
  else
    runner="docker"
  fi
fi

redacted="$(printf '%s' "$HISTORY_DATABASE_URL" | sed -E 's#//([^:@/]+):[^@/]*@#//\1:***@#')"
echo "restore: restoring ${dump_dir}/${dump_name} into ${redacted} (runner: ${runner})"

case "$runner" in
  local)
    pg_restore \
      --clean \
      --if-exists \
      --no-owner \
      --no-privileges \
      --single-transaction \
      --dbname "$HISTORY_DATABASE_URL" \
      "${dump_dir}/${dump_name}"
    ;;
  docker)
    image="${HISTORY_PG_IMAGE:-postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685}"
    if [[ "$image" != *"@sha256:"* ]]; then
      echo "restore: HISTORY_PG_IMAGE supplied '${image}', which carries no @sha256: digest." >&2
      echo "restore: pinning-conventions P1 - a container image is pinned by tag AND digest - so this refuses rather than restoring the history with an image whose contents nobody has named." >&2
      echo "restore: supply the digest, as in HISTORY_PG_IMAGE=name:tag@sha256:<64 hex>. docs/decisions/0005-container-image-pinning.md says how to resolve one." >&2
      exit 3
    fi
    network_args=()
    if [[ -n "${HISTORY_PG_NETWORK:-}" ]]; then
      network_args=(--network "$HISTORY_PG_NETWORK")
    fi
    docker run --rm \
      "${network_args[@]}" \
      --user "$(id -u):$(id -g)" \
      -v "${dump_dir}:/backup:ro" \
      -e HISTORY_DATABASE_URL \
      -e "HISTORY_DUMP_NAME=${dump_name}" \
      "$image" \
      sh -c 'exec pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --dbname "$HISTORY_DATABASE_URL" "/backup/${HISTORY_DUMP_NAME}"'
    ;;
  *)
    echo "restore: unknown HISTORY_PG_RUNNER '${runner}' (expected local or docker)" >&2
    exit 2
    ;;
esac

echo "restore: restored ${dump_name}"
echo "restore: run 'pnpm db:start-check' against the restored database to confirm its completed-initialization marker came back."
