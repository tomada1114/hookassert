/**
 * The shared data shape every report format renders, and how it is built from
 * a `matchHooks` result.
 *
 * @remarks
 * Static layer: pure — no I/O, no process, no write. Only `pretty.ts` renders
 * this shape today; `json.ts` and `github.ts` are the `reporters` issue's
 * work, and both will build on the same `ExplainReport`.
 */

import type { EventName, ResolvedHook } from "../../types.js";
import type { MatcherOutcome, VersionContext } from "../matcher/index.js";

/**
 * The information every reporter format prints first, regardless of what
 * `explain` found.
 *
 * @remarks
 * `notices` is always empty in this issue: the incompleteness notices a
 * header can carry (`UnknownReason`'s `"plugin-hooks-present"` and
 * `"managed-settings-assumed"` kinds, from `src/types.ts`) are populated from
 * a live `Decision`, and `explain` has none to draw from yet — see
 * `buildReportHeader`'s own remark for where that becomes available.
 */
export interface ReportHeader {
  /** The detected Claude Code version, formatted `major.minor.patch`, or the literal string `"undetermined"`. */
  readonly claudeVersion: string;

  /** The loaded spec's own `claudeCodeRange`. */
  readonly specRange: string;

  /** Incompleteness notices a reporter should surface, in no particular order. */
  readonly notices: readonly string[];
}

/** The full result `explain <event> [tool]` renders. */
export interface ExplainReport {
  /** Printed first by every reporter format. */
  readonly header: ReportHeader;

  /** The event `explain` was asked about. */
  readonly event: EventName;

  /** The matcher target `explain` was asked about, or `undefined` when none was given. */
  readonly target: string | undefined;

  /** Hooks that fire, in firing order. */
  readonly firing: readonly ResolvedHook[];

  /**
   * The subset of {@link ExplainReport.firing} whose declared matcher was
   * ignored rather than evaluated, per `MatchResult.matcherIgnored`.
   */
  readonly matcherIgnored: readonly ResolvedHook[];

  /** Every hook that did not fire, with its `MatcherOutcome` reason. */
  readonly rejected: readonly MatcherOutcome[];
}

/** Format a detected Claude Code version the way every reporter prints it. */
export function formatClaudeVersion(version: VersionContext): string {
  if (version.kind === "undetermined") {
    return "undetermined";
  }
  const { major, minor, patch } = version.version;
  return `${String(major)}.${String(minor)}.${String(patch)}`;
}

/**
 * Build the header every reporter format prints, from what `explain` and
 * `lint` actually have available in this issue.
 *
 * @remarks
 * `notices` is hardcoded empty here rather than sourced from a `Decision`:
 * this issue's `explain` never has one (it only ever runs `matchHooks`, not
 * the decision resolver), so there is nothing yet to read a
 * `"plugin-hooks-present"` or `"managed-settings-assumed"` `UnknownReason`
 * from. A later issue that threads a live `Decision` through `explain` (or a
 * command that does) is what populates this list for real.
 */
export function buildReportHeader(
  version: VersionContext,
  specRange: string,
): ReportHeader {
  return {
    claudeVersion: formatClaudeVersion(version),
    specRange,
    notices: [],
  };
}
