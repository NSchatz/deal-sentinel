/**
 * Probe for S0042 AC24: which spellings of "every interface" does Node accept
 * as a bind address, and which of those does the dashboard's loader refuse?
 *
 * Written by the impl-gate refuter. Report-only artifact.
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
  "127.0.0.1",
];

for (const addr of candidates) {
  const r = await tryBind(addr);
  console.log(addr.padEnd(44), r);
}

console.log("");
console.log("interfaces:");
for (const [name, addrs] of Object.entries(networkInterfaces())) {
  for (const a of addrs ?? []) console.log(" ", name, a.family, a.address);
}
