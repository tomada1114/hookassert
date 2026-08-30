/**
 * The result shape `test` renders, and its `pretty`/`json`/`github`
 * renderers.
 *
 * @remarks
 * Static layer: pure string formatting — no I/O, no process, no write.
 * Mirrors `summary.ts`'s `ExplainReport`/`pretty.ts`/`json.ts`/`github.ts`
 * split for `explain`, but for `CaseResult[]`/`Summary` (`src/internal/assert/`)
 * rather than a `MatchResult`. `src/cli.ts`'s `runTest` is this module's only
 * caller: it builds one {@link TestReport} from every fixture file's cases and
 * routes it through the same `renderInFormat` helper `explain` already uses,
 * rather than a second `--format` switch.
 */

import type {
  CaseResult,
  EventName,
  ExpectationDiff,
  NonFiringExplanation,
  Summary,
  UnknownReason,
} from "../../types.js";
import { renderGithubFinding, renderGithubHeader } from "./github.js";
import type { ReportHeader } from "./summary.js";

/** One fixture case's result, identified by which file and position it came from. */
export interface TestCaseReport {
  /** Absolute path of the fixture file this case was declared in. */
  readonly file: string;

  /** 0-based position of this case within {@link TestCaseReport.file}'s `cases` array. */
  readonly index: number;

  /** The event this case declared. */
  readonly event: EventName;

  /** The matcher target this case declared, or `undefined` when it declared none. */
  readonly tool: string | undefined;

  /** What `assertCase` produced for this case. */
  readonly result: CaseResult;
}

/** The full result `test <fixture>...` renders. */
export interface TestReport {
  /** Printed first by every reporter format. */
  readonly header: ReportHeader;

  /** Every case run, across every fixture file given, in the order they were declared. */
  readonly cases: readonly TestCaseReport[];

  /** The fold of every {@link TestReport.cases}' `result` into the counts every reporter prints. */
  readonly summary: Summary;
}

/** One line naming the case a reporter is about to describe. */
function caseLabel(report: TestCaseReport): string {
  const target =
    report.tool === undefined ? report.event : `${report.event} ${report.tool}`;
  return `${report.file}#${String(report.index)} (${target})`;
}

function describeUnknownReason(reason: UnknownReason): string {
  switch (reason.kind) {
    case "version-out-of-spec-range":
      return `the detected Claude Code version ${reason.detected} falls outside the loaded spec's range ${reason.specRange}`;
    case "version-undetermined":
      return `no Claude Code version could be determined (tried: ${reason.triedSources.join(", ")})`;
    case "payload-shape-unverified":
      return `${reason.event}'s payload shape has never been confirmed against a live Claude Code instance (spec ${reason.specVersion})`;
    case "plugin-hooks-present":
      return `unread plugin hook files: ${reason.files.join(", ")}`;
    case "managed-settings-assumed":
      return `a managed settings file was assumed present without being able to confirm it: ${reason.path}`;
    case "event-not-in-spec":
      return `${reason.event} has no entry in the loaded spec (spec ${reason.specVersion})`;
    case "contradictory-exit-code-effect":
      return `the loaded spec contradicts itself for ${reason.event}'s exit code ${String(reason.exitCode)}`;
  }
}

function describeNonFiring(nonFiring: NonFiringExplanation): string {
  switch (nonFiring.kind) {
    case "matcher-did-not-match":
      return nonFiring.hooks
        .map((rejected) => `${rejected.hook.command} — ${rejected.reason}`)
        .join("; ");
    case "no-hook-configured":
      return `no hook is declared under ${nonFiring.event} in any loaded settings layer`;
    case "excluded-settings-layer":
      return `only declared in a settings layer this fixture's "settings" list did not include: ${nonFiring.hooks
        .map((hook) => hook.command)
        .join(", ")}`;
  }
}

function describeDiff(diff: ExpectationDiff): string {
  switch (diff.field) {
    case "fires":
      return `fires: expected ${String(diff.expectedFires)}, got ${String(diff.actualFires)}`;
    case "decision":
      return `decision: expected "${diff.expectedDecision}", got "${diff.actualDecision}"`;
    case "exitCode":
      return `exitCode: expected ${String(diff.expectedExitCode)}, got ${String(diff.actualExitCode)}`;
    case "stdoutContains":
      return `stdoutContains: expected stdout to contain ${JSON.stringify(diff.expectedSubstring)}, got ${JSON.stringify(diff.actualStdout)}`;
    case "stderrContains":
      return `stderrContains: expected stderr to contain ${JSON.stringify(diff.expectedSubstring)}, got ${JSON.stringify(diff.actualStderr)}`;
    case "timedOut":
      return `timedOut: expected ${String(diff.expectedTimedOut)}, got ${String(diff.actualTimedOut)}`;
  }
}

/** One human-readable line per {@link TestCaseReport}, for `renderTestPretty`. */
function renderCaseLine(report: TestCaseReport): string {
  const label = caseLabel(report);
  const { result } = report;
  switch (result.kind) {
    case "pass":
      return `PASS  ${label}`;
    case "skipped":
      return `SKIP  ${label} (${result.reason})`;
    case "unknown":
      return `UNKNOWN ${label} — ${result.reasons.map(describeUnknownReason).join("; ")}`;
    case "fail": {
      const detail =
        result.nonFiring === undefined
          ? result.diffs.map(describeDiff).join("; ")
          : describeNonFiring(result.nonFiring);
      return `FAIL  ${label} — ${detail}`;
    }
  }
}

/** Render a {@link TestReport} for a terminal. */
export function renderTestPretty(report: TestReport): string {
  const lines: string[] = [];

  lines.push(`Claude Code version: ${report.header.claudeVersion}`);
  lines.push(`Spec range: ${report.header.specRange}`);
  for (const notice of report.header.notices) {
    lines.push(`Notice: ${notice}`);
  }

  lines.push("");
  if (report.cases.length === 0) {
    lines.push("No cases.");
  } else {
    for (const caseReport of report.cases) {
      lines.push(renderCaseLine(caseReport));
    }
  }

  const { summary } = report;
  lines.push("");
  lines.push(
    `asserted ${String(summary.asserted)} (${String(summary.fromRecorded)} from recorded), ` +
      `${String(summary.failed)} failed, ${String(summary.unknown)} unknown, ` +
      `${String(summary.skipped)} skipped`,
  );

  return `${lines.join("\n")}\n`;
}

/** JSON-serializable shape one {@link TestCaseReport} renders to. */
interface JsonTestCaseReport {
  readonly file: string;
  readonly index: number;
  readonly event: EventName;
  readonly tool: string | null;
  readonly result: CaseResult;
}

/** The shape `renderTestJson` emits. */
export interface JsonTestReport {
  readonly reportVersion: "1";
  readonly header: {
    readonly claudeVersion: string;
    readonly specRange: string;
    readonly notices: readonly string[];
  };
  readonly cases: readonly JsonTestCaseReport[];
  readonly summary: Summary;
}

/** Build the JSON-serializable shape {@link renderTestJson} stringifies. */
export function toJsonTestReport(report: TestReport): JsonTestReport {
  return {
    reportVersion: "1",
    header: {
      claudeVersion: report.header.claudeVersion,
      specRange: report.header.specRange,
      notices: report.header.notices,
    },
    cases: report.cases.map((caseReport) => ({
      file: caseReport.file,
      index: caseReport.index,
      event: caseReport.event,
      tool: caseReport.tool ?? null,
      result: caseReport.result,
    })),
    summary: report.summary,
  };
}

/** Render a {@link TestReport} as JSON. */
export function renderTestJson(report: TestReport): string {
  return `${JSON.stringify(toJsonTestReport(report), null, 2)}\n`;
}

/**
 * Render a {@link TestReport} as GitHub Actions workflow commands: the
 * leading header line, then one `::error` per `"fail"` case.
 *
 * @remarks
 * A fixture case carries no line number of its own the way a `ResolvedHook`
 * does through `Provenance` — `fixture/load.ts` never records one — so every
 * annotation points at line 1 of its fixture file, identified instead by the
 * case's own 0-based index and event/target in the annotation's title.
 */
export function renderTestGithub(report: TestReport, workspaceRoot: string): string {
  const lines: string[] = [renderGithubHeader(report.header)];

  for (const caseReport of report.cases) {
    if (caseReport.result.kind !== "fail") {
      continue;
    }
    const detail =
      caseReport.result.nonFiring === undefined
        ? caseReport.result.diffs.map(describeDiff).join("; ")
        : describeNonFiring(caseReport.result.nonFiring);
    lines.push(
      renderGithubFinding(
        {
          file: caseReport.file,
          line: 1,
          title: `test case #${String(caseReport.index)}: ${caseLabel(caseReport)}`,
          message: detail,
        },
        workspaceRoot,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}
