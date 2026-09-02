/**
 * Internal plumbing types for the assert engine.
 *
 * @remarks
 * `CaseObservation` is not part of the published contract: `src/index.ts`
 * re-exports only `src/types.ts`'s vocabulary, and ESLint's
 * `public-api/internal-stays-private` block forbids `src/index.ts` from
 * importing anything under `src/internal/` at all, so nothing declared here
 * can leak into the public surface by accident. It lives next to the module
 * that uses it rather than in `src/types.ts`, which is reserved for the
 * vocabulary every module speaks — this one is spoken only by
 * `src/internal/assert/**`.
 */

import type { Decision, ExecOutcome, ResolvedHook } from "../../types.js";
import type { MatcherOutcome } from "../matcher/index.js";

/**
 * One hook that fired for a fixture case, paired with what it actually
 * produced.
 *
 * @remarks
 * Static layer: plain data, no I/O — `src/cli.ts`'s composition root is what
 * actually runs a hook and produces these values; `assertCase` only ever
 * reads them.
 */
export interface FiredHook {
  /** The hook that fired. */
  readonly hook: ResolvedHook;
  /** The raw exec outcome this hook produced. */
  readonly execOutcome: ExecOutcome;
  /** This hook's own resolved `Decision`, from `resolveDecision`. */
  readonly decision: Decision;
}

/**
 * What actually happened for one fixture case, gathered from the matcher
 * engine and the decision resolver — everything `assertCase` needs beyond
 * the case's own declared `expect`.
 *
 * @remarks
 * Static layer: plain data, no I/O. A later executor issue's composition
 * root is what actually runs a hook and produces these values; `assertCase`
 * only ever reads them, and never spawns anything itself.
 */
export interface CaseObservation {
  /**
   * Every hook that fired for this case, in firing order, each carrying its
   * own outcome and resolved `Decision`. Empty when nothing fired at all.
   *
   * @remarks
   * More than one entry is the ordinary product of the three-layer settings
   * merge (a project-layer hook behind a user-layer one, say): every firing
   * hook is spawned, and `assertCase` folds all of their `Decision`s into
   * one case verdict through `combineDecisions`
   * (`src/internal/decision/combine.ts`) rather than reading only the first.
   */
  readonly fired: readonly FiredHook[];

  /**
   * Every hook under this case's event that was a matcher candidate — read
   * from a settings layer the fixture's `settings:` list included — but did
   * not fire. Empty whenever {@link CaseObservation.fired} is non-empty, or
   * when no candidate hook was rejected by the matcher.
   */
  readonly rejectedByMatcher: readonly MatcherOutcome[];

  /**
   * Hooks under this case's event declared in a settings layer the
   * fixture's `settings:` list did not include, so they were never even
   * candidates for {@link CaseObservation.rejectedByMatcher}.
   */
  readonly excludedHooks: readonly ResolvedHook[];
}
