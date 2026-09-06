/**
 * Second probe for S0042 AC24, written in the F1 fix loop.
 *
 * The impl-gate refuter's `regress_0042_probe_bind.mjs` measured six spellings.
 * This one widens the list so the SEMANTIC refusal in
 * `packages/dashboard/src/config.ts` can be checked against what this runtime
 * actually does rather than against a list somebody thought of: every spelling
 * below that binds the unspecified address has to be refused by the loader, and
 * every spelling that binds a real single address has to be accepted.
 *
 * Report-only artifact. Run with:
 *
 *     node tests/regress_0042_probe_bind2.mjs
 */
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

async function tryBind(addr) {
  const server = createServer((_q, s) => s.end("hi"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, addr, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const bound = server.address();
    await new Promise((r) => server.close(() => r()));
    return "OK bound=" + JSON.stringify(bound);
  } catch (e) {
    return "REFUSED " + (e.code ?? e.message);
  }
}

const candidates = [
  "0.0.0.0",
  "::",
  "::ffff:0.0.0.0",
  "0",
  "::0",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "0:0:0:0:0:0:0:0",
  "0.0",
  "0.0.0",
  "0x0",
  "00",
  "000.000.000.000",
  "::ffff:0:0",
  "::0.0.0.0",
  "[::]",
  "0x00000000",
  "0.0.0.0.0",
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
  "*",
  "0000000000",
  "2130706433",
];

for (const addr of candidates) {
  const r = await tryBind(addr);
  console.log(JSON.stringify(addr).padEnd(46), r);
}

console.log("");
console.log("interfaces:");
for (const [name, addrs] of Object.entries(networkInterfaces())) {
  for (const a of addrs ?? []) console.log(" ", name, a.family, a.address);
}
