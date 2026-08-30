/**
 * Internal plumbing types for the matcher engine.
 *
 * @remarks
 * `MatcherKind`, `MatchRequest`, `MatchResult` and friends are not part of
 * the published contract: `src/index.ts` re-exports only `src/types.ts`'s
 * vocabulary, and ESLint's `public-api/internal-stays-private` block forbids
 * `src/index.ts` from importing anything under `src/internal/` at all, so
 * nothing declared here can leak into the public surface by accident. They
 * live next to the modules that use them rather than in `src/types.ts`,
 * which is reserved for the vocabulary every module speaks — this one is
 * spoken only by `src/internal/matcher/**`.
 */

import type { EventName, ResolvedHook } from "../../types.js";
import type { ClaudeVersion } from "../spec/index.js";

/**
 * The detected Claude Code version for this run, or the fact that detection
 * failed.
 *
 * @remarks
 * A discriminated union rather than `ClaudeVersion | undefined` so a caller
 * has to name the "undetermined" case explicitly instead of forgetting to
 * check for `undefined`. Which flag, environment variable, probe, or last
 * recorded session produces this value is the `cli-explain` issue's
 * business; this module only consumes whichever `VersionContext` it is
 * given and never constructs one of its own.
 */
export type VersionContext =
  | { readonly kind: "known"; readonly version: ClaudeVersion }
  | { readonly kind: "undetermined" };

/**
 * How a matcher string was classified, or why it could not be classified
 * with confidence.
 *
 * @remarks
 * - `"exact-list"` — the matcher is a comma/pipe-delimited list of exact,
 *   case-sensitive values.
 * - `"unanchored-regex"` — the matcher is tested as `new RegExp(matcher)`
 *   with no implicit `^`/`$` added, so it can match a substring of a longer
 *   name (`"Edit.*"` matching `"NotebookEdit"` is the documented, real
 *   Claude Code behavior this reproduces, not a bug).
 * - `"unknown"` — classification could not be established with confidence:
 *   the event is missing from `spec.events`, the detected version is
 *   outside `spec.claudeCodeRange`, or the matcher relies on a
 *   version-gated notation (`spec.matcherSyntax.rules[].sinceVersion`) that
 *   the detected — or undetermined — version cannot be confirmed to
 *   support.
 *
 * There is no `"unsupported"` member: whether `event`'s `matcherTargets.kind`
 * is `"none"` is not a classification question. Claude Code silently ignores
 * a matcher on such an event and always runs the hook — `match.ts` decides
 * that before ever calling `classifyMatcher`, so this type only ever
 * describes an actual attempt to classify a matcher string.
 */
export type MatcherKind = "exact-list" | "unanchored-regex" | "unknown";

/**
 * {@link classifyMatcher}'s verdict, plus — only when `kind` is `"unknown"`
 * — the specific reason classification could not be established with
 * confidence.
 *
 * @remarks
 * A discriminated union rather than an optional `reason` field so a caller
 * cannot read a reason without first narrowing on `kind`, and so
 * `MatcherOutcome.reason` can name the actual cause instead of a fixed
 * string listing every possible one.
 */
export type ClassifyResult =
  | { readonly kind: "exact-list" }
  | { readonly kind: "unanchored-regex" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * One hook that did not end up in {@link MatchResult.firing}, and why.
 */
export interface MatcherOutcome {
  /** The hook that did not fire. */
  readonly hook: ResolvedHook;

  /** How its matcher was classified — or why it could not be. */
  readonly kind: MatcherKind;

  /** Human-readable explanation, naming the reason this specific hook did
   * not fire. */
  readonly reason: string;
}

/**
 * One event/target pair to resolve a firing set for.
 *
 * @remarks
 * `hooks` may be every hook a `ResolvedSettings` holds or just the ones
 * `hooksForEvent` already narrowed to `event` — `matchHooks` ignores any
 * hook whose own `.event` does not equal `event`, so passing the full set is
 * always safe.
 */
export interface MatchRequest {
  /** Event this request resolves a firing set for. */
  readonly event: EventName;

  /** Candidate hooks; hooks declared under a different event are ignored. */
  readonly hooks: readonly ResolvedHook[];

  /**
   * The value a matcher is tested against — a tool name, or whatever field
   * `spec.events[event].matcherTargets` names — or `undefined` when the
   * event provides no such value at runtime.
   */
  readonly target: string | undefined;
}

/** The firing set for one {@link MatchRequest}, and every rejection reason. */
export interface MatchResult {
  /** Hooks that fire, in `req.hooks`'s own order. */
  readonly firing: readonly ResolvedHook[];

  /** Every hook from `req.hooks` under `req.event` that did not fire. */
  readonly rejected: readonly MatcherOutcome[];

  /**
   * The subset of {@link MatchResult.firing} whose declared `matcher` was
   * ignored rather than evaluated, because `req.event`'s
   * `matcherTargets.kind` is `"none"` — Claude Code accepts no matcher
   * there and silently ignores one if a hook declares it, running the hook
   * regardless. Listed separately rather than folded silently into
   * `firing` so a reporter can say the matcher had no effect.
   */
  readonly matcherIgnored: readonly ResolvedHook[];
}
