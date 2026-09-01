/**
 * `unquoted-var`: an unquoted shell variable reference (`$FOO` rather than
 * `"$FOO"`) inside a hook command that runs through shell form.
 *
 * @remarks
 * Heuristic by construction — full shell parsing is out of scope for a lint
 * rule, exactly as the issue's own "Trap" note says. `findUnquotedVarRefs`
 * tracks single/double-quote state character by character (a `$` inside
 * either quote style is never flagged: double-quoted still expands but is
 * immune to word splitting, single-quoted does not even expand), which is
 * enough to catch the common case without attempting full POSIX shell
 * grammar.
 *
 * Scoped to shell form only (`spawnFormFor(command) === "shell"`): exec
 * form's `args` are passed to the child process directly, with no shell
 * involved at all, so there is no word-splitting/glob-expansion risk to flag
 * there in the first place.
 */

import { spawnFormFor } from "../commandProbe.js";
import type { Finding, LintContext, LintRule } from "../types.js";

const VAR_REF = /^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/;

/** Every `$VAR`/`${VAR}` reference in `command` that sits outside both single and double quotes. */
export function findUnquotedVarRefs(command: string): readonly string[] {
  const refs: string[] = [];
  let quote: '"' | "'" | undefined;
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
      i += 1;
      continue;
    }
    if (quote !== undefined && char === quote) {
      quote = undefined;
      i += 1;
      continue;
    }
    if (quote === undefined && char === "$") {
      const match = VAR_REF.exec(command.slice(i));
      if (match !== null) {
        refs.push(match[0]);
        i += match[0].length;
        continue;
      }
    }
    i += 1;
  }
  return refs;
}

export const unquotedVarRule: LintRule = {
  id: "unquoted-var",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const command of ctx.commands) {
      if (spawnFormFor(command) !== "shell") {
        continue;
      }
      const refs = findUnquotedVarRefs(command.command);
      if (refs.length === 0) {
        continue;
      }

      const uniqueRefs = [...new Set(refs)];
      const names = uniqueRefs.map((ref) => `"${ref}"`).join(", ");
      // uniqueRefs is non-empty here (refs.length === 0 already returned
      // above), but noUncheckedIndexedAccess still types the read as
      // possibly undefined — the fallback is unreachable, not a real default.
      const firstRef = uniqueRefs[0] ?? refs[0] ?? "$VAR";
      findings.push({
        file: command.file,
        line: command.line,
        ruleId: "unquoted-var",
        message:
          `The "${command.event}" hook's command runs through shell form and ` +
          `references ${uniqueRefs.length === 1 ? "an unquoted variable" : "unquoted variables"} ` +
          `(${names}) outside any quotes. An unquoted shell variable is subject to ` +
          "word splitting and glob expansion, which can turn one argument into " +
          "several or match unintended files.",
        suggestion: `Wrap each reference in double quotes, e.g. change ${firstRef} to "${firstRef}".`,
      });
    }
    return findings;
  },
};
