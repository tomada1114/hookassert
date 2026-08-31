/**
 * Compares one fixture case's declared `expect` against what actually
 * happened, producing a `CaseResult`.
 *
 * @remarks
 * Static layer: pure comparison — no I/O, no process, no write. This module
 * only consumes a `Decision`, an `ExecOutcome`, and the matcher engine's
 * `MatcherOutcome`s for the case, all of which the caller already obtained;
 * it never resolves a decision or classifies a matcher itself.
 */

import type {
  CaseResult,
  Decision,
  EventName,
  ExecOutcome,
  ExpectationDiff,
  NonFiringExplanation,
  RejectedMatch,
} from "../../types.js";
import type { FixtureCase, FixtureExpectation } from "../fixture/index.js";
import type { CaseObservation } from "./types.js";

/** Whether `expect` declares no assertion at all — every field is `undefined`. */
function isEmptyExpectation(expect: FixtureExpectation): boolean {
  return (
    expect.fires === undefined &&
    expect.decision === undefined &&
    expect.exitCode === undefined &&
    expect.stdoutContains === undefined &&
    expect.stderrContains === undefined &&
    expect.context === undefined &&
    expect.updatedInput === undefined &&
    expect.timedOut === undefined
  );
}

/**
 * Whether `caseData` exists only to configure a stub, with nothing declared
 * to assert against.
 *
 * @remarks
 * Exported so `src/cli.ts` can keep such a case out of the spawn plan in the
 * first place, using this exact predicate rather than a copy of it: a case
 * this returns `true` for is one {@link assertCase} reports as `"skipped"`,
 * and the two must never disagree about which those are.
 */
export function isStubOnly(caseData: FixtureCase): boolean {
  return (
    caseData.stub !== undefined &&
    Object.keys(caseData.stub).length > 0 &&
    isEmptyExpectation(caseData.expect)
  );
}

/**
 * Explain why `expect.fires: true` was not met, from what the matcher
 * engine already found for this case's event.
 *
 * @remarks
 * Checked in this order: a candidate hook the matcher rejected outranks a
 * hook that was never even a candidate because its settings layer was
 * excluded, which in turn outranks the case where nothing is declared under
 * the event at all — the more specific cause is reported first.
 */
function deriveNonFiring(
  event: EventName,
  observation: CaseObservation,
): NonFiringExplanation {
  if (observation.rejectedByMatcher.length > 0) {
    const hooks: RejectedMatch[] = observation.rejectedByMatcher.map((outcome) => ({
      hook: outcome.hook,
      reason: outcome.reason,
    }));
    return { kind: "matcher-did-not-match", hooks };
  }
  if (observation.excludedHooks.length > 0) {
    return { kind: "excluded-settings-layer", hooks: observation.excludedHooks };
  }
  return { kind: "no-hook-configured", event };
}

/**
 * Every {@link ExpectationDiff} between `expect` and a firing hook's
 * resolved `decision` and `execOutcome`.
 *
 * @remarks
 * Only called once the caller has already excluded `decision.kind ===
 * "unknown"` — an unresolved decision produces its own `CaseResult.kind ===
 * "unknown"` rather than a `diffs` mismatch.
 */
function computeFiredDiffs(
  expect: FixtureExpectation,
  decision: Exclude<Decision, { kind: "unknown" }>,
  execOutcome: ExecOutcome | undefined,
): ExpectationDiff[] {
  const diffs: ExpectationDiff[] = [];

  if (expect.fires === false) {
    diffs.push({ field: "fires", expectedFires: false, actualFires: true });
  }

  if (expect.decision !== undefined && expect.decision !== decision.kind) {
    diffs.push({
      field: "decision",
      expectedDecision: expect.decision,
      actualDecision: decision.kind,
    });
  }

  if (expect.exitCode !== undefined && expect.exitCode !== decision.exitCode) {
    diffs.push({
      field: "exitCode",
      expectedExitCode: expect.exitCode,
      actualExitCode: decision.exitCode,
    });
  }

  const stdout = execOutcome?.stdout ?? "";
  if (expect.stdoutContains !== undefined && !stdout.includes(expect.stdoutContains)) {
    diffs.push({
      field: "stdoutContains",
      expectedSubstring: expect.stdoutContains,
      actualStdout: stdout,
    });
  }

  const stderr = execOutcome?.stderr ?? "";
  if (expect.stderrContains !== undefined && !stderr.includes(expect.stderrContains)) {
    diffs.push({
      field: "stderrContains",
      expectedSubstring: expect.stderrContains,
      actualStderr: stderr,
    });
  }

  if (expect.timedOut !== undefined) {
    const actualTimedOut = execOutcome?.timedOut ?? false;
    if (expect.timedOut !== actualTimedOut) {
      diffs.push({
        field: "timedOut",
        expectedTimedOut: expect.timedOut,
        actualTimedOut,
      });
    }
  }

  return diffs;
}

/**
 * Compare `caseData`'s declared `expect` against `observation` — what
 * actually happened — and produce the matching `CaseResult`.
 *
 * @remarks
 * Checked in this order:
 * 1. `caseData.dryRun: true` or a stub-only case with no declared
 *    expectation → `"skipped"`, nothing to compare.
 * 2. No hook fired at all: `expect.fires: true` → `"fail"` with
 *    {@link NonFiringExplanation}; otherwise → `"pass"`, since nothing else
 *    was declared to compare against a case that was not expected to fire.
 * 3. A hook fired but its resolved `Decision` could not be asserted with
 *    confidence (`decision.kind === "unknown"`) → `"unknown"`, carrying the
 *    same `reasons` the `Decision` itself carries.
 * 4. A hook fired and its `Decision` resolved with confidence → every
 *    declared `expect` field is compared against what was observed; any
 *    mismatch produces `"fail"` with a non-empty `diffs`, otherwise
 *    `"pass"`.
 */
export function assertCase(
  caseData: FixtureCase,
  observation: CaseObservation,
): CaseResult {
  const { origin } = caseData;

  if (caseData.dryRun === true) {
    return { kind: "skipped", origin, reason: "dry-run" };
  }
  if (isStubOnly(caseData)) {
    return { kind: "skipped", origin, reason: "stub-only" };
  }

  if (observation.decision === undefined) {
    if (caseData.expect.fires === true) {
      return {
        kind: "fail",
        origin,
        diffs: [],
        nonFiring: deriveNonFiring(caseData.event, observation),
      };
    }
    return { kind: "pass", origin };
  }

  const { decision } = observation;
  if (decision.kind === "unknown") {
    return { kind: "unknown", origin, reasons: decision.reasons };
  }

  const diffs = computeFiredDiffs(caseData.expect, decision, observation.execOutcome);
  if (diffs.length > 0) {
    return { kind: "fail", origin, diffs, nonFiring: undefined };
  }
  return { kind: "pass", origin };
}
