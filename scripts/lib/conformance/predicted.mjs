// Turns hookassert's own predictions into the flat shape compare.mjs diffs
// against a recorded transcript.
//
// Two sources feed this shape: `spec.matcherTable` itself -- the codified
// prediction `tests/matcher.test.ts` already proves the real matcher engine
// implements faithfully -- and a live `explain --format json` report from
// the built CLI, which is what `scripts/conformance.mjs`'s own real run
// consults. Neither this module nor compare.mjs cares which one produced a
// given case.

import { readKey } from "../json.mjs";

/** Thrown when an `explain --format json` report does not carry a `firing` array. */
export class ReportShapeError extends Error {
  /**
   * @param {string} reason - What was missing or malformed, and where.
   */
  constructor(reason) {
    super(`ERR_CONFORMANCE_REPORT_SHAPE: ${reason}`);
    this.name = "ReportShapeError";
    /** @readonly */
    this.code = "ERR_CONFORMANCE_REPORT_SHAPE";
  }
}

/**
 * @typedef {object} FiringCase
 * @property {string} event - The hook event, e.g. "PreToolUse".
 * @property {string} matcher - The matcher pattern under test.
 * @property {string} tool - The tool name (or other matcher target) checked
 * against `matcher`.
 * @property {boolean} fired - Whether a hook with this matcher fired for
 * this tool.
 */

/**
 * @typedef {object} MatcherTableRowLike
 * @property {string} event
 * @property {string} matcher
 * @property {readonly string[]} matches
 * @property {readonly string[]} doesNotMatch
 */

/**
 * Expand every `spec.matcherTable` row into one {@link FiringCase} per tool
 * it names -- `matches` become `fired: true`, `doesNotMatch` become
 * `fired: false`.
 *
 * @param {readonly MatcherTableRowLike[]} matcherTable - `spec.matcherTable`,
 * read directly from the spec JSON file (never through `loadSpecFile`, which
 * lives under `src/internal/spec/` and is off limits to `scripts/**`).
 * @returns {FiringCase[]} One case per `(event, matcher, tool)` the table names.
 */
export function predictedCasesFromMatcherTable(matcherTable) {
  return matcherTable.flatMap((row) => [
    ...row.matches.map((tool) => ({
      event: row.event,
      matcher: row.matcher,
      tool,
      fired: true,
    })),
    ...row.doesNotMatch.map((tool) => ({
      event: row.event,
      matcher: row.matcher,
      tool,
      fired: false,
    })),
  ]);
}

/**
 * Read whether a hook declaring the given matcher appears in an `explain
 * --format json` report's firing set.
 *
 * @param {unknown} explainReport - Parsed JSON from
 * `node dist/cli.js explain <event> <tool> --format json`
 * (`JsonExplainReport` in `src/internal/report/json.ts`, read here only as
 * plain data -- this module never imports that type).
 * @param {string} matcher - The matcher pattern the case under test declares.
 * @returns {boolean} True when a firing hook's `matcher` equals `matcher`.
 * @throws {ReportShapeError} `ERR_CONFORMANCE_REPORT_SHAPE` when
 * `explainReport` carries no `firing` array at all -- a shape hookassert's
 * own schema guarantees, so seeing this means the built CLI or its
 * `--format json` output changed underneath this harness.
 */
export function firedInExplainReport(explainReport, matcher) {
  const firing = readKey(explainReport, "firing");
  if (!Array.isArray(firing)) {
    throw new ReportShapeError(
      "explain --format json report has no `firing` array.\n" +
        "Expected: JsonExplainReport (schema/explain-report.schema.json).\n" +
        "Next: run `node dist/cli.js explain <event> <tool> --format json` directly and compare its shape.",
    );
  }
  return firing.some((hook) => readKey(hook, "matcher") === matcher);
}
