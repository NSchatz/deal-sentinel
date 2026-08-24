/**
 * The write path's guard, proved without a database.
 *
 * The writer handed in here EXPLODES if it is called. That is the assertion: an
 * extraction failure must not reach a write, and the cheapest way to prove it
 * is to make reaching the writer fatal.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtractionResult, ObservationContext } from "@deal-sentinel/shared";

import { InvalidObservationError } from "../src/errors.ts";
import { RAW_CONTEXT_MAX_CHARS } from "../src/schema.ts";
import { boundRawContext, recordObservation } from "../src/write-path.ts";
import type { HistoryWriter, NewPriceObservationRow } from "../src/index.ts";

const explodingWriter: HistoryWriter = {
  async insertObservation() {
    throw new Error("the write path reached a writer with a failed extraction");
  },
};

function capturingWriter(): {
  writer: HistoryWriter;
  rows: NewPriceObservationRow[];
} {
  const rows: NewPriceObservationRow[] = [];
  return {
    rows,
    writer: {
      async insertObservation(row) {
        rows.push(row);
        return BigInt(rows.length);
      },
    },
  };
}

const context: ObservationContext = {
  sourceId: "fixture-suite",
  listingId: "https://example.invalid/tools/drill-18v-kit",
  observedAt: new Date("2026-08-24T14:30:00.000Z"),
  sourceTimeZone: "America/New_York",
  rawContext: "<script type=\"application/ld+json\">{}</script>",
};

describe("a typed extraction failure never reaches a write", () => {
  const reasons = ["no-offer", "ambiguous-offer", "no-price", "no-currency"] as const;

  for (const reason of reasons) {
    it(`refuses ${reason} without touching the writer`, async () => {
      const result: ExtractionResult = { ok: false, reason };
      const outcome = await recordObservation(explodingWriter, result, context);
      assert.deepEqual(outcome, { written: false, reason });
    });
  }

  it("carries the extractor's own reason through unchanged", async () => {
    const outcome = await recordObservation(
      explodingWriter,
      { ok: false, reason: "ambiguous-offer" },
      context,
    );
    assert.equal(outcome.written, false);
    assert.equal(outcome.written === false && outcome.reason, "ambiguous-offer");
  });
});

describe("a success becomes exactly one row", () => {
  it("carries the minor-unit amount, the currency and both time fields", async () => {
    const { writer, rows } = capturingWriter();
    const outcome = await recordObservation(
      writer,
      {
        ok: true,
        amountMinorUnits: 12999n,
        currency: "USD",
        availability: "https://schema.org/InStock",
      },
      { ...context, vendorPriceUpdatedAt: new Date("2026-08-23T09:00:00.000Z") },
    );

    assert.equal(outcome.written, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amountMinorUnits, 12999n);
    assert.equal(rows[0].currency, "USD");
    assert.equal(rows[0].observedAt.toISOString(), "2026-08-24T14:30:00.000Z");
    assert.equal(rows[0].sourceTimeZone, "America/New_York");
    assert.equal(
      rows[0].vendorPriceUpdatedAt?.toISOString(),
      "2026-08-23T09:00:00.000Z",
    );
  });

  it("stores an unrecognised availability token verbatim", async () => {
    const { writer, rows } = capturingWriter();
    await recordObservation(
      writer,
      {
        ok: true,
        amountMinorUnits: 1n,
        currency: "USD",
        availability: "https://schema.org/ShipsInTwoToThreeWeeks",
      },
      context,
    );
    assert.equal(
      rows[0].availability,
      "https://schema.org/ShipsInTwoToThreeWeeks",
    );
  });

  it("records an absent availability as null rather than as a token", async () => {
    const { writer, rows } = capturingWriter();
    await recordObservation(
      writer,
      { ok: true, amountMinorUnits: 1n, currency: "USD", availability: "" },
      context,
    );
    assert.equal(rows[0].availability, null);
  });

  it("leaves the store id unpopulated: it is HARD-8's, not this phase's", async () => {
    const { writer, rows } = capturingWriter();
    await recordObservation(
      writer,
      { ok: true, amountMinorUnits: 1n, currency: "USD", availability: "" },
      context,
    );
    assert.equal(rows[0].storeId, null);
    assert.equal(rows[0].listingId, context.listingId);
  });
});

describe("the write path refuses a row the schema should never hold", () => {
  it("refuses a store id, because no store-scoped source exists yet", async () => {
    const { writer } = capturingWriter();
    await assert.rejects(
      recordObservation(
        writer,
        { ok: true, amountMinorUnits: 1n, currency: "USD", availability: "" },
        { ...context, storeId: "store-1234" },
      ),
      InvalidObservationError,
    );
  });

  it("refuses an empty listing id", async () => {
    const { writer } = capturingWriter();
    await assert.rejects(
      recordObservation(
        writer,
        { ok: true, amountMinorUnits: 1n, currency: "USD", availability: "" },
        { ...context, listingId: "  " },
      ),
      InvalidObservationError,
    );
  });

  it("refuses a missing source time zone", async () => {
    const { writer } = capturingWriter();
    await assert.rejects(
      recordObservation(
        writer,
        { ok: true, amountMinorUnits: 1n, currency: "USD", availability: "" },
        { ...context, sourceTimeZone: "" },
      ),
      InvalidObservationError,
    );
  });
});

describe("the raw-context column stays inside its bound", () => {
  it("passes short context through untouched", () => {
    assert.equal(boundRawContext("<offer/>"), "<offer/>");
  });

  it("truncates long context and says where it stopped", () => {
    const long = "x".repeat(RAW_CONTEXT_MAX_CHARS + 500);
    const bounded = boundRawContext(long);
    assert.equal(bounded.length, RAW_CONTEXT_MAX_CHARS);
    assert.match(bounded, /truncated at 8192 characters/);
  });
});
