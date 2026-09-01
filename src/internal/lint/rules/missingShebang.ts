/**
 * `missing-shebang`: the hook's command resolves to a script file with no
 * `#!` line, so its behavior under exec form is unpredictable and likely to
 * fail.
 *
 * @remarks
 * Only reported when the command resolves to an existing regular file whose
 * extension `commandProbe.ts`'s `SCRIPT_EXTENSIONS` recognizes —
 * `command-not-found`'s own concern is an unresolvable command, and a
 * resolved file with an unrecognized extension (or none) is left alone
 * rather than guessed at: this rule cannot tell a missing shebang apart from
 * "this was never a script to begin with" for those.
 */

import {
  hasShebangLine,
  isRegularFile,
  isScriptLikePath,
  resolveCommandTarget,
} from "../commandProbe.js";
import type { Finding, LintContext, LintRule } from "../types.js";

export const missingShebangRule: LintRule = {
  id: "missing-shebang",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const command of ctx.commands) {
      const resolution = resolveCommandTarget(command, ctx.pathEnv);
      if (resolution.kind !== "resolved") {
        continue;
      }
      if (!isRegularFile(resolution.path) || !isScriptLikePath(resolution.path)) {
        continue;
      }
      if (hasShebangLine(resolution.path)) {
        continue;
      }

      findings.push({
        file: command.file,
        line: command.line,
        ruleId: "missing-shebang",
        message:
          `The "${command.event}" hook's command resolves to the script ` +
          `"${resolution.path}", which has no "#!" shebang line. Without one, ` +
          "how the file is interpreted is unpredictable under exec form and " +
          "likely to fail.",
        suggestion:
          'Add a shebang as the script\'s first line, e.g. "#!/bin/sh" or ' +
          '"#!/usr/bin/env node", matching the language the script is written in.',
      });
    }
    return findings;
  },
};
