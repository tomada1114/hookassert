/**
 * Resolves a `ResolvedHook[]` plus an event/target request into an ordered
 * firing set, and a `MatcherOutcome` for every hook that did not fire.
 *
 * @remarks
 * Static layer: pure — no I/O, no process, no write. Classification itself
 * is `classify.ts`'s job; this module only decides, given a classification,
 * whether a specific `target` actually matches, and phrases why one that did
 * not fire was rejected.
 */

import type { ResolvedHook } from "../../types.js";
import type { Spec } from "../spec/index.js";
import { classifyMatcherDetailed } from "./classify.js";
import type {
  MatcherOutcome,
  MatchRequest,
  MatchResult,
  VersionContext,
} from "./types.js";

/** Split an exact-match list matcher into its trimmed, non-empty items. */
function exactListItems(matcher: string): readonly string[] {
  return matcher
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Test `matcher` as an unanchored regular expression against `target`.
 *
 * @remarks
 * `"*"` is Claude Code's documented "match everything" wildcard and is
 * handled before ever attempting to compile it: `new RegExp("*")` throws
 * `SyntaxError: Nothing to repeat`, which the `catch` below would otherwise
 * swallow into a false non-match, silently disabling every hook a settings
 * file declares `"matcher": "*"` for.
 *
 * Beyond that one case, a matcher classified as `"unanchored-regex"` is not
 * guaranteed to be a syntactically valid `RegExp` (unbalanced parentheses,
 * for example) — a hook declaration is user-authored settings content, not
 * something this static layer validated on the way in. Treating a
 * construction failure as "did not match" keeps one bad declaration from
 * aborting every other hook's evaluation; `lint-matcher`'s later issue is
 * where that gets surfaced as a finding instead of swallowed here.
 */
function testUnanchoredRegex(matcher: string, target: string): boolean {
  if (matcher === "*") {
    return true;
  }
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return false;
  }
}

function unknownOutcome(hook: ResolvedHook, reason: string): MatcherOutcome {
  return { hook, kind: "unknown", reason };
}

function exactListOutcome(
  hook: ResolvedHook,
  target: string | undefined,
): MatcherOutcome {
  return {
    hook,
    kind: "exact-list",
    reason: `evaluated as an exact-match list and did not match ${target ?? "<no target>"}`,
  };
}

function unanchoredRegexOutcome(hook: ResolvedHook): MatcherOutcome {
  return {
    hook,
    kind: "unanchored-regex",
    reason: "evaluated as an unanchored regex and did not match",
  };
}

/**
 * Resolve `req`'s firing set: which of `req.hooks` fire for `req.event`
 * against `req.target`, and a {@link MatcherOutcome} explaining every one
 * that did not.
 *
 * @remarks
 * A hook with no declared matcher (`hook.matcher === undefined`) always
 * fires — an absent matcher is Claude Code's own "match everything"
 * shorthand, independent of `spec.events[event].matcherTargets`.
 *
 * When `req.event`'s `matcherTargets.kind` is `"none"`, every hook fires
 * regardless of what it declares as `matcher` — Claude Code silently
 * ignores a matcher there. Such a hook is still listed in
 * {@link MatchResult.matcherIgnored} so a reporter can say the matcher had
 * no effect, rather than pretending it was never declared.
 */
export function matchHooks(
  spec: Spec,
  v: VersionContext,
  req: MatchRequest,
): MatchResult {
  const firing: ResolvedHook[] = [];
  const rejected: MatcherOutcome[] = [];
  const matcherIgnored: ResolvedHook[] = [];

  for (const hook of req.hooks) {
    if (hook.event !== req.event) {
      continue;
    }

    if (hook.matcher === undefined) {
      firing.push(hook);
      continue;
    }

    const matcher = hook.matcher;

    if (spec.events[req.event]?.matcherTargets.kind === "none") {
      firing.push(hook);
      matcherIgnored.push(hook);
      continue;
    }

    const result = classifyMatcherDetailed(spec, v, req.event, matcher);

    switch (result.kind) {
      case "unknown": {
        rejected.push(unknownOutcome(hook, result.reason));
        break;
      }
      case "exact-list": {
        if (req.target !== undefined && exactListItems(matcher).includes(req.target)) {
          firing.push(hook);
        } else {
          rejected.push(exactListOutcome(hook, req.target));
        }
        break;
      }
      case "unanchored-regex": {
        if (req.target !== undefined && testUnanchoredRegex(matcher, req.target)) {
          firing.push(hook);
        } else {
          rejected.push(unanchoredRegexOutcome(hook));
        }
        break;
      }
    }
  }

  return { firing, rejected, matcherIgnored };
}
