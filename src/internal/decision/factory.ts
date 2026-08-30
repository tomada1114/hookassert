/**
 * The only place a {@link Decision} object literal is written.
 *
 * @remarks
 * Static layer: pure construction, no I/O. `resolve.ts` and every later
 * consumer builds a `Decision` through these functions rather than writing
 * the shape out at the call site — enforced as a lint/review-time rule, not a
 * mechanical one, per this issue's design. `unknownDecision`'s required
 * `first` parameter is what makes `Decision.unknown.reasons`'s non-empty
 * tuple constructible everywhere without repeating an array literal: calling
 * `unknownDecision()` with no arguments fails to compile.
 */

import type { Decision, UnknownReason } from "../../types.js";

/** The action is blocked. */
export function denied(
  source: "exit-2" | "permission-decision",
  exitCode: number,
): Decision {
  return { kind: "deny", source, exitCode };
}

/** Stdout JSON explicitly granted the action. */
export function allowed(exitCode: number): Decision {
  return { kind: "allow", exitCode };
}

/** No decision is present; the normal permission flow proceeds. */
export function passed(exitCode: number): Decision {
  return { kind: "pass", exitCode };
}

/** The outcome could not be turned into a decision at all. */
export function errored(
  exitCode: number,
  cause: "nonzero-exit-without-json" | "invalid-json" | "schema-violation",
): Decision {
  return { kind: "error", exitCode, cause };
}

/**
 * Build an `"unknown"` decision from at least one {@link UnknownReason}.
 *
 * @param first - The first reason nothing else could be asserted.
 * @param rest - Any further reasons; a caller with several may pass them all.
 */
export function unknownDecision(
  first: UnknownReason,
  ...rest: UnknownReason[]
): Decision {
  return { kind: "unknown", reasons: [first, ...rest] };
}
