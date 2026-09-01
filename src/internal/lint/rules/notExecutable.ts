/**
 * `not-executable`: the hook's command file exists but lacks the executable
 * permission bit.
 *
 * @remarks
 * Checked with `fs.accessSync(path, X_OK)` — a filesystem permission read,
 * never a spawn — so this catches exactly the case
 * `command-not-found` does not: the file is real and resolvable, but Claude
 * Code still cannot launch it.
 */

import {
  isExecutableFile,
  isRegularFile,
  resolveCommandTarget,
} from "../commandProbe.js";
import type { Finding, LintContext, LintRule } from "../types.js";

export const notExecutableRule: LintRule = {
  id: "not-executable",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const command of ctx.commands) {
      const resolution = resolveCommandTarget(command, ctx.pathEnv);
      if (resolution.kind !== "resolved") {
        continue;
      }
      if (!isRegularFile(resolution.path)) {
        continue;
      }
      if (isExecutableFile(resolution.path)) {
        continue;
      }

      findings.push({
        file: command.file,
        line: command.line,
        ruleId: "not-executable",
        message:
          `The "${command.event}" hook's command file "${resolution.path}" exists ` +
          "but is not executable. Claude Code cannot spawn it without the " +
          "executable permission bit set.",
        suggestion: `Run "chmod +x ${resolution.path}" so the file carries the executable bit.`,
      });
    }
    return findings;
  },
};
