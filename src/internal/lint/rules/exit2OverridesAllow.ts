/**
 * `exit-2-overrides-allow`: a hook structure that can emit an `allow` JSON
 * decision on some path yet also exit `2` on another (or the same) path.
 *
 * @remarks
 * The static sibling of `src/internal/decision/resolve.ts`'s own
 * `exit2OverridesAllowJson` — that function proves the same fact at runtime,
 * from a real `ExecOutcome`; this rule flags the hook structure that would
 * trigger it before any process runs. `exit 2` always wins over an `allow`
 * payload, whichever branch produced each — `Finding.message` states that
 * override rule explicitly, per this issue's own acceptance criterion,
 * rather than only flagging the ambiguity.
 *
 * Heuristic co-occurrence check, not a control-flow analysis:
 * `hookSourceText` scans the command string, its `args`, and (when
 * resolvable) the script file it points at, for an allow-shaped JSON
 * decision value (`"decision":"allow"` or `"permissionDecision":"allow"`,
 * spacing-tolerant) alongside a literal `exit 2` anywhere in the same text —
 * on the same path or a different one, since either shape is the trap this
 * rule exists to catch.
 */

import { hookSourceText } from "../commandProbe.js";
import type { Finding, LintContext, LintRule } from "../types.js";

const ALLOW_JSON = /"(?:permissionDecision|decision)"\s*:\s*"allow"/;
const EXIT_2 = /\bexit\s+2\b/;

export const exit2OverridesAllowRule: LintRule = {
  id: "exit-2-overrides-allow",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const command of ctx.commands) {
      const text = hookSourceText(command, ctx.pathEnv);
      if (!ALLOW_JSON.test(text) || !EXIT_2.test(text)) {
        continue;
      }

      findings.push({
        file: command.file,
        line: command.line,
        ruleId: "exit-2-overrides-allow",
        message:
          `The "${command.event}" hook can both emit an "allow" JSON decision ` +
          "and exit with code 2. Claude Code always lets exit 2 override an " +
          '"allow" payload — whichever path produced the allow, an exit-2 path ' +
          "in the same hook wins and the action is denied anyway.",
        suggestion:
          "Make the exit code and the JSON decision agree on every path: exit 0 " +
          '(or a non-blocking code) wherever the hook emits "allow", and reserve ' +
          '"exit 2" for a path that never also writes an allow decision.',
      });
    }
    return findings;
  },
};
