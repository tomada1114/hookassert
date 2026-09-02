/**
 * The one place a `--format` value turns into an actual rendering.
 *
 * @remarks
 * Static layer: pure — no I/O, no process, no write. `explain`, `lint`, and
 * `test` each call {@link renderInFormat}, supplying their own
 * {@link FormatRenderers} for their own result shape, so the three
 * subcommands can never drift on which formats exist or silently reimplement
 * the same `switch` three times.
 *
 * Each of those three shapes' own `reportVersion` (`JsonExplainReport` in
 * `report/json.ts`, `JsonTestReport` in `report/testReport.ts`,
 * `JsonLintReport` in `report/lintReport.ts`) is versioned independently, and
 * so is its own shipped schema — `schema/explain-report.schema.json`,
 * `schema/test-report.schema.json`, and `schema/lint-report.schema.json`,
 * respectively. This is the one place that rule is written down: bump a
 * shape's `reportVersion` and update its schema in the same change. Each
 * shape's own module points back at this remark rather than restating it.
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
 * `T` — `ExplainReport` for `explain`, `TestReport` for `test`, `LintReport`
 * for `lint`.
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
