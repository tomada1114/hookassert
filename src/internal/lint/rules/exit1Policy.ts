/**
 * `exit-1-policy`: a hook whose command looks like a policy branch
 * (heuristically: contains conditional logic and an explicit `exit 1`) but
 * exits `1` rather than `2`.
 *
 * @remarks
 * The static sibling of `src/internal/decision/resolve.ts`'s own runtime
 * handling of a documented `non-blocking-error`/`ignored` exit-code effect —
 * exit 1 never blocks; only exit 2 does. This rule surfaces that same fact
 * before any process runs. `Finding.message` states the actual semantics
 * explicitly: only `exit 2` blocks, and the tool call proceeds anyway on any
 * other non-zero exit regardless of what the hook "intended."
 *
 * Heuristic, not a real control-flow analysis: `hookSourceText` scans the
 * command string, its `args`, and (when resolvable) the script file it
 * points at, for `if`/`case` alongside `exit 1` with no `exit 2` anywhere in
 * the same text. A hook that legitimately never blocks (no `exit 2` on any
 * path, by design) will still be flagged if it happens to branch and exit 1
 * — that false-positive is the cost of a lint rule that never spawns
 * anything to see what the hook would actually do.
 */

import { hookSourceText } from "../commandProbe.js";
import type { Finding, LintContext, LintRule } from "../types.js";

const CONDITIONAL = /\b(?:if|case)\b/;
const EXIT_1 = /\bexit\s+1\b/;
const EXIT_2 = /\bexit\s+2\b/;

export const exit1PolicyRule: LintRule = {
  id: "exit-1-policy",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const command of ctx.commands) {
      const text = hookSourceText(command, ctx);
      if (!CONDITIONAL.test(text) || !EXIT_1.test(text) || EXIT_2.test(text)) {
        continue;
      }

      findings.push({
        file: command.file,
        line: command.line,
        ruleId: "exit-1-policy",
        message:
          `The "${command.event}" hook looks like a policy branch (it contains ` +
          'conditional logic and an explicit "exit 1") but never exits 2. Only ' +
          "exit code 2 blocks the tool call — any other non-zero exit, including " +
          "1, resolves to a non-blocking error, and the tool call proceeds anyway " +
          "regardless of what the hook intended.",
        suggestion:
          'Change the blocking branch\'s "exit 1" to "exit 2" if this hook is ' +
          "meant to deny the action.",
      });
    }
    return findings;
  },
};
