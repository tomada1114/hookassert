/**
 * Internal plumbing types for the versioned hooks spec.
 *
 * @remarks
 * `Spec` and everything it is built from are not part of the published
 * contract: `src/index.ts` re-exports only `src/types.ts`'s vocabulary, and
 * ESLint's `public-api/internal-stays-private` block forbids `src/index.ts`
 * from importing anything under `src/internal/` at all, so nothing declared
 * here can leak into the public surface by accident. They live next to the
 * modules that use them rather than in `src/types.ts`, which is reserved for
 * the vocabulary every module speaks — this one is spoken only by
 * `src/internal/spec/**`.
 */

/**
 * What field of a hook event's JSON input a matcher is tested against, and
 * how.
 *
 * @remarks
 * `"none"` — the event has no matcher support at all, and a `matcher` field
 * on one of its hook declarations is silently ignored.
 * `"tool-name"` — the matcher is tested against `tool_name`.
 * `"enum"` — the matcher is tested against a named field whose documented
 * values are a closed, fixed set (for example `SessionStart`'s `source`).
 * `"field"` — the matcher is tested against a named field whose values are
 * open-ended (for example `Elicitation`'s `mcp_server_name`), so there is no
 * fixed list to enumerate.
 */
export type MatcherTargets =
  | { readonly kind: "none" }
  | { readonly kind: "tool-name" }
  | {
      readonly kind: "enum";
      readonly field: string;
      readonly values: readonly string[];
    }
  | { readonly kind: "field"; readonly field: string };

/** What an exit code does to the action a hook ran against. */
export type ExitCodeEffectKind = "block" | "non-blocking-error" | "ignored";

/** Who, if anyone, sees a hook's stderr for a given exit code. */
export type StderrDestination = "claude" | "user" | "debug-log" | "ignored";

/** One exit code's documented effect for a single event. */
export interface ExitCodeEffect {
  readonly exitCode: number;
  readonly effect: ExitCodeEffectKind;
  readonly stderrTo: StderrDestination;
}

/**
 * Whether an event's documented JSON payload shape has been verified against
 * a running Claude Code instance.
 *
 * @remarks
 * `verified` starts `false` for every event this issue transcribes. It only
 * ever flips to `true` through the `conformance` issue's reviewed process.
 */
export interface PayloadShape {
  readonly verified: boolean;
  readonly verifiedAt: string | undefined;
  readonly againstVersion: string | undefined;
  readonly requiredKeys: readonly string[];
}

/** One officially documented hook event's contract. */
export interface EventSpec {
  readonly matcherTargets: MatcherTargets;
  readonly blockable: boolean;
  readonly honorsExit2: boolean;
  readonly jsonDecisions: readonly string[];
  readonly exitCodeEffects: readonly ExitCodeEffect[];
  readonly payloadShape: PayloadShape;
}

/** One version-gated matcher syntax rule, such as comma-separated lists. */
export interface MatcherRule {
  readonly id: string;
  readonly sinceVersion: string;
}

/** The matcher notation Claude Code accepts, and since which version. */
export interface MatcherSyntax {
  readonly caseSensitive: boolean;
  readonly exactListPattern: string;
  readonly narrowExactMatchEvents: readonly string[];
  readonly narrowExactListPattern: string;
  readonly rules: readonly MatcherRule[];
}

/** Hook timeout defaults, production-side. */
export interface SpecDefaults {
  readonly hookTimeoutMs: number;
  readonly promptHookTimeoutMs: number;
  readonly agentHookTimeoutMs: number;
  readonly reducedTimeoutMs: Readonly<Record<string, number>>;
}

/** Environment variables Claude Code provides to every hook. */
export interface HookEnv {
  readonly provided: readonly string[];
}

/** One worked matcher example: a matcher string and what it does/doesn't match. */
export interface MatcherTableRow {
  readonly event: string;
  readonly matcher: string;
  readonly matches: readonly string[];
  readonly doesNotMatch: readonly string[];
  readonly sinceVersion: string | null;
}

/** The whole versioned hooks spec, as `schema/spec.schema.json` shapes it. */
export interface Spec {
  readonly specVersion: string;
  readonly claudeCodeRange: string;
  readonly defaults: SpecDefaults;
  readonly hookEnv: HookEnv;
  readonly matcherSyntax: MatcherSyntax;
  readonly knownTools: readonly string[];
  readonly events: Readonly<Record<string, EventSpec>>;
  readonly matcherTable: readonly MatcherTableRow[];
}
