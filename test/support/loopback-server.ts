/**
 * A stub HTTP server on 127.0.0.1, and the reason the suite has one.
 *
 * This phase exists to protect the household's residential IP, so a test suite
 * that reached a real retailer to prove it would be the defect it is testing
 * for. Every robots, back-pressure and breaker case is exercised against this
 * server: it binds to loopback, it is given an ephemeral port, and it is closed
 * in the test's teardown.
 *
 * It SERVES. It never sends. `node:http` appears here for `createServer` and
 * for nothing else, which is why `test/support/loopback-server.ts` is on the
 * one-rule allowlist in `packages/governor/src/no-direct-http.ts`.
 */

import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type StubHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

export type ServedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
};

export type LoopbackServer = {
  /** e.g. "http://127.0.0.1:41234" */
  origin: string;
  port: number;
  /** Every request the server accepted, in order. */
  served: ServedRequest[];
  /** Requests accepted for one path. */
  servedFor(path: string): ServedRequest[];
  close(): Promise<void>;
};

export async function startLoopbackServer(
  handler: StubHandler,
  /**
   * Any address in 127.0.0.0/8 - all of it is loopback. A second one is how a
   * test shows two hosts accounted for separately without leaving the machine.
   */
  host = "127.0.0.1",
): Promise<LoopbackServer> {
  const served: ServedRequest[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((request, response) => {
    served.push({
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
    });
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.writableEnded) {
        response.statusCode = 500;
        response.end("stub handler threw");
      }
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    // A loopback address explicitly: never 0.0.0.0, never a hostname that could
    // resolve off this machine.
    server.listen(0, host, resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://${host}:${address.port}`,
    port: address.port,
    served,
    servedFor(path) {
      return served.filter((request) => request.path === path);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * A port with nothing listening on it, for the connection-failure half of the
 * unreachable case: a server is opened on loopback purely to be given a port,
 * then closed before anything is asked of it.
 */
export async function closedLoopbackOrigin(): Promise<string> {
  const server = await startLoopbackServer((_request, response) => {
    response.end();
  });
  const origin = server.origin;
  await server.close();
  return origin;
}

/** Route table helper: exact path (ignoring the query) to a handler. */
export function routes(table: Record<string, StubHandler>, fallbackStatus = 404): StubHandler {
  return (request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const handler = table[path];
    if (handler === undefined) {
      response.statusCode = fallbackStatus;
      response.end(`no stub route for ${path}`);
      return;
    }
    return handler(request, response);
  };
}

/** Answer with a status, a body and any headers. */
export function reply(
  status: number,
  body = "",
  headers: Record<string, string> = {},
): StubHandler {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
    response.end(body);
  };
}
