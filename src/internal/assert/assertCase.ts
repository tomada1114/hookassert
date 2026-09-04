/**
 * Compares one fixture case's declared `expect` against what actually
 * happened, producing a `CaseResult`.
 *
 * @remarks
 * Static layer: pure comparison — no I/O, no process, no write. This module
 * consumes a `Decision` per firing hook, an `ExecOutcome` per firing hook,
 * and the matcher engine's `MatcherOutcome`s for the case, all of which the
 * caller already obtained; it never resolves a decision or classifies a
 * matcher itself, and its own `combineDecisions` call
 * (`src/internal/decision/`) only folds `Decision`s the caller already
 * resolved rather than resolving one itself.
 */

import type {
  CaseResult,
  Decision,
  DecidingHook,
  EventName,
  ExpectationDiff,
  NonFiringExplanation,
  RejectedMatch,
} from "../../types.js";
import { combineDecisions, readHookOutput } from "../decision/index.js";
import type { HookOutput } from "../decision/index.js";
import type { FixtureCase, FixtureExpectation } from "../fixture/index.js";
import type { CaseObservation, FiredHook } from "./types.js";

/**
 * Exact structural equality over JSON-shaped values: same type, same keys
 * (order-independent), same array length, recursive. No dependency — this is
 * `expect.context`/`expect.updatedInput`'s comparison rule
 * (`computeFiredDiffs` below), and a partial/subset match was deliberately
 * rejected for it: `context` is a string in practice, where "subset" has no
 * meaning, and a subset rule for `updatedInput` would make
 * `expect.updatedInput: {}` pass against anything.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every(
      (key) => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]),
    );
  }

  return false;
}

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
 * Explain why no hook fired for a case that declared an expectation other
 * than `fires: false`, from what the matcher engine already found for this
 * case's event.
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
 * Every {@link ExpectationDiff} between `expect` and the case's combined
 * `decision`, checked against every firing hook's own stream and timeout.
 *
 * @remarks
 * Only called once the caller has already excluded `decision.kind ===
 * "unknown"` — an unresolved decision produces its own `CaseResult.kind ===
 * "unknown"` rather than a `diffs` mismatch. `decision`/`exitCode` are
 * compared against the combined verdict (`exitCode` is the deciding hook's
 * own, since that is whose `Decision` won the fold); `stdoutContains`,
 * `stderrContains`, `timedOut`, `context`, and `updatedInput` are checked
 * against *every* firing hook — a real Claude Code session shows every
 * hook's output, not only the one that decided — so any one of them
 * satisfying the expectation is enough. `context`/`updatedInput` compare
 * `hookSpecificOutput.additionalContext`/`hookSpecificOutput.updatedInput`
 * (read by `decision/`'s `readHookOutput`) by exact `deepEqual`, never a
 * partial match.
 */
function computeFiredDiffs(
  expect: FixtureExpectation,
  decision: Exclude<Decision, { kind: "unknown" }>,
  fired: readonly [FiredHook, ...FiredHook[]],
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

  if (expect.stdoutContains !== undefined) {
    const substring = expect.stdoutContains;
    const matched = fired.some((f) => f.execOutcome.stdout.includes(substring));
    if (!matched) {
      diffs.push({
        field: "stdoutContains",
        expectedSubstring: substring,
        actualStdout: fired.map((f) => f.execOutcome.stdout).join("\n"),
      });
    }
  }

  if (expect.stderrContains !== undefined) {
    const substring = expect.stderrContains;
    const matched = fired.some((f) => f.execOutcome.stderr.includes(substring));
    if (!matched) {
      diffs.push({
        field: "stderrContains",
        expectedSubstring: substring,
        actualStderr: fired.map((f) => f.execOutcome.stderr).join("\n"),
      });
    }
  }

  if (expect.timedOut !== undefined) {
    const actualTimedOut = fired.some((f) => f.execOutcome.timedOut);
    if (expect.timedOut !== actualTimedOut) {
      diffs.push({
        field: "timedOut",
        expectedTimedOut: expect.timedOut,
        actualTimedOut,
      });
    }
  }

  if (expect.context !== undefined || expect.updatedInput !== undefined) {
    const outputs = fired.map((f) => readHookOutput(f.execOutcome));

    if (expect.context !== undefined) {
      const expectedContext = expect.context;
      if (!outputs.some((o) => deepEqual(o.additionalContext, expectedContext))) {
        diffs.push({
          field: "context",
          expectedContext,
          actualContext: firstEmitted(outputs, "additionalContext"),
        });
      }
    }

    if (expect.updatedInput !== undefined) {
      const expectedUpdatedInput = expect.updatedInput;
      if (!outputs.some((o) => deepEqual(o.updatedInput, expectedUpdatedInput))) {
        diffs.push({
          field: "updatedInput",
          expectedUpdatedInput,
          actualUpdatedInput: firstEmitted(outputs, "updatedInput"),
        });
      }
    }
  }

  return diffs;
}

/**
 * `outputs[*][key]` from the first `HookOutput` that emitted it, or
 * `undefined` when none did — the `actualContext`/`actualUpdatedInput` a
 * `"context"`/`"updatedInput"` {@link ExpectationDiff} reports, independent
 * of which firing hook (if any) is what {@link computeFiredDiffs} actually
 * compared `expect.context`/`expect.updatedInput` against.
 */
function firstEmitted(outputs: readonly HookOutput[], key: keyof HookOutput): unknown {
  return outputs.find((o) => o[key] !== undefined)?.[key];
}

/** Type guard narrowing `fired` to a non-empty tuple once its length has been checked. */
function isNonEmptyFired(
  fired: readonly FiredHook[],
): fired is readonly [FiredHook, ...FiredHook[]] {
  return fired.length > 0;
}

/**
 * Compare `caseData`'s declared `expect` against `observation` — what
 * actually happened — and produce the matching `CaseResult`.
 *
 * @remarks
 * Checked in this order:
 * 1. `caseData.dryRun: true` or a stub-only case with no declared
 *    expectation → `"skipped"`, nothing to compare.
 * 2. No hook fired at all (issue #68): `expect.fires: false` → `"pass"`,
 *    the explicit opt-out for "I expect nothing to fire". Any other
 *    declared `expect` field (including `fires: true` on its own) →
 *    `"fail"` with {@link NonFiringExplanation} — a declared expectation
 *    that nothing fired could possibly satisfy. A wholly empty `expect` →
 *    `"pass"`, since there was nothing declared to compare.
 * 3. One or more hooks fired: every firing hook's own `Decision` is folded
 *    into one combined verdict by `combineDecisions`
 *    (`deny` > `unknown` > `error` > `allow` > `pass` — any deny wins,
 *    regardless of which hook produced it or how many others fired), and
 *    the hook that produced the winning `Decision` is recorded as
 *    `decidedBy` on every branch below.
 * 4. The combined `Decision` could not be asserted with confidence
 *    (`decision.kind === "unknown"`) → `"unknown"`, carrying the same
 *    `reasons` that `Decision` itself carries.
 * 5. The combined `Decision` resolved with confidence → every declared
 *    `expect` field is compared against what was observed (`decision`/
 *    `exitCode` against the combined verdict, `stdoutContains`/
 *    `stderrContains`/`timedOut`/`context`/`updatedInput` against every
 *    firing hook's own stream); any mismatch produces `"fail"` with a
 *    non-empty `diffs`, otherwise `"pass"`.
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

  const { fired } = observation;
  if (!isNonEmptyFired(fired)) {
    // `fires: false` is the explicit opt-out — "I expect nothing to
    // fire" — and passes on its own; `fixture/load.ts`'s
    // FixtureFiresFalseConflictError already rejects pairing it with any
    // other expect field at load time, so this branch never has to weigh
    // the two against each other.
    if (caseData.expect.fires === false) {
      return { kind: "pass", origin, decidedBy: undefined };
    }
    // Any other declared expectation — decision, exitCode,
    // stdoutContains, stderrContains, timedOut, context, updatedInput, or
    // fires: true itself — cannot have been observed when nothing fired,
    // so it fails rather than passing by default (issue #68). Only a
    // wholly empty expectation still passes: there was nothing to compare.
    if (!isEmptyExpectation(caseData.expect)) {
      return {
        kind: "fail",
        origin,
        diffs: [],
        nonFiring: deriveNonFiring(caseData.event, observation),
        decidedBy: undefined,
      };
    }
    return { kind: "pass", origin, decidedBy: undefined };
  }

  const decisions: readonly [Decision, ...Decision[]] = [
    fired[0].decision,
    ...fired.slice(1).map((f) => f.decision),
  ];
  const combined = combineDecisions(decisions);
  // combined.index is always a valid index into `fired` — combineDecisions
  // picks it from `decisions`, built 1:1 with `fired` above — but a dynamic
  // numeric index into an array still types as possibly undefined under
  // noUncheckedIndexedAccess; `fired[0]` is the unreachable-in-practice
  // fallback, itself guaranteed present by the tuple type `fired` narrowed
  // to above.
  const decidingHookEntry = fired[combined.index] ?? fired[0];
  const decidedBy: DecidingHook = {
    hook: decidingHookEntry.hook,
    decision: combined.decision,
    launchError: decidingHookEntry.execOutcome.launchError,
  };

  if (combined.decision.kind === "unknown") {
    return { kind: "unknown", origin, reasons: combined.decision.reasons, decidedBy };
  }

  const diffs = computeFiredDiffs(caseData.expect, combined.decision, fired);
  if (diffs.length > 0) {
    return { kind: "fail", origin, diffs, nonFiring: undefined, decidedBy };
  }
  return { kind: "pass", origin, decidedBy };
}
