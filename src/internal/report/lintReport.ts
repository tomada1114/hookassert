/**
 * The result shape `lint` renders, and its `pretty`/`json`/`github`
 * renderers.
 *
 * @remarks
 * Static layer: pure string formatting — no I/O, no process, no write.
 * Mirrors `summary.ts`'s `ExplainReport`/`pretty.ts`/`json.ts`/`github.ts`
 * split for `explain`, and `testReport.ts`'s own three-renderer split for
 * `test`, but for `lint`'s own `Finding[]` (`src/internal/lint/`) rather
 * than a `MatchResult` or a `CaseResult[]`.
 */

import type { Finding } from "../lint/index.js";
import { renderGithubFinding, renderGithubHeader } from "./github.js";
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

/** JSON shape of one {@link Finding}, mirroring the domain type field for field. */
interface JsonLintFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly message: string;
  readonly suggestion: string;
}

/**
 * The shape `renderLintJson` emits.
 *
 * @remarks
 * `reportVersion` is versioned independently of `explain`'s own
 * `JsonExplainReport` (`report/json.ts`) and `test`'s own `JsonTestReport`
 * (`testReport.ts`) — each currently claims `reportVersion: "1"` for its
 * own, different shape. `reportType` disambiguates the three: unlike
 * `explain`'s `JsonExplainReport`, this shape has no `schema/*.schema.json`
 * of its own yet — a later issue that wants schema-checked `lint` JSON adds
 * one against this documented shape rather than reshaping it silently.
 */
export interface JsonLintReport {
  readonly reportVersion: "1";
  readonly reportType: "lint";
  readonly header: {
    readonly claudeVersion: string;
    readonly specRange: string;
    readonly notices: readonly string[];
  };
  readonly findings: readonly JsonLintFinding[];
}

/** Build the JSON-serializable shape {@link renderLintJson} stringifies. */
export function toJsonLintReport(report: LintReport): JsonLintReport {
  return {
    reportVersion: "1",
    reportType: "lint",
    header: {
      claudeVersion: report.header.claudeVersion,
      specRange: report.header.specRange,
      notices: report.header.notices,
    },
    findings: report.findings.map((finding) => ({
      file: finding.file,
      line: finding.line,
      ruleId: finding.ruleId,
      message: finding.message,
      suggestion: finding.suggestion,
    })),
  };
}

/** Render a {@link LintReport} as JSON. */
export function renderLintJson(report: LintReport): string {
  return `${JSON.stringify(toJsonLintReport(report), null, 2)}\n`;
}

/**
 * Render a {@link LintReport} as GitHub Actions workflow commands: the
 * leading header line, then one `::error` per finding.
 *
 * @remarks
 * Maps each `Finding` onto `report/github.ts`'s own decoupled
 * `ReportFinding` shape — `ruleId` becomes the annotation's `title`, and
 * `suggestion` is folded into the message body rather than dropped, since a
 * GitHub Actions annotation carries no separate "suggestion" field of its
 * own. `workspaceRoot` is threaded through exactly as `renderTestGithub`
 * threads it for `test`, so a `Finding.file` (always absolute — see
 * `lint/parse.ts`) renders relative to the repository checkout the same way
 * `explain`/`test`'s own github output does.
 */
export function renderLintGithub(report: LintReport, workspaceRoot: string): string {
  const lines: string[] = [renderGithubHeader(report.header)];

  for (const finding of report.findings) {
    lines.push(
      renderGithubFinding(
        {
          file: finding.file,
          line: finding.line,
          title: finding.ruleId,
          message: `${finding.message} Suggestion: ${finding.suggestion}`,
        },
        workspaceRoot,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}
