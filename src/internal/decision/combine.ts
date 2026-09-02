/**
 * Folds every firing hook's {@link Decision} for one fixture case into a
 * single verdict.
 *
 * @remarks
 * Static layer: pure fold, no I/O — `resolveDecision` still maps one
 * `ExecOutcome` to one `Decision`; this module only combines `Decision`s a
 * caller already resolved, and never touches an `ExecOutcome` itself. More
 * than one hook firing for the same event is the ordinary product of the
 * three-layer settings merge (`settings/merge.ts`), and Claude Code itself
 * runs every matching hook in parallel and honors a blocking result from
 * any one of them — this is the fold that reproduces that same verdict from
 * hookassert's own per-hook `Decision`s.
 */

import type { Decision } from "../../types.js";

/**
 * `Decision.kind`'s precedence, lowest number wins: `deny` outranks
 * everything (a confident deny from any hook is the session's outcome
 * regardless of what the others said or whether they could be resolved),
 * `unknown` outranks `error`/`allow`/`pass` (nothing denied, but at least
 * one hook could not be resolved with confidence, so the case cannot be
 * asserted with confidence either), `error` outranks `allow`/`pass` (a hook
 * that broke is more important to surface than a sibling that succeeded),
 * and `allow` outranks `pass` (an explicit allow is a decision; a pass is
 * the absence of one).
 */
const PRECEDENCE: Readonly<Record<Decision["kind"], number>> = {
  deny: 0,
  unknown: 1,
  error: 2,
  allow: 3,
  pass: 4,
};

/** The fold of every firing hook's `Decision` into one case verdict. */
export interface CombinedDecision {
  /** The winning `Decision`, by {@link PRECEDENCE}. */
  readonly decision: Decision;
  /**
   * Index into the input tuple of the hook that produced
   * {@link CombinedDecision.decision} — the first hook at the winning
   * precedence, in firing order, when more than one hook ties.
   */
  readonly index: number;
}

/**
 * Fold `decisions` — one per firing hook, in firing order — into the single
 * verdict the case is reported against: `deny` > `unknown` > `error` >
 * `allow` > `pass`.
 *
 * @param decisions - Every firing hook's resolved `Decision`, in the same
 * order the hooks fired. Required to be non-empty: a case with no firing
 * hook at all has no `Decision` to combine, and is handled by the caller
 * before this is ever called.
 */
export function combineDecisions(
  decisions: readonly [Decision, ...Decision[]],
): CombinedDecision {
  let winner: CombinedDecision = { decision: decisions[0], index: 0 };
  decisions.forEach((decision, index) => {
    if (PRECEDENCE[decision.kind] < PRECEDENCE[winner.decision.kind]) {
      winner = { decision, index };
    }
  });
  return winner;
}
