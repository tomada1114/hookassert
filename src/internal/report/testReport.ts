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
  Decision,
  DecidingHook,
  EventName,
  ExpectationDiff,
  NonFiringExplanation,
  PayloadOrigin,
  ResolvedHook,
  Summary,
  UnknownReason,
} from "../../types.js";
import {
  relativizeForGithub,
  renderGithubFinding,
  renderGithubHeader,
} from "./github.js";
import { toJsonHook, type JsonHook } from "./json.js";
import type { ReportHeader } from "./summary.js";

/**
 * One hook that fired for a case and whose process never started at all,
 * carried to the reporters so a launch failure is visible even on a hook the
 * verdict's fold did not pick.
 */
export interface LaunchFailure {
  /** The hook that never launched. */
  readonly hook: ResolvedHook;
  /** That hook's own `ExecOutcome.launchError` — the OS-reported reason. */
  readonly launchError: string;
}

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

  /**
   * How many hooks fired for this case.
   *
   * @remarks
   * Not part of `CaseResult` itself — it exists here only so
   * `renderCaseLine` can gate its `— decided by …` annotation on more than
   * one hook having fired, without `CaseResult` carrying a count nothing
   * else needs.
   */
  readonly firedCount: number;

  /**
   * Every hook that fired for this case whose process never started, in
   * firing order — including the deciding hook when its own process is one
   * of them. Empty for a case where nothing fired, and for every stubbed
   * step (`stub` bypasses the spawner, so it can never produce a
   * `launchError`).
   *
   * @remarks
   * Not part of `CaseResult`, for the reason `firedCount` above is not: it
   * takes no part in the verdict — `assertCase` folds every firing hook's
   * `Decision` into one verdict (#42) and a launch failure that loses that
   * fold changes nothing about it — and only a reporter reads it. #39 gave
   * the *deciding* hook's launch error its own home on `DecidingHook`; this
   * is the same fact for every other firing hook, which the report was
   * otherwise dropping entirely (#65).
   */
  readonly launchFailures: readonly LaunchFailure[];
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
    case "context":
      return `context: expected ${jsonOrAbsent(diff.expectedContext)}, got ${jsonOrAbsent(diff.actualContext)}`;
    case "updatedInput":
      return `updatedInput: expected ${jsonOrAbsent(diff.expectedUpdatedInput)}, got ${jsonOrAbsent(diff.actualUpdatedInput)}`;
  }
}

/** `JSON.stringify(value)`, or the literal `"absent"` for `undefined` — `JSON.stringify(undefined)` itself returns `undefined`, not a string. */
function jsonOrAbsent(value: unknown): string {
  return value === undefined ? "absent" : JSON.stringify(value);
}

/** `<command> (<file>:<line>)` for the hook a multi-hook case's verdict came from. */
function describeDecidedBy(decidedBy: DecidingHook): string {
  const { hook } = decidedBy;
  return `${hook.command} (${hook.provenance.file}:${String(hook.provenance.line)})`;
}

/**
 * `hook never launched: <OS message> (command "<command>", <file>:<line>)` —
 * the message every reporter shows for one hook that fired for a case but
 * whose process never started at all. Already names the hook and its
 * declaration site, so callers never also append {@link decidedBySuffix}'s
 * "— decided by …" for the same hook.
 */
function describeLaunchFailure(failure: LaunchFailure): string {
  const { hook, launchError } = failure;
  return `hook never launched: ${launchError} (command "${hook.command}", ${hook.provenance.file}:${String(hook.provenance.line)})`;
}

/** Every {@link TestCaseReport.launchFailures} entry, rendered in firing order. */
function describeLaunchFailures(report: TestCaseReport): string[] {
  return report.launchFailures.map(describeLaunchFailure);
}

/**
 * ` — decided by …` suffix for a `FAIL`/`UNKNOWN` line, shown only when more
 * than one hook fired for the case — naming the hook for a single-hook case
 * would just repeat what the line already says — and suppressed when the
 * deciding hook's own process never started: that hook's launch-failure
 * segment (from {@link describeLaunchFailures}) already names it and its
 * declaration site, so the suffix would only repeat it.
 */
function decidedBySuffix(
  report: TestCaseReport,
  decidedBy: DecidingHook | undefined,
): string {
  if (
    decidedBy === undefined ||
    report.firedCount <= 1 ||
    decidedBy.launchError !== undefined
  ) {
    return "";
  }
  return ` — decided by ${describeDecidedBy(decidedBy)}`;
}

/**
 * The detail text after a `FAIL` line's label, for a case whose combined
 * verdict is a `"fail"`: every fired hook's launch-failure message first
 * (root cause before consequence), then the ordinary diff/non-firing
 * explanation — never one replacing the other.
 */
function describeFailDetail(
  report: TestCaseReport & { readonly result: Extract<CaseResult, { kind: "fail" }> },
): string {
  const { result } = report;
  const detailSegments =
    result.nonFiring === undefined
      ? result.diffs.map(describeDiff)
      : [describeNonFiring(result.nonFiring)];
  return [...describeLaunchFailures(report), ...detailSegments].join("; ");
}

/** One human-readable line per {@link TestCaseReport}, for `renderTestPretty`. */
function renderCaseLine(report: TestCaseReport): string {
  const label = caseLabel(report);
  const { result } = report;
  const launchSegments = describeLaunchFailures(report);
  switch (result.kind) {
    case "pass":
      return launchSegments.length === 0
        ? `PASS  ${label}`
        : `PASS  ${label} — ${launchSegments.join("; ")}`;
    case "skipped":
      return `SKIP  ${label} (${result.reason})`;
    case "unknown": {
      const detail = [
        ...launchSegments,
        ...result.reasons.map(describeUnknownReason),
      ].join("; ");
      return `UNKNOWN ${label} — ${detail}${decidedBySuffix(report, result.decidedBy)}`;
    }
    case "fail": {
      const detail = describeFailDetail({ ...report, result });
      return `FAIL  ${label} — ${detail}${decidedBySuffix(report, result.decidedBy)}`;
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

/**
 * JSON shape of a {@link PayloadOrigin}'s `"recorded"` member, with
 * `claudeVersion` normalized to `null` rather than dropped when the envelope
 * carried none.
 *
 * @remarks
 * `JSON.stringify` omits an object property whose value is `undefined`
 * rather than emitting `null` for it, so a `"recorded"` origin whose envelope
 * carries no `claudeVersion` would silently drop the key from the JSON
 * rather than appearing as the explicit `null` `schema/test-report.schema.json`
 * requires.
 */
type JsonPayloadOrigin =
  | {
      readonly kind: "recorded";
      readonly capturedAt: string;
      readonly sourceFile: string;
      readonly claudeVersion: string | null;
    }
  | {
      readonly kind: "synthetic";
    };

/** Build the {@link JsonPayloadOrigin} for one {@link PayloadOrigin}. */
function toJsonPayloadOrigin(origin: PayloadOrigin): JsonPayloadOrigin {
  if (origin.kind === "synthetic") {
    return origin;
  }
  return {
    kind: "recorded",
    capturedAt: origin.capturedAt,
    sourceFile: origin.sourceFile,
    claudeVersion: origin.claudeVersion ?? null,
  };
}

/**
 * JSON shape of a {@link DecidingHook}, with its own `hook` converted through
 * `json.ts`'s {@link toJsonHook} rather than left as a raw `ResolvedHook` —
 * whose `matcher`/`args`/`timeoutMs` are `T | undefined`, which
 * `JSON.stringify` would drop the same way an un-mapped `nonFiring` would.
 */
interface JsonDecidingHook {
  readonly hook: JsonHook;
  readonly decision: Decision;
  readonly launchError: string | null;
}

/** Build the {@link JsonDecidingHook} for one {@link DecidingHook}. */
function toJsonDecidingHook(decidedBy: DecidingHook): JsonDecidingHook {
  return {
    hook: toJsonHook(decidedBy.hook),
    decision: decidedBy.decision,
    launchError: decidedBy.launchError ?? null,
  };
}

/** `CaseResult`'s `decidedBy`, converted and `undefined` normalized to `null`. */
function toJsonDecidedBy(decidedBy: DecidingHook | undefined): JsonDecidingHook | null {
  return decidedBy === undefined ? null : toJsonDecidingHook(decidedBy);
}

/** JSON shape of a {@link NonFiringExplanation}, with every `ResolvedHook` it carries converted through {@link toJsonHook}. */
type JsonNonFiringExplanation =
  | {
      readonly kind: "matcher-did-not-match";
      readonly hooks: readonly { readonly hook: JsonHook; readonly reason: string }[];
    }
  | {
      readonly kind: "no-hook-configured";
      readonly event: EventName;
    }
  | {
      readonly kind: "excluded-settings-layer";
      readonly hooks: readonly JsonHook[];
    };

/** Build the {@link JsonNonFiringExplanation} for one {@link NonFiringExplanation}. */
function toJsonNonFiringExplanation(
  nonFiring: NonFiringExplanation,
): JsonNonFiringExplanation {
  switch (nonFiring.kind) {
    case "matcher-did-not-match":
      return {
        kind: "matcher-did-not-match",
        hooks: nonFiring.hooks.map((rejected) => ({
          hook: toJsonHook(rejected.hook),
          reason: rejected.reason,
        })),
      };
    case "no-hook-configured":
      return nonFiring;
    case "excluded-settings-layer":
      return {
        kind: "excluded-settings-layer",
        hooks: nonFiring.hooks.map((hook) => toJsonHook(hook)),
      };
  }
}

/**
 * `ExpectationDiff`, with a `"context"`/`"updatedInput"` diff's
 * `actualContext`/`actualUpdatedInput` normalized to `null` when no firing
 * hook emitted the key.
 *
 * @remarks
 * `JSON.stringify` drops an object property whose value is `undefined`
 * outright, rather than emitting `null` for it — the same gap
 * {@link toJsonPayloadOrigin} exists to close for a `"recorded"` origin's
 * `claudeVersion` — which `schema/test-report.schema.json`'s
 * `additionalProperties: false` plus full `required` list would then reject
 * as a missing key. `??` rather than `||`: a hook that legitimately emitted
 * `additionalContext: false` or `""` must stay that value, not become
 * `null`. The other six variants never carry `undefined`, so they pass
 * through unchanged.
 */
function toJsonExpectationDiff(diff: ExpectationDiff): ExpectationDiff {
  switch (diff.field) {
    case "fires":
    case "decision":
    case "exitCode":
    case "stdoutContains":
    case "stderrContains":
    case "timedOut":
      return diff;
    case "context":
      return { ...diff, actualContext: diff.actualContext ?? null };
    case "updatedInput":
      return { ...diff, actualUpdatedInput: diff.actualUpdatedInput ?? null };
  }
}

/**
 * `CaseResult`, mapped field by field to the shape
 * `schema/test-report.schema.json` describes: every value `CaseResult` may
 * leave absent (`decidedBy`, a `"fail"` result's `nonFiring`, a `"recorded"`
 * origin's `claudeVersion`, a `decidedBy`/`nonFiring` hook's own `matcher`/
 * `args`/`timeoutMs`) is written out as an explicit `null` rather than an
 * omitted key, and `additionalProperties: false` plus a full `required` list
 * in the schema is honest about what every rendering actually carries.
 *
 * @remarks
 * Deliberately not a `CaseResult` pass-through (`{ ...result, ... }`): a
 * field added to `CaseResult` later must be considered here and reflected in
 * the schema in the same change, per `renderInFormat`'s remark
 * (`src/internal/report/format.ts`), rather than silently reaching the JSON
 * report — or silently failing to — without anyone noticing.
 */
type JsonCaseResult =
  | {
      readonly kind: "pass";
      readonly origin: JsonPayloadOrigin;
      readonly decidedBy: JsonDecidingHook | null;
    }
  | {
      readonly kind: "fail";
      readonly origin: JsonPayloadOrigin;
      readonly diffs: readonly ExpectationDiff[];
      readonly nonFiring: JsonNonFiringExplanation | null;
      readonly decidedBy: JsonDecidingHook | null;
    }
  | {
      readonly kind: "unknown";
      readonly origin: JsonPayloadOrigin;
      readonly reasons: readonly [UnknownReason, ...UnknownReason[]];
      readonly decidedBy: JsonDecidingHook | null;
    }
  | {
      readonly kind: "skipped";
      readonly origin: JsonPayloadOrigin;
      readonly reason: "dry-run" | "stub-only";
    };

/** Build the {@link JsonCaseResult} `renderTestJson` emits for one `CaseResult`. */
function toJsonCaseResult(result: CaseResult): JsonCaseResult {
  const origin = toJsonPayloadOrigin(result.origin);
  switch (result.kind) {
    case "pass":
      return { kind: "pass", origin, decidedBy: toJsonDecidedBy(result.decidedBy) };
    case "fail":
      return {
        kind: "fail",
        origin,
        diffs: result.diffs.map(toJsonExpectationDiff),
        nonFiring:
          result.nonFiring === undefined
            ? null
            : toJsonNonFiringExplanation(result.nonFiring),
        decidedBy: toJsonDecidedBy(result.decidedBy),
      };
    case "unknown":
      return {
        kind: "unknown",
        origin,
        reasons: result.reasons,
        decidedBy: toJsonDecidedBy(result.decidedBy),
      };
    case "skipped":
      return { kind: "skipped", origin, reason: result.reason };
  }
}

/**
 * JSON shape of a {@link LaunchFailure}, with its own `hook` converted
 * through `json.ts`'s {@link toJsonHook} for the same reason
 * {@link JsonDecidingHook} is: a raw `ResolvedHook`'s `matcher`/`args`/
 * `timeoutMs` are `T | undefined`, which `JSON.stringify` would drop.
 */
interface JsonLaunchFailure {
  readonly hook: JsonHook;
  readonly launchError: string;
}

/** Build the {@link JsonLaunchFailure} for one {@link LaunchFailure}. */
function toJsonLaunchFailure(failure: LaunchFailure): JsonLaunchFailure {
  return { hook: toJsonHook(failure.hook), launchError: failure.launchError };
}

/** JSON-serializable shape one {@link TestCaseReport} renders to. */
interface JsonTestCaseReport {
  readonly file: string;
  readonly index: number;
  readonly event: EventName;
  readonly tool: string | null;
  readonly result: JsonCaseResult;
  readonly launchFailures: readonly JsonLaunchFailure[];
}

/**
 * The shape `renderTestJson` emits, validated by `schema/test-report.schema.json`.
 *
 * @remarks
 * `reportVersion` is versioned independently of `explain`'s own
 * `JsonExplainReport` (`report/json.ts`) and `lint`'s own `JsonLintReport`
 * (`lintReport.ts`) — all three currently claim `reportVersion: "1"` for
 * their own, different shapes; see `renderInFormat`'s remark
 * (`src/internal/report/format.ts`) for the rule that keeps each shape's
 * schema in lockstep with it. `reportType` disambiguates the three:
 * `schema/explain-report.schema.json` pins its `reportType` to `"explain"`
 * and would reject this shape, and vice versa.
 */
export interface JsonTestReport {
  readonly reportVersion: "1";
  readonly reportType: "test";
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
    reportType: "test",
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
      result: toJsonCaseResult(caseReport.result),
      launchFailures: caseReport.launchFailures.map(toJsonLaunchFailure),
    })),
    summary: report.summary,
  };
}

/** Render a {@link TestReport} as JSON. */
export function renderTestJson(report: TestReport): string {
  return `${JSON.stringify(toJsonTestReport(report), null, 2)}\n`;
}

/**
 * Whether `file` resolves to a path inside `workspaceRoot` — the only place a
 * GitHub Actions annotation can attach, since `file=` is resolved relative to
 * the checkout root and an absolute path outside it matches no line in the
 * diff view.
 */
function attachesInWorkspace(file: string, workspaceRoot: string): boolean {
  const relative = relativizeForGithub(file, workspaceRoot);
  return !relative.startsWith("/") && !/^[A-Za-z]:\//.test(relative);
}

/** What {@link caseAnnotation} decided about one case's `github` annotation. */
interface CaseAnnotation {
  readonly level: "error" | "warning";
  readonly location: { readonly file: string; readonly line: number };
  readonly message: string;
}

/**
 * The `{ file, line }` a launch-failure-driven annotation points at: the
 * failing hook's own `Provenance` when it resolves inside the workspace,
 * otherwise line 1 of the fixture file — the same fallback the `"fail"`
 * branch below uses, for the reason given in this function's own remarks.
 */
function launchFailureLocation(
  failure: LaunchFailure,
  caseReport: TestCaseReport,
  workspaceRoot: string,
): { readonly file: string; readonly line: number } {
  const attachable = attachesInWorkspace(failure.hook.provenance.file, workspaceRoot);
  return attachable
    ? { file: failure.hook.provenance.file, line: failure.hook.provenance.line }
    : { file: caseReport.file, line: 1 };
}

/**
 * Decide the `github` annotation for one {@link TestCaseReport}, or
 * `undefined` for a case that gets no annotation at all: an `::error` for a
 * `"fail"` verdict; an `::warning` for an `"unknown"` verdict that carries a
 * launch failure, stating both why the case is `"unknown"` and which hook
 * never launched (an `"unknown"` case without a launch failure gets none,
 * matching how `"unknown"` was reported before this function existed);
 * an `::warning` for a `"pass"` case that still carries a launch failure
 * (some other firing hook's own `Decision` outranked the launch-failed one,
 * so `assertCase`'s fold never saw it); otherwise none. `::error` is
 * deliberately never used for a `"pass"`/`"unknown"` case: neither verdict is
 * itself a failed assertion, and a red annotation would report a failure the
 * verdict did not reach.
 *
 * @remarks
 * A fixture case carries no line number of its own the way a `ResolvedHook`
 * does through `Provenance` — `fixture/load.ts` never records one — so every
 * annotation points at line 1 of its fixture file, identified instead by the
 * case's own 0-based index and event/target in the annotation's title,
 * *unless* the annotation names a hook — the `"fail"` branch's `decidedBy`,
 * or the `"unknown"`/`"pass"` branches' first
 * {@link TestCaseReport.launchFailures} entry — in which case the annotation
 * points at that hook's own `Provenance` instead, the more actionable
 * location. A hook declared outside the workspace (the user layer's
 * `~/.claude/settings.json`, or the enterprise layer's) is the exception: an
 * annotation whose `file=` is not inside `GITHUB_WORKSPACE` silently attaches
 * to nothing, so the annotation stays on the fixture — which is inside the
 * checkout.
 */
function caseAnnotation(
  caseReport: TestCaseReport,
  workspaceRoot: string,
): CaseAnnotation | undefined {
  const { result } = caseReport;
  if (result.kind === "fail") {
    const detail = describeFailDetail({ ...caseReport, result });
    const { decidedBy } = result;
    const attachable =
      decidedBy !== undefined &&
      attachesInWorkspace(decidedBy.hook.provenance.file, workspaceRoot);
    const location = attachable
      ? { file: decidedBy.hook.provenance.file, line: decidedBy.hook.provenance.line }
      : { file: caseReport.file, line: 1 };
    // Never appends "— decided by …" when the deciding hook never launched:
    // `detail` already names it and its declaration site (see
    // `describeLaunchFailure`), so the annotation would otherwise repeat
    // itself.
    const message =
      decidedBy === undefined || attachable || decidedBy.launchError !== undefined
        ? detail
        : `${detail} — decided by ${describeDecidedBy(decidedBy)}`;
    return { level: "error", location, message };
  }

  if (result.kind === "unknown") {
    const [firstLaunchFailure] = caseReport.launchFailures;
    if (firstLaunchFailure === undefined) {
      return undefined;
    }
    const message = [
      ...describeLaunchFailures(caseReport),
      ...result.reasons.map(describeUnknownReason),
    ].join("; ");
    return {
      level: "warning",
      location: launchFailureLocation(firstLaunchFailure, caseReport, workspaceRoot),
      message,
    };
  }

  if (result.kind !== "pass") {
    return undefined;
  }
  const [firstLaunchFailure] = caseReport.launchFailures;
  if (firstLaunchFailure === undefined) {
    return undefined;
  }
  return {
    level: "warning",
    location: launchFailureLocation(firstLaunchFailure, caseReport, workspaceRoot),
    message: describeLaunchFailures(caseReport).join("; "),
  };
}

/**
 * Render a {@link TestReport} as GitHub Actions workflow commands: the
 * leading header line, then one annotation per case {@link caseAnnotation}
 * decides needs one — see that function for which verdicts get one and at
 * what level.
 */
export function renderTestGithub(report: TestReport, workspaceRoot: string): string {
  const lines: string[] = [renderGithubHeader(report.header)];

  for (const caseReport of report.cases) {
    const annotation = caseAnnotation(caseReport, workspaceRoot);
    if (annotation === undefined) {
      continue;
    }
    lines.push(
      renderGithubFinding(
        {
          file: annotation.location.file,
          line: annotation.location.line,
          title: `test case #${String(caseReport.index)}: ${caseLabel(caseReport)}`,
          message: annotation.message,
          level: annotation.level,
        },
        workspaceRoot,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}
