/**
 * The decision vocabulary's own internal surface.
 *
 * @remarks
 * `Decision`, `UnknownReason`, and `ExecOutcome` — the vocabulary itself —
 * are published straight from `src/types.ts` and `src/index.ts`; what lives
 * here is the machinery that produces a `Decision` (`factory.ts`,
 * `resolve.ts`), which stays internal until a later executor issue's
 * composition root wires it in. `src/cli.ts` is that composition root — see
 * `spec/index.ts`'s doc comment for why nothing here is re-exported from
 * `src/index.ts` in the meantime.
 */

export { allowed, denied, errored, passed, unknownDecision } from "./factory.js";
export { canProduceDeny, exit2OverridesAllowJson, resolveDecision } from "./resolve.js";
export { combineDecisions } from "./combine.js";
export type { CombinedDecision } from "./combine.js";
