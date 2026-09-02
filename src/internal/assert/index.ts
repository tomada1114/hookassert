/**
 * The assert engine's own internal surface.
 *
 * @remarks
 * `CaseResult`, `Summary`, `ExpectationDiff`, and `NonFiringExplanation` —
 * the vocabulary itself — are published straight from `src/types.ts` and
 * `src/index.ts`; what lives here is the machinery that produces them
 * (`assertCase.ts`, `summarize.ts`), which stays internal until a later
 * `test`-command issue's composition root wires it in. `src/cli.ts` is that
 * composition root — see `spec/index.ts`'s doc comment for why nothing here
 * is re-exported from `src/index.ts` in the meantime.
 */

export { assertCase, isStubOnly } from "./assertCase.js";
export { summarize } from "./summarize.js";
export type { CaseObservation, FiredHook } from "./types.js";
