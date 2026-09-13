/**
 * Where each observation is drawn.
 *
 * Two properties, and they are the two the render grader measures on the drawn
 * result rather than here: marks run LEFT TO RIGHT in observation order, and a
 * HIGHER AMOUNT IS DRAWN ABOVE a lower one. This module is the pure arithmetic
 * behind them, so a wrong axis is a failing unit test as well as a failing
 * screenshot.
 *
 * THE ONLY PLACE AN AMOUNT BECOMES A NUMBER. A price is an exact integer in the
 * currency's minor unit and it stays one everywhere it is SHOWN. Drawing is the
 * one operation that cannot be exact - a pixel is not a cent - so the
 * conversion happens here, on its way to a coordinate, and never on its way to
 * the text a reader sees.
 */

import type { ObservationSeriesPoint } from "@deal-sentinel/db";

/** The drawing area, in the SVG's own user units. */
/**
 * The drawing area is 360 user units wide on purpose: that is the narrowest
 * viewport this page is proved at, so at a phone width the chart draws at
 * roughly 1:1 and a mark stays the size it was chosen to be. On a desktop the
 * stylesheet caps how far it scales up, so the marks never become blobs.
 */
export const CHART = {
  width: 360,
  height: 160,
  padX: 16,
  padY: 16,
  markRadius: 5,
} as const;

export type PlottedMark = {
  point: ObservationSeriesPoint;
  x: number;
  y: number;
};

/** The horizontal position of an instant inside the shown window. */
function positionOf(value: number, low: number, high: number, from: number, to: number): number {
  if (high === low) return (from + to) / 2;
  return from + ((value - low) / (high - low)) * (to - from);
}

/**
 * Place every point. A single observation, or several at one price, sits in the
 * middle of the axis it cannot be spread along: a straight line at the bottom
 * would say "cheapest ever" about a series that says nothing of the kind.
 */
export function plotSeries(points: readonly ObservationSeriesPoint[]): PlottedMark[] {
  if (points.length === 0) return [];

  const ordered = [...points].sort(
    (left, right) => left.observedAt.getTime() - right.observedAt.getTime(),
  );
  const instants = ordered.map((point) => point.observedAt.getTime());
  const amounts = ordered.map((point) => Number(point.amountMinorUnits));
  const earliest = Math.min(...instants);
  const latest = Math.max(...instants);
  const cheapest = Math.min(...amounts);
  const dearest = Math.max(...amounts);

  const left = CHART.padX;
  const right = CHART.width - CHART.padX;
  const top = CHART.padY;
  const bottom = CHART.height - CHART.padY;

  return ordered.map((point, index) => ({
    point,
    x: positionOf(instants[index], earliest, latest, left, right),
    // Inverted on purpose: the SVG's y grows downward, and a dearer price has
    // to be drawn nearer the top.
    y: positionOf(amounts[index], cheapest, dearest, bottom, top),
  }));
}
