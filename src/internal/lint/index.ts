/**
 * The lint rule framework's own internal surface.
 *
 * @remarks
 * `src/cli.ts` is the composition root that imports from here; nothing here
 * is re-exported from `src/index.ts` — see `types.ts`'s own doc comment for
 * why that boundary is enforced mechanically, not just by convention.
 */

export { buildLintContext, readMatcherGroups } from "./parse.js";
export { LINT_RULES } from "./registry.js";
export type {
  Finding,
  LintContext,
  LintMatcherGroup,
  LintMatcherValue,
  LintRule,
} from "./types.js";
