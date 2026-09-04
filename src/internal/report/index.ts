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
export { renderJson, toJsonReport } from "./json.js";
export type { JsonExplainReport } from "./json.js";
export {
  relativizeForGithub,
  renderGithub,
  renderGithubFinding,
  renderGithubHeader,
} from "./github.js";
export type { ReportFinding } from "./github.js";
export { isReportFormat, renderInFormat } from "./format.js";
export type { FormatRenderers, ReportFormat } from "./format.js";
export {
  renderTestGithub,
  renderTestJson,
  renderTestPretty,
  toJsonTestReport,
} from "./testReport.js";
export type {
  JsonTestReport,
  LaunchFailure,
  TestCaseReport,
  TestReport,
} from "./testReport.js";
export {
  renderLintGithub,
  renderLintJson,
  renderLintPretty,
  toJsonLintReport,
} from "./lintReport.js";
export type { JsonLintReport, LintReport } from "./lintReport.js";
