/**
 * `command-not-found`: a hook's command does not resolve to an existing,
 * resolvable executable — the hook cannot start at all.
 *
 * @remarks
 * Resolution is entirely static — `commandProbe.ts`'s `resolveCommandTarget`
 * — and covers both spawn forms: an absolute path is checked as-is, a
 * relative path (`./guard.sh`, `scripts/guard.sh`) resolves against the
 * settings file's own project root, and a bare command word (`npx`, `jq`) is
 * looked up on `ctx.pathEnv`. See `commandProbe.ts`'s own remarks for why
 * none of this ever spawns a process — the "not in scope" note this issue's
 * design carries.
 */

import { commandTarget, resolveCommandTarget } from "../commandProbe.js";
import type { Finding, LintContext, LintRule } from "../types.js";

export const commandNotFoundRule: LintRule = {
  id: "command-not-found",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const command of ctx.commands) {
      const resolution = resolveCommandTarget(command, ctx.pathEnv);
      if (resolution.kind === "resolved") {
        continue;
      }

      const target = commandTarget(command) ?? command.command;
      findings.push({
        file: command.file,
        line: command.line,
        ruleId: "command-not-found",
        message:
          `The "${command.event}" hook's command ${JSON.stringify(command.command)} ` +
          `does not resolve to an existing, resolvable executable (looked for ` +
          `"${target}"). The hook cannot start at all — Claude Code will report a ` +
          "spawn failure every time this hook would run.",
        suggestion:
          `Fix the path, or make sure "${target}" is installed and on PATH, so ` +
          "it resolves before Claude Code tries to spawn it.",
      });
    }
    return findings;
  },
};
