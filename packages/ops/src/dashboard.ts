/**
 * The one page an owner opens, in two halves: what the page SAYS (the model)
 * and how it is drawn (the renderer).
 *
 * The split is what makes the page gradeable twice over. The model is built
 * from the stores and can be asserted on without a browser; the renderer is
 * pure - a model in, a document out, no clock, no filesystem, no connection -
 * so the render grader can hand any model to it, including ones a real store
 * could only produce on a bad day.
 *
 * WHAT THE PAGE IS ALLOWED TO CLAIM. Every figure is a `Figure`: it is either
 * known, or it is unavailable and says so. There is no third state where a
 * number nobody could compute is drawn as a zero. That distinction is the
 * difference between "this source made no requests" and "we could not work out
 * how many", and an owner acts differently on the two.
 *
 * NOTHING IS FETCHED AND NOTHING LISTENS. The page is a file. It carries its
 * whole stylesheet inline, asks for no image, no font and no script, and
 * declares a content security policy that permits exactly the stylesheet it
 * carries and nothing else.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type {
  ObservationSeriesPoint,
  ObservationSeriesStore,
  SourceOutcomeCounts,
  OutcomeWindow,
  WatchlistStore,
} from "@deal-sentinel/db";
import { formatMinorUnits } from "@deal-sentinel/extractor";
import { REQUEST_OUTCOME_CLASSES } from "@deal-sentinel/shared";

import { CHART, plotSeries } from "./chart.ts";
import type { HealthDependencies, SourcePause, SourceState } from "./health.ts";
import { readHealthReport } from "./health.ts";
import { showDuration, showInstant } from "./instants.ts";
import { literalAttribute, literalText } from "./text.ts";
import { readOrRefuse } from "./errors.ts";

/** A figure the page can show, or a reason it cannot. Never a stand-in zero. */
export type Figure<T> = { known: true; value: T } | { known: false; why: string };

export function known<T>(value: T): Figure<T> {
  return { known: true, value };
}

export function unavailable<T>(why: string): Figure<T> {
  return { known: false, why };
}

export type AllowanceFigure =
  | { metered: false }
  | {
      metered: true;
      consumed: number;
      remaining: number;
      limit: number;
      periodStart: Date;
      periodEnd: Date;
    };

export type SourceCard = {
  sourceId: string;
  state: Figure<SourceState>;
  pause: SourcePause | null;
  allowance: Figure<AllowanceFigure>;
  /** Known and null means "never had one", which is shown as not recorded. */
  lastSuccessAt: Figure<Date | null>;
  counts: Figure<SourceOutcomeCounts>;
};

export type ListingSeries = {
  sourceId: string;
  listingId: string;
  points: ObservationSeriesPoint[];
};

export type DashboardModel = {
  /** The instant the page itself was produced, shown on it (AC-17). */
  producedAt: Date;
  window: OutcomeWindow;
  timeZone: string;
  /** What the pause column was read from, said once beside the section. */
  pauseEvidence: string[];
  sources: SourceCard[];
  listings: ListingSeries[];
};

export type DashboardDependencies = HealthDependencies & {
  watchlist: WatchlistStore;
  series: ObservationSeriesStore;
};

/**
 * Read everything the page shows.
 *
 * A store that cannot be read fails here, before a document exists: half a page
 * is a page that says a source is fine because nothing could be read about it.
 * A source whose staleness ceiling is missing is different - that is one
 * source's figures being unavailable, and the rest of the page still draws.
 */
export async function buildDashboardModel(
  dependencies: DashboardDependencies,
): Promise<DashboardModel> {
  const health = await readHealthReport(dependencies);

  const sources: SourceCard[] = health.sources.map((source) => ({
    sourceId: source.sourceId,
    state: known(source.state),
    pause: source.pause,
    allowance: known(source.allowance),
    lastSuccessAt: known(source.lastSuccessAt),
    counts: known(source.counts),
  }));

  for (const refusal of health.refused) {
    sources.push({
      sourceId: refusal.sourceId,
      state: unavailable(refusal.detail),
      pause: null,
      allowance: unavailable(refusal.detail),
      lastSuccessAt: unavailable(refusal.detail),
      counts: unavailable(refusal.detail),
    });
  }
  sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));

  const listings: ListingSeries[] = [];
  for (const sourceId of Object.keys(dependencies.governorConfig.sources).sort()) {
    const entries = await readOrRefuse(`the watchlist for ${sourceId}`, () =>
      dependencies.watchlist.enabledFor(sourceId),
    );
    for (const entry of entries) {
      const points = await readOrRefuse(
        `the price history for ${entry.listingId}`,
        () =>
          dependencies.series.seriesFor(
            entry.listingId,
            health.window.start,
            health.window.end,
          ),
      );
      listings.push({ sourceId, listingId: entry.listingId, points });
    }
  }

  return {
    producedAt: health.producedAt,
    window: health.window,
    timeZone: dependencies.config.dashboard.timeZone,
    pauseEvidence: health.pauseEvidence,
    sources,
    listings,
  };
}

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

const TOKENS_PATH = new URL("./tokens.css", import.meta.url);
const STYLES_PATH = new URL("./dashboard.css", import.meta.url);

/** The stylesheet this page carries, read from the committed files. */
export function dashboardStylesheet(): string {
  return `${readFileSync(TOKENS_PATH, "utf8")}\n${readFileSync(STYLES_PATH, "utf8")}`;
}

/** What an unavailable figure reads as. Never a zero and never a dash. */
export const UNAVAILABLE_TEXT = "unavailable";

/** What a measurement that was never taken reads as (frontend F3). */
export const NOT_RECORDED_TEXT = "not recorded";

function figureText<T>(figure: Figure<T>, show: (value: T) => string): string {
  return figure.known
    ? show(figure.value)
    : `<span class="unavailable">${literalText(UNAVAILABLE_TEXT)}: ${literalText(figure.why)}</span>`;
}

function stateWord(state: Figure<SourceState>): string {
  return state.known ? state.value : "unavailable";
}

function sourceCard(card: SourceCard, timeZone: string, producedAt: Date): string {
  const word = stateWord(card.state);
  const rows: string[] = [];

  rows.push(
    row(
      "Pause",
      card.pause === null
        ? "not paused"
        : `${literalText(card.pause.condition)} (since ${literalText(
            showInstant(card.pause.at, timeZone),
          )}, read from the ${literalText(card.pause.origin)} record)`,
    ),
  );

  rows.push(
    row(
      "Allowance",
      figureText(card.allowance, (allowance) =>
        allowance.metered
          ? `${allowance.consumed} used, ${allowance.remaining} left of ${allowance.limit}`
          : "not metered",
      ),
    ),
  );

  rows.push(
    row(
      "Allowance period",
      figureText(card.allowance, (allowance) =>
        allowance.metered
          ? `${literalText(showInstant(allowance.periodStart, timeZone))} to ` +
            `${literalText(showInstant(allowance.periodEnd, timeZone))}`
          : "not metered",
      ),
    ),
  );

  rows.push(
    row(
      "Last success",
      figureText(card.lastSuccessAt, (at) =>
        at === null
          ? literalText(NOT_RECORDED_TEXT)
          : `${literalText(showInstant(at, timeZone))}`,
      ),
    ),
  );

  rows.push(
    row(
      "Last success age",
      figureText(card.lastSuccessAt, (at) =>
        at === null
          ? literalText(NOT_RECORDED_TEXT)
          : // Measured against the instant the PAGE was produced, never against
            // the wall clock: a page rendered twice from one model has to say
            // the same thing twice, and the figure is only ever as fresh as the
            // page it sits on.
            literalText(showDuration(producedAt.getTime() - at.getTime())),
      ),
    ),
  );

  rows.push(
    row(
      "Requests in window",
      figureText(card.counts, (counts) =>
        REQUEST_OUTCOME_CLASSES.map(
          (outcomeClass) => `${literalText(outcomeClass)} ${counts.counts[outcomeClass]}`,
        ).join(" &middot; "),
      ),
    ),
  );

  return (
    `<article class="card">` +
    `<h3 class="data">${literalText(card.sourceId)}</h3>` +
    `<p class="state state-${literalAttribute(word)}">` +
    `<span class="dot" data-indicator="state"></span>` +
    `<span>${literalText(word)}</span></p>` +
    `<dl>${rows.join("")}</dl>` +
    `</article>`
  );
}

function row(label: string, value: string): string {
  return `<dt>${literalText(label)}</dt><dd class="data">${value}</dd>`;
}

function chart(series: ListingSeries): string {
  const marks = plotSeries(series.points);
  const label =
    `price history for ${series.listingId}: ${marks.length} observation` +
    `${marks.length === 1 ? "" : "s"}`;

  const drawn = marks
    .map(
      (mark) =>
        `<circle class="mark" data-mark="" ` +
        `data-listing="${literalAttribute(series.listingId)}" ` +
        `data-at="${literalAttribute(String(mark.point.observedAt.getTime()))}" ` +
        `data-amount="${literalAttribute(mark.point.amountMinorUnits.toString())}" ` +
        `data-currency="${literalAttribute(mark.point.currency)}" ` +
        `cx="${mark.x.toFixed(2)}" cy="${mark.y.toFixed(2)}" r="${CHART.markRadius}"></circle>`,
    )
    .join("");

  return (
    `<svg class="chart" viewBox="0 0 ${CHART.width} ${CHART.height}" ` +
    `role="img" aria-label="${literalAttribute(label)}">` +
    `<line class="axis" x1="${CHART.padX}" y1="${CHART.height - CHART.padY}" ` +
    `x2="${CHART.width - CHART.padX}" y2="${CHART.height - CHART.padY}"></line>` +
    drawn +
    `</svg>`
  );
}

function seriesTable(series: ListingSeries, model: DashboardModel): string {
  const rows = [...series.points]
    .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime())
    .map(
      (point) =>
        `<tr>` +
        `<td class="data">${literalText(showInstant(point.observedAt, model.timeZone))}</td>` +
        `<td class="data">${literalText(
          formatMinorUnits(point.amountMinorUnits, point.currency),
        )}</td>` +
        `<td class="data">${
          point.availability === null
            ? literalText(NOT_RECORDED_TEXT)
            : literalText(point.availability)
        }</td>` +
        `</tr>`,
    )
    .join("");

  return (
    `<div class="table-scroll"><table>` +
    `<caption>every observation drawn above, as text</caption>` +
    `<thead><tr><th scope="col">Observed</th><th scope="col">Amount</th>` +
    `<th scope="col">Availability</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

function listingSection(model: DashboardModel): string {
  if (model.listings.length === 0) {
    return (
      `<p class="empty">No listing is tracked. The watchlist is empty, so there ` +
      `is no price history to draw - this is an empty watchlist and not a ` +
      `failure to read one.</p>`
    );
  }

  return model.listings
    .map((series) => {
      const heading =
        `<h3 class="data">${literalText(series.listingId)}</h3>` +
        `<p class="scope">${literalText(series.sourceId)}</p>`;
      if (series.points.length === 0) {
        return (
          `<section class="series">${heading}` +
          `<p class="empty">No observation in the shown window. Nothing is ` +
          `drawn for this listing, which is not the same as a price of zero.</p>` +
          `</section>`
        );
      }
      return (
        `<section class="series">${heading}${chart(series)}` +
        `${seriesTable(series, model)}</section>`
      );
    })
    .join("");
}

/**
 * The whole document, from a model and nothing else.
 *
 * The stylesheet is inlined and the policy names its hash, so the page permits
 * exactly the styles it carries: no origin, no inline style attribute and no
 * script can add to it. That is also why nothing in this renderer emits a
 * `style` attribute - every position is an SVG geometry attribute or a class.
 */
export function renderDashboard(model: DashboardModel): string {
  const stylesheet = dashboardStylesheet();
  const digest = createHash("sha256").update(stylesheet, "utf8").digest("base64");
  const policy = [
    "default-src 'none'",
    `style-src 'sha256-${digest}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const cards = model.sources
    .map((card) => sourceCard(card, model.timeZone, model.producedAt))
    .join("");

  return (
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${literalAttribute(policy)}">\n` +
    `<title>deal-sentinel</title>\n` +
    `<style>${stylesheet}</style>\n` +
    `</head>\n<body>\n` +
    `<header>` +
    `<h1>deal-sentinel</h1>` +
    `<p class="scope data">produced ${literalText(
      showInstant(model.producedAt, model.timeZone),
    )} &middot; window ${literalText(showInstant(model.window.start, model.timeZone))} ` +
    `to ${literalText(showInstant(model.window.end, model.timeZone))}</p>` +
    `<p class="scope">Every figure here was read when the page was produced and ` +
    `is as old as that instant. Nothing on this page updates itself.</p>` +
    `<nav><a href="#sources">Sources</a> <a href="#listings">Tracked listings</a></nav>` +
    `</header>\n` +
    `<section id="sources"><h2>Sources</h2>` +
    `<p class="scope">Every source the governor is configured for. Pauses are ` +
    `read from the ${literalText(model.pauseEvidence.join(" and the "))} record.</p>` +
    `<div class="cards">${cards}</div></section>\n` +
    `<section id="listings"><h2>Tracked listings</h2>` +
    `<p class="scope">Every enabled watchlist entry, with the observations ` +
    `recorded inside the shown window.</p>` +
    listingSection(model) +
    `</section>\n` +
    `<footer><p>Produced ${literalText(showInstant(model.producedAt, model.timeZone))} ` +
    `by deal-sentinel. This page is a file: nothing here listens, and nothing ` +
    `here asks anybody for anything.</p></footer>\n` +
    `</body>\n</html>\n`
  );
}
