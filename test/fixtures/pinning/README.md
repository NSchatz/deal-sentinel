# Offending samples for the pinning check

Every file here carries a `.fixture` extension for the same reason the samples
in `../no-direct-http/` do: the repository-wide scan must not read them as tree
content, and the test that grades them must not itself become a finding. The
fixture's TEXT is handed to `scanPinning` under a SYNTHETIC path
(`docker-compose.yml`, `Dockerfile`, `.github/workflows/ci.yml`, ...), which is
what decides which rules apply to it. That indirection is also why no file here
is named `Dockerfile`: this repository contains none, `test/unit/pinning.test.ts`
asserts that absence, and a fixture with that name would make the assertion a
lie.

Half of these are meant to go red and half are meant to pass. A check proved
only against violations refuses everything; a check proved only against a clean
tree cannot fail. Both halves are the evidence.
