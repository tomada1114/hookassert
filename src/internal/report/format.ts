/**
 * The one place a `--format` value turns into an actual rendering.
 *
 * @remarks
 * Static layer: pure — no I/O, no process, no write. `explain` calls
 * {@link renderInFormat} today; `lint` and `test` route through it unchanged
 * once they exist, each supplying its own {@link FormatRenderers} for its own
 * result shape, so the three subcommands can never drift on which formats
 * exist or silently reimplement the same `switch` three times.
 */

import { UsageError } from "../errors.js";

/** The report formats `--format` accepts, shared by every subcommand that renders a report. */
export type ReportFormat = "pretty" | "json" | "github";

const REPORT_FORMATS: readonly ReportFormat[] = ["pretty", "json", "github"];

/** Whether `value` is one of {@link ReportFormat}'s members. */
export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * One renderer per {@link ReportFormat}, all rendering the same report shape
 * `T` — `ExplainReport` for `explain` today, whatever `lint`/`test` produce
 * once they exist.
 */
export interface FormatRenderers<T> {
  readonly pretty: (report: T) => string;
  readonly json: (report: T) => string;
  readonly github: (report: T) => string;
}

/**
 * Render `report` in the format `--format` named, defaulting to `"pretty"`
 * when `format` is `undefined`.
 *
 * @throws {UsageError} `format` is given but is not one of `"pretty" | "json"
 * | "github"`.
 */
export function renderInFormat<T>(
  report: T,
  format: string | undefined,
  renderers: FormatRenderers<T>,
): string {
  const resolved = format ?? "pretty";
  if (!isReportFormat(resolved)) {
    throw new UsageError(
      `unrecognized --format ${JSON.stringify(resolved)}. ` +
        `Expected one of: ${REPORT_FORMATS.join(", ")}.`,
    );
  }
  switch (resolved) {
    case "pretty":
      return renderers.pretty(report);
    case "json":
      return renderers.json(report);
    case "github":
      return renderers.github(report);
  }
}
