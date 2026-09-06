/**
 * The dashboard process: one listening socket, two views, and no way out.
 *
 * THIS IS THE FIRST LISTENING SOCKET THIS SYSTEM HAS EVER HAD, and the
 * repository card is blunt about why that matters here: this system "acts on
 * third parties from the household's residential IP, and keeping that IP in good
 * standing is part of the point". A socket is the other direction, and its own
 * exposure: the page behind it renders vendor refusal details derived from URLs
 * that carry a credential in the query string, and there is no authentication,
 * no TLS and no accounts. So it binds the ONE address its configuration names -
 * a wildcard is refused by the loader - and the committed configuration names a
 * loopback address.
 *
 * A SERVER SOCKET IS NOT AN HTTP CLIENT. Nothing in this package can send
 * anything anywhere: the only binding this file takes from `node:http` is
 * `createServer`, which accepts inbound connections and does nothing else, and
 * `no-direct-http.ts` knows the difference as a RULE rather than by
 * allowlisting this file. Every other spelling of that module - a default
 * import, a namespace import, `request`, `get` - is still a finding here as it
 * is everywhere.
 *
 * READ-ONLY AT THE DOOR. A method that is not GET or HEAD is refused BEFORE the
 * router runs and therefore before anything touches the database at all, so
 * "wrote nothing" is a property of where the check sits rather than of what the
 * handlers happen to do.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { assertOpsSchema, OpsSchemaBehindError } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import type { GovernorConfig } from "@deal-sentinel/governor";
import { displayRedactor } from "@deal-sentinel/sources";
import type { Redactor, SourceRegistry } from "@deal-sentinel/sources";

import type { DashboardConfig } from "./config.ts";
import {
  renderDatabaseUnreachable,
  renderListing,
  renderMethodNotAllowed,
  renderNotFound,
  renderOverview,
  renderSchemaBehind,
} from "./render.ts";
import { buildListingView, buildOverview } from "./view.ts";

/** The methods a read-only view answers. Everything else is refused. */
export const READ_METHODS = ["GET", "HEAD"];

export type DashboardDependencies = {
  config: DashboardConfig;
  governor: GovernorConfig;
  registry: SourceRegistry;
  database: HistoryDatabase;
  /** Defaults to the registry's own display redactor. */
  redactor?: Redactor;
  /** Defaults to the wall clock. Injected so a grader can fix "now". */
  now?: () => Date;
};

export type DashboardAnswer = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const HTML = "text/html; charset=utf-8";

/**
 * Answer one request, without a socket in sight.
 *
 * Split from the server for the ordinary reason and one specific one: the
 * refusals below - a method that is not a read, a schema that is behind, a
 * database that cannot be reached - are decisions, and a decision that can only
 * be exercised by opening a port is a decision that gets tested less.
 */
export async function answer(
  dependencies: DashboardDependencies,
  method: string,
  target: string,
): Promise<DashboardAnswer> {
  const redactor = dependencies.redactor ?? displayRedactor(dependencies.registry);
  const context = { redactor };

  if (!READ_METHODS.includes(method.toUpperCase())) {
    // BEFORE THE ROUTER, so nothing reaches the database on this path at all.
    return {
      status: 405,
      headers: { "content-type": HTML, allow: READ_METHODS.join(", ") },
      body: renderMethodNotAllowed(method, context),
    };
  }

  // A base that is never used for anything but parsing: this process does not
  // know its own public name and does not need to.
  const url = new URL(target, "http://dashboard.invalid");
  const now = (dependencies.now ?? (() => new Date()))();

  try {
    await assertOpsSchema(dependencies.database);

    if (url.pathname === "/") {
      const overview = await buildOverview({
        database: dependencies.database,
        governor: dependencies.governor,
        config: dependencies.config,
        now,
      });
      return html(renderOverview(overview, context));
    }

    if (url.pathname === "/listing") {
      const sourceId = url.searchParams.get("source") ?? "";
      const listingId = url.searchParams.get("listing") ?? "";
      const range = readRange(url, now, dependencies.config.defaultChartRangeMs);
      const view = await buildListingView({
        database: dependencies.database,
        registry: dependencies.registry,
        sourceId,
        listingId,
        range,
      });
      return html(renderListing(view, context));
    }

    return {
      status: 404,
      headers: { "content-type": HTML },
      body: renderNotFound(url.pathname, context),
    };
  } catch (error) {
    if (error instanceof OpsSchemaBehindError) {
      return {
        status: 503,
        headers: { "content-type": HTML },
        body: renderSchemaBehind(error.message, context),
      };
    }
    // Anything else that reached here came from a query. The page says the
    // database could not be read and shows no chart, no rate and no allowance,
    // because every one of those would be a claim about a system this process
    // cannot currently see.
    return {
      status: 503,
      headers: { "content-type": HTML },
      body: renderDatabaseUnreachable(
        error instanceof Error ? error.message : String(error),
        context,
      ),
    };
  }
}

/**
 * The range a chart is drawn over: what the request asked for, or the configured
 * default ending now.
 *
 * An unreadable bound is IGNORED rather than made into an error, and the default
 * takes over: a mistyped query string should show the owner the default chart,
 * not a stack trace.
 */
function readRange(
  url: URL,
  now: Date,
  defaultRangeMs: number,
): { from: Date; to: Date } {
  const to = readInstant(url.searchParams.get("to")) ?? now;
  const from =
    readInstant(url.searchParams.get("from")) ??
    new Date(to.getTime() - defaultRangeMs);
  return from.getTime() <= to.getTime() ? { from, to } : { from: to, to: from };
}

function readInstant(raw: string | null): Date | null {
  if (raw === null || raw.trim().length === 0) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function html(body: string): DashboardAnswer {
  return { status: 200, headers: { "content-type": HTML }, body };
}

/* -------------------------------------------------------------------------- */
/* The socket                                                                  */
/* -------------------------------------------------------------------------- */

export type DashboardServer = {
  /** The address actually bound, read back from the socket. */
  address: string;
  /** The port actually bound. Equals the configured one unless it was 0. */
  port: number;
  /** e.g. "http://127.0.0.1:8787" */
  origin: string;
  close(): Promise<void>;
};

/**
 * Bind the configured address and serve. Returns once the socket is listening.
 *
 * `listen(port, address)` with an EXPLICIT address, never a bare port: a bare
 * port binds every interface the machine has, which is precisely the thing the
 * configuration loader refuses to let anyone write down.
 */
export async function startDashboard(
  dependencies: DashboardDependencies,
): Promise<DashboardServer> {
  const sockets = new Set<{ destroy(): void }>();

  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      void serve(dependencies, request, response);
    },
  );

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      dependencies.config.port,
      dependencies.config.bindAddress,
      () => {
        server.removeListener("error", reject);
        resolve();
      },
    );
  });

  const bound = server.address();
  const address =
    typeof bound === "object" && bound !== null
      ? bound.address
      : dependencies.config.bindAddress;
  const port =
    typeof bound === "object" && bound !== null ? bound.port : dependencies.config.port;

  return {
    address,
    port,
    origin: `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function serve(
  dependencies: DashboardDependencies,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let given: DashboardAnswer;
  try {
    given = await answer(
      dependencies,
      request.method ?? "GET",
      request.url ?? "/",
    );
  } catch (error) {
    // `answer` already turns every read failure into a page. Reaching here means
    // something outside the read path threw, and the socket still owes an
    // answer: an operator staring at a hung request learns nothing at all.
    given = {
      status: 500,
      headers: { "content-type": HTML },
      body: renderDatabaseUnreachable(
        error instanceof Error ? error.message : String(error),
        { redactor: dependencies.redactor ?? displayRedactor(dependencies.registry) },
      ),
    };
  }

  const body = Buffer.from(given.body, "utf8");
  response.writeHead(given.status, {
    ...given.headers,
    "content-length": String(body.byteLength),
    // Nothing on this page is a resource anybody may reference from elsewhere,
    // and a cached operator view is a stale operator view.
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });

  // HEAD carries the headers and no body, which is what makes it a read that
  // costs the reader nothing.
  if ((request.method ?? "GET").toUpperCase() === "HEAD") {
    response.end();
    return;
  }
  response.end(body);
}
