/**
 * The versioned hooks spec's own internal surface.
 *
 * @remarks
 * `src/cli.ts` (a later cli-explain issue) is the composition root that will
 * import from here; nothing here is re-exported from `src/index.ts` — see
 * `types.ts`'s doc comment for why that boundary is enforced mechanically,
 * not just by convention.
 */

export { isValidSpec, validateSpec } from "./guards.js";
export type {
  EventSpec,
  ExitCodeEffect,
  ExitCodeEffectKind,
  HookEnv,
  MatcherRule,
  MatcherSyntax,
  MatcherTableRow,
  MatcherTargets,
  PayloadShape,
  Spec,
  SpecDefaults,
  StderrDestination,
} from "./types.js";
export { loadSpec, loadSpecFile } from "./load.js";
export { isInDeclaredRange, meetsSinceVersion, parseClaudeVersion } from "./version.js";
export type { ClaudeVersion } from "./version.js";
