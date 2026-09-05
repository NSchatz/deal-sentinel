/**
 * An in-memory allowance store.
 *
 * Correct for a single process that never restarts, which is to say: correct
 * for tests of everything except the restart itself. Anything that has to
 * survive a crash inside an allowance period uses the durable store in
 * `allowance-store-postgres.ts`; this one is here so a unit test does not need
 * a container to assert the warn, the stop and the period roll.
 *
 * ATOMICITY, which the port requires of every implementation: every method below
 * runs to completion inside one job, with no `await` between reading a record
 * and writing it. JavaScript runs one job at a time, so no other request can be
 * interleaved there and `reserve` adds and tests indivisibly - the same
 * guarantee the PostgreSQL store buys with a single statement. An `await` added
 * inside one of these bodies would silently remove it.
 */

import type { AllowanceRecord, AllowanceStore } from "./allowance.ts";

/**
 * The separator between the two halves of a map key.
 *
 * Code point zero, because it cannot occur in a source id or in a decimal
 * timestamp, so no two different pairs can spell the same key. Built with
 * `String.fromCharCode` rather than typed as a raw byte: a raw NUL in the
 * source makes git call this whole file binary, and a source file that shows as
 * `Bin 0 -> 1716 bytes` in every diff is a source file nobody at a review gate
 * can read.
 */
const KEY_SEPARATOR = String.fromCharCode(0);

export function createMemoryAllowanceStore(): AllowanceStore {
  const records = new Map<string, AllowanceRecord>();

  const key = (sourceId: string, periodStart: Date): string =>
    `${sourceId}${KEY_SEPARATOR}${periodStart.getTime()}`;

  const at = (sourceId: string, periodStart: Date): AllowanceRecord => {
    const id = key(sourceId, periodStart);
    let record = records.get(id);
    if (record === undefined) {
      record = { consumed: 0, warnedAt: null, stoppedAt: null };
      records.set(id, record);
    }
    return record;
  };

  return {
    async read(sourceId, periodStart) {
      return { ...at(sourceId, periodStart) };
    },
    async reserve(sourceId, periodStart, amount, limit) {
      const record = at(sourceId, periodStart);
      if (record.consumed + amount > limit) {
        return { granted: false, consumed: record.consumed };
      }
      record.consumed += amount;
      return { granted: true, consumed: record.consumed };
    },
    async release(sourceId, periodStart, amount) {
      const record = at(sourceId, periodStart);
      // Never below zero, matching the durable store's check constraint. A
      // release with no reservation behind it is a caller bug, and clamping
      // keeps it from becoming an allowance larger than the configured one.
      record.consumed = Math.max(0, record.consumed - amount);
    },
    async markWarned(sourceId, periodStart, when) {
      const record = at(sourceId, periodStart);
      if (record.warnedAt !== null) return false;
      record.warnedAt = when;
      return true;
    },
    async markStopped(sourceId, periodStart, when) {
      const record = at(sourceId, periodStart);
      if (record.stoppedAt !== null) return false;
      record.stoppedAt = when;
      return true;
    },
  };
}
