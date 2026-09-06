/**
 * The refusals this package makes.
 *
 * Same rule as `governor`, `sources`, `alerts` and `db`: a process that cannot
 * read a complete configuration does not start, and the refusal names the
 * setting. There is no default to start on, which is the point - CLAUDE.md rule
 * 8 forbids inventing a number and then treating it as decided, and a default
 * buried in code is exactly that with the decision hidden.
 */

/** The dashboard configuration is absent, unparseable, or short of a value. */
export class DashboardConfigError extends Error {
  /** The setting that is wrong or missing, where one can be named. */
  readonly setting: string | null;

  constructor(detail: string, options: { setting?: string | null } = {}) {
    super(detail);
    this.name = "DashboardConfigError";
    this.setting = options.setting ?? null;
  }
}
