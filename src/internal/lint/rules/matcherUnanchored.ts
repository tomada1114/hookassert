/**
 * `matcher-unanchored`: an unanchored regex matcher that over-matches beyond
 * the tool name it was probably meant to target.
 *
 * @remarks
 * Builds directly on `matcher/classify.ts`'s own `classifyMatcher` — this
 * issue is the first to build static analysis on top of that classification
 * rather than a live firing decision. `"*"` is excluded outright: it is
 * Claude Code's own documented "match everything" wildcard
 * (`matcher/match.ts`'s `testUnanchoredRegex` special-cases it the same
 * way), not a mistake to flag.
 *
 * The "probably meant to target" tool(s) are guessed two ways. When
 * `matcher`'s top-level alternation branches (`"Bash"`/`"Edit"` in
 * `"^(Bash|Edit)$"` or `"(Edit|Write)"`) are all plain literals, every
 * branch is treated as intended — that is what makes a correctly anchored
 * alternation such as `"^(Bash|Edit)$"` produce no finding at all (it
 * matches only its own branches, all of them intended) while an unanchored
 * one such as `"(Edit|Write)"` still reports only the genuine over-match
 * (`"NotebookEdit"`), not the two tools it was written for. Otherwise the
 * guess falls back to the matcher's own literal prefix — the characters
 * before its first regex metacharacter, with a leading `^` anchor stripped
 * first so an already-anchored, single-match pattern (`"^Edit$"`) is never
 * flagged (it matches at most one known tool, which is gated out before the
 * prefix guess is even consulted). When two or more known tools match and
 * none of the guessed intended targets equal them exactly, every such match
 * is reported as unintended — there is no single obvious target to exclude.
 */

import { classifyMatcher } from "../../matcher/index.js";
import type { Finding, LintContext, LintRule } from "../types.js";
import { isToolNameEvent } from "../shared.js";

const REGEX_METACHARACTER = /[.*+?^${}()|[\]\\]/;

/** The literal characters before `matcher`'s first regex metacharacter, with a leading `^` anchor stripped. */
function literalPrefix(matcher: string): string {
  const stripped = matcher.startsWith("^") ? matcher.slice(1) : matcher;
  const metaIndex = stripped.search(REGEX_METACHARACTER);
  return metaIndex === -1 ? stripped : stripped.slice(0, metaIndex);
}

const LITERAL_BRANCH = /^[A-Za-z0-9_\- ]+$/;

/** `body` with one layer of wrapping group parens removed, when `body` is entirely one group. */
function stripWrappingGroup(body: string): string {
  if (!body.startsWith("(") || !body.endsWith(")")) {
    return body;
  }
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === undefined) {
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0 && i !== body.length - 1) {
        // The first group closes before the string ends — not a single
        // wrapping group (e.g. "(Edit)|(Write)").
        return body;
      }
    }
  }
  const inner = body.slice(1, -1);
  return inner.startsWith("?:") ? inner.slice(2) : inner;
}

/** Split `body` on `|` at nesting depth 0, so a `|` inside a group is not treated as a top-level branch boundary. */
function splitTopLevel(body: string): readonly string[] {
  const branches: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === undefined) {
      continue;
    }
    const next = body[i + 1];
    if (char === "\\" && next !== undefined) {
      current += char + next;
      i += 1;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
    }
    if (char === "|" && depth === 0) {
      branches.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  branches.push(current);
  return branches;
}

/**
 * `matcher`'s top-level alternation branches — `["Bash", "Edit"]` for both
 * `"^(Bash|Edit)$"` and `"(Edit|Write)"` — when every branch is a plain
 * literal with no further regex metacharacter. `undefined` when `matcher`
 * has no top-level `|` at all, or when a branch is not a plain literal, so
 * the caller falls back to {@link literalPrefix}.
 */
function alternationBranches(matcher: string): readonly string[] | undefined {
  let body = matcher;
  if (body.startsWith("^")) {
    body = body.slice(1);
  }
  if (body.endsWith("$")) {
    body = body.slice(0, -1);
  }
  body = stripWrappingGroup(body);

  const branches = splitTopLevel(body);
  if (
    branches.length <= 1 ||
    !branches.every((branch) => LITERAL_BRANCH.test(branch))
  ) {
    return undefined;
  }
  return branches;
}

/**
 * `new RegExp(matcher, caseSensitive ? undefined : "i").test(tool)`, mirroring
 * `matcher/match.ts`'s own `testUnanchoredRegex` — including its tolerance
 * for `"*"` and an uncompilable pattern, and its `"i"` flag when
 * `spec.matcherSyntax.caseSensitive` is `false`.
 */
function testRegexSafe(matcher: string, tool: string, caseSensitive: boolean): boolean {
  if (matcher === "*") {
    return true;
  }
  try {
    return new RegExp(matcher, caseSensitive ? undefined : "i").test(tool);
  } catch {
    return false;
  }
}

/** Whether `items` contains `tool`, honoring `spec.matcherSyntax.caseSensitive` the same way `matcher/match.ts`'s `exactListIncludes` does. */
function includesTool(
  items: readonly string[],
  tool: string,
  caseSensitive: boolean,
): boolean {
  if (caseSensitive) {
    return items.includes(tool);
  }
  const lowerTool = tool.toLowerCase();
  return items.some((item) => item.toLowerCase() === lowerTool);
}

export const matcherUnanchoredRule: LintRule = {
  id: "matcher-unanchored",

  run(ctx: LintContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const group of ctx.groups) {
      if (group.matcher.kind !== "string") {
        continue;
      }
      if (!isToolNameEvent(ctx.spec, group.event)) {
        continue;
      }
      const matcher = group.matcher.value;
      if (matcher === "*") {
        continue;
      }
      const kind = classifyMatcher(ctx.spec, ctx.versionContext, group.event, matcher);
      if (kind !== "unanchored-regex") {
        continue;
      }

      const caseSensitive = ctx.spec.matcherSyntax.caseSensitive;
      const matched = ctx.spec.knownTools.filter((tool) =>
        testRegexSafe(matcher, tool, caseSensitive),
      );
      if (matched.length <= 1) {
        continue;
      }
      const branches = alternationBranches(matcher);
      const intended = branches ?? [literalPrefix(matcher)];
      const unintended = matched.filter(
        (tool) => !includesTool(intended, tool, caseSensitive),
      );
      if (unintended.length === 0) {
        continue;
      }

      const names = unintended.map((tool) => `"${tool}"`).join(", ");
      const anchoredBody = matcher.replace(/^\^/, "").replace(/\$$/, "");
      findings.push({
        file: group.file,
        line: group.line,
        ruleId: "matcher-unanchored",
        message:
          `Matcher "${matcher}" is an unanchored regex and also matches ${names}, ` +
          "beyond the tool it was probably meant to target.",
        suggestion:
          `Anchor the pattern, e.g. "^(?:${anchoredBody})$", or use an ` +
          "exact-match list naming only the intended tool(s).",
      });
    }
    return findings;
  },
};
