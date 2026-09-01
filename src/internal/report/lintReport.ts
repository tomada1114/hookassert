/**
 * The result shape `lint` renders, and its `pretty` renderer.
 *
 * @remarks
 * Static layer: pure string formatting — no I/O, no process, no write.
 * Mirrors `summary.ts`'s `ExplainReport`/`pretty.ts` split for `explain`,
 * but for `lint`'s own `Finding[]` (`src/internal/lint/`) rather than a
 * `MatchResult`.
 *
 * `json`/`github` rendering for a `LintReport` is out of scope for the issue
 * that added this module — see that issue's own "Not in scope" section —
 * and is left to a later issue, which reuses `ReportFinding`
 * (`report/github.ts`) to map a `Finding` onto a GitHub Actions annotation.
 */

import type { Finding } from "../lint/index.js";
import type { ReportHeader } from "./summary.js";

/** The full result `lint` renders. */
export interface LintReport {
  /** Printed first by every reporter format. */
  readonly header: ReportHeader;

  /** Every finding from every registered rule, in `LINT_RULES` order. */
  readonly findings: readonly Finding[];
}

/** Render a {@link LintReport} for a terminal. */
export function renderLintPretty(report: LintReport): string {
  const lines: string[] = [];

  lines.push(`Claude Code version: ${report.header.claudeVersion}`);
  lines.push(`Spec range: ${report.header.specRange}`);
  for (const notice of report.header.notices) {
    lines.push(`Notice: ${notice}`);
  }

  lines.push("");
  if (report.findings.length === 0) {
    lines.push("Findings: none");
  } else {
    lines.push(`Findings (${String(report.findings.length)}):`);
    for (const finding of report.findings) {
      lines.push(
        `  [${finding.ruleId}] ${finding.file}:${String(finding.line)} — ${finding.message}`,
      );
      lines.push(`    suggestion: ${finding.suggestion}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
