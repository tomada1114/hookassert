/**
 * The matcher engine's own internal surface.
 *
 * @remarks
 * `src/cli.ts` (a later cli-explain issue) is the composition root that will
 * import from here; nothing here is re-exported from `src/index.ts` — see
 * `types.ts`'s doc comment for why that boundary is enforced mechanically,
 * not just by convention.
 */

export { classifyMatcher } from "./classify.js";
export { matchHooks } from "./match.js";
export type {
  MatcherKind,
  MatcherOutcome,
  MatchRequest,
  MatchResult,
  VersionContext,
} from "./types.js";
