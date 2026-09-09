# Captured test-run output for the CI gate's own check

Two REAL captures of `node --test`, kept because the property they demonstrate
is one nobody believes from prose.

`test-run-green.txt.fixture` is `node --test test/unit/breaker.test.ts` on a
machine where everything ran: seven tests, zero skipped, exit status 0.

`test-run-docker-absent.txt.fixture` is `node --test
test/integration/alert-run.test.ts` with `HISTORY_TEST_SKIP_DOCKER=1`, which is
what a runner with no usable Docker daemon produces. Read its summary: **`tests
0`, `skipped 0`, and the process exited 0.** A suite skipped with
`describe(..., { skip }, ...)` - which is exactly how the three Docker-guarded
integration files are written - never reaches the `skipped` count at all, so a
check that trusted that count would report a confident green over a run that
executed nothing. The only signal left is the reporter's per-item marker on line
one, and `test/support/test-run-summary.ts` reads both.

Both carry a `.fixture` extension for the reason the samples in `../pinning/`
do: no scan over this repository's tree should read them as tree content.
