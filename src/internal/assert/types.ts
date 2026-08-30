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
   * The resolved `Decision` when a hook fired and ran; `undefined` when
   * nothing fired for this case at all.
   */
  readonly decision: Decision | undefined;

  /**
   * The raw exec outcome the firing hook produced. `undefined` whenever
   * {@link CaseObservation.decision} is `undefined` — nothing ran to
   * produce one.
   */
  readonly execOutcome: ExecOutcome | undefined;

  /**
   * Every hook under this case's event that was a matcher candidate — read
   * from a settings layer the fixture's `settings:` list included — but did
   * not fire. Empty whenever {@link CaseObservation.decision} is defined, or
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
