/**
 * The `pretty` reporter: a human-readable rendering of an `ExplainReport`.
 *
 * @remarks
 * Static layer: pure string formatting — no I/O, no process, no write. The
 * `json` and `github` reporters are the `reporters` issue's own work.
 */

import type { ResolvedHook } from "../../types.js";
import type { ExplainReport } from "./summary.js";

/** One firing or non-firing hook line: its layer, absolute file, and line. */
function describeHook(hook: ResolvedHook): string {
  const { provenance } = hook;
  return `[${provenance.layer}] ${provenance.file}:${String(provenance.line)} ${hook.command}`;
}

/**
 * Render an {@link ExplainReport} for a terminal.
 *
 * @remarks
 * Always prints the header — the detected Claude Code version (or
 * `"undetermined"`) and the spec's declared range — even when `firing` and
 * `rejected` are both empty, so a caller who ran `explain` against an event
 * with no hooks at all still sees what version and spec range the run
 * evaluated against.
 */
export function renderPretty(report: ExplainReport): string {
  const lines: string[] = [];

  lines.push(`Claude Code version: ${report.header.claudeVersion}`);
  lines.push(`Spec range: ${report.header.specRange}`);
  for (const notice of report.header.notices) {
    lines.push(`Notice: ${notice}`);
  }

  lines.push("");
  lines.push(
    report.target === undefined ? report.event : `${report.event} ${report.target}`,
  );

  lines.push("");
  if (report.firing.length === 0) {
    lines.push("Firing hooks: none");
  } else {
    lines.push("Firing hooks:");
    // A set, not a repeated `matcherIgnored.includes(hook)`: the lookup is
    // by identity either way, but scanning the list per firing hook is
    // quadratic in the size of a settings tree's firing set.
    const ignored = new Set(report.matcherIgnored);
    for (const hook of report.firing) {
      const ignoredNote = ignored.has(hook)
        ? " (matcher ignored: this event has no matcher support)"
        : "";
      lines.push(`  ${describeHook(hook)}${ignoredNote}`);
    }
  }

  lines.push("");
  if (report.rejected.length === 0) {
    lines.push("Not firing: none");
  } else {
    lines.push("Not firing:");
    for (const outcome of report.rejected) {
      lines.push(`  ${describeHook(outcome.hook)} — ${outcome.reason}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
