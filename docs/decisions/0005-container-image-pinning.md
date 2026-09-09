# 0005 - The container image is pinned by tag and digest

Every place this repository resolves a container image names it as
`tag@digest`. The tag stays readable to a human; the digest is what actually
resolves. **The pin freezes the history database image at one specific build
until somebody moves it, security refreshes included.** That is the trade, and
this file is the two-minute answer to moving it.

## What is pinned

| reference | pin |
|---|---|
| `postgres:16-alpine` | `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` |

Four sites take it, and they are the whole list:

- `docker-compose.yml`, the `history-db` service `image:` key - what the
  homelab actually runs.
- `packages/db/scripts/backup.sh`, the `HISTORY_PG_IMAGE` default - where
  `pg_dump` comes from when the host has no client binaries.
- `packages/db/scripts/restore.sh`, the same default - where `pg_restore`
  comes from.
- `test/support/postgres-container.ts`, `DEFAULT_POSTGRES_IMAGE` - every
  integration container and the docker preflight.

## Where the digest came from, and when

Resolved **2026-09-08** from Docker Hub's own tag record for the official
library image:

```sh
curl -s https://hub.docker.com/v2/namespaces/library/repositories/postgres/tags/16-alpine | jq -r .digest
```

That URL is the whole refresh procedure. Paste it, take the `digest` field,
replace the value in the four sites above, and run `pnpm test:unit` - the
pinning check reds until every site agrees.

At the moment it was resolved the tag was `tag_status: active`, last pushed
2026-08-16, and its index carried eight real platform manifests, `linux/amd64`
and `linux/arm64` among them, all active.

## Why the INDEX digest and not a platform one

The same record lists a per-platform digest for each architecture. Pinning
`linux/amd64`'s would work on the homelab host and fail outright on an arm64
developer machine, which is the opposite of what a pin is for. The value above
is the multi-architecture **index** digest: `docker run`, `docker compose` and
`docker pull` all accept it, and each host resolves the platform manifest it
needs from underneath it.

## Why pin at all

The umbrella's `documentation/pinning-conventions.md` (operator, 2026-09-07) is
the normative text; the clauses that bite here are P1 (an image is pinned by
tag AND digest), P5 (pin to something the publisher keeps), P6 (there is never
a fallback) and P8 (rot is discovered when a build fails, deliberately).

The reason this repository in particular cares: `test/integration/restore-proof.test.ts`
is this phase's evidence. It dumps a real database, destroys the container and
its named volume, restores into a fresh one and compares every observation row
for row. The image is not only where the database runs, it is the instrument
that measurement is taken with, so a floating tag means the proof was taken
with a different instrument each time it was run. Nobody would notice, which is
the problem.

## What refuses, and with which status

`test/unit/pinning.test.ts` runs inside `pnpm test:unit` - no docker daemon, no
registry, no credentials - and reds on any unpinned reference, naming the file,
the line, the reference and the clause.

Setting `HISTORY_PG_IMAGE` or `HISTORY_TEST_PG_IMAGE` to a reference with no
`@sha256:` digest is REFUSED rather than run: **exit status 3** from either
database script, and a thrown `UnpinnedImageError` carrying the same status
from the integration harness. Both scripts already exit 2 for a usage error, so
3 says "the pin was refused" and nothing else. That is a deliberate behaviour
change for anyone who used the variable to point at a locally built image: the
answer is to supply that image's digest, which `docker image inspect --format
'{{index .RepoDigests 0}}' <image>` prints for anything already pulled.

## When Docker Hub garbage-collects the index

A digest that no longer exists is a pull failure with a longer message than a
missing tag, and it is the first thing an operator sees. The refresh URL above
is the whole answer, which is why it is written out rather than described. P8
is explicit that no scheduled liveness check is required here, and this
repository adds none: asking a third party every night whether it is up reds
unrelated work when it is not.
