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

import type { EventName, ResolvedHook } from "../../types.js";
import type { Spec } from "../spec/index.js";
import { classifyMatcher } from "./classify.js";
import type {
  MatcherKind,
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
 * A matcher classified as `"unanchored-regex"` is not guaranteed to be a
 * syntactically valid `RegExp` (unbalanced parentheses, for example) — a
 * hook declaration is user-authored settings content, not something this
 * static layer validated on the way in. Treating a construction failure as
 * "did not match" keeps one bad declaration from aborting every other
 * hook's evaluation; `lint-matcher`'s later issue is where that gets
 * surfaced as a finding instead of swallowed here.
 */
function testUnanchoredRegex(matcher: string, target: string): boolean {
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return false;
  }
}

function unsupportedOutcome(event: EventName, hook: ResolvedHook): MatcherOutcome {
  return {
    hook,
    kind: "unsupported",
    reason: `the ${event} event's matcherTargets.kind is "none": hooks may not declare a matcher for this event`,
  };
}

function unknownOutcome(hook: ResolvedHook): MatcherOutcome {
  return {
    hook,
    kind: "unknown",
    reason:
      "the matcher's classification could not be determined with confidence: the detected Claude Code version is undetermined, outside spec.claudeCodeRange, or below a version-gated notation rule's sinceVersion",
  };
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
 */
export function matchHooks(
  spec: Spec,
  v: VersionContext,
  req: MatchRequest,
): MatchResult {
  const firing: ResolvedHook[] = [];
  const rejected: MatcherOutcome[] = [];

  for (const hook of req.hooks) {
    if (hook.event !== req.event) {
      continue;
    }

    if (hook.matcher === undefined) {
      firing.push(hook);
      continue;
    }

    const matcher = hook.matcher;
    const kind: MatcherKind = classifyMatcher(spec, v, req.event, matcher);

    switch (kind) {
      case "unsupported": {
        rejected.push(unsupportedOutcome(req.event, hook));
        break;
      }
      case "unknown": {
        rejected.push(unknownOutcome(hook));
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

  return { firing, rejected };
}
