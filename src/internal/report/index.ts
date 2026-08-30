/**
 * The pretty reporter's own internal surface.
 *
 * @remarks
 * `src/cli.ts` is the composition root that imports from here; nothing here
 * is re-exported from `src/index.ts` — see `types.ts`'s doc comment for why
 * that boundary is enforced mechanically, not just by convention.
 */

export { renderPretty } from "./pretty.js";
export { buildReportHeader, formatClaudeVersion } from "./summary.js";
export type { ExplainReport, ReportHeader } from "./summary.js";
