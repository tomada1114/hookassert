/**
 * Internal plumbing types for the lint rule framework.
 *
 * @remarks
 * `Finding`, `LintRule`, `LintContext` and friends are not part of the
 * published contract: `src/index.ts` re-exports only `src/types.ts`'s
 * vocabulary, and ESLint's `public-api/internal-stays-private` block forbids
 * `src/index.ts` from importing anything under `src/internal/` at all, so
 * nothing declared here can leak into the public surface by accident. They
 * live next to the modules that use them rather than in `src/types.ts`,
 * which is reserved for the vocabulary every module speaks — this one is
 * spoken only by `src/internal/lint/**`.
 */

import type { EventName, SettingsLayer } from "../../types.js";
import type { Spec } from "../spec/index.js";
import type { VersionContext } from "../matcher/index.js";

/**
 * One lint violation, ready to render.
 *
 * @remarks
 * `file`, `line`, `ruleId`, and `suggestion` are all required — never
 * optional — a hard acceptance criterion of the issue this type was built
 * for: a `Finding` a reader cannot locate (`file`/`line`), cannot attribute
 * to a rule (`ruleId`), or that offers no concrete fix (`suggestion`) is not
 * useful enough to be worth reporting at all.
 */
export interface Finding {
  /** Absolute path of the settings file the finding is about. */
  readonly file: string;

  /** 1-based line the finding points at. */
  readonly line: number;

  /** The `LintRule.id` that produced this finding. */
  readonly ruleId: string;

  /** Human-readable explanation of what is wrong. */
  readonly message: string;

  /**
   * A concrete fix: the corrected matcher string or config change for this
   * specific finding, not a restatement of `message`.
   */
  readonly suggestion: string;
}

/** One matcher declaration a `LintRule` can inspect. */
export type LintMatcherValue =
  | { readonly kind: "absent" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly string[] };

/**
 * One `hooks.<event>[]` matcher group, read tolerantly from a settings file.
 *
 * @remarks
 * Unlike `settings/load.ts`'s `loadSourceHooks`, reading this never throws
 * because a `matcher` is a JSON array rather than a string — that is exactly
 * the shape `matcher-is-array` exists to report as a `Finding` instead of a
 * thrown `SettingsParseError`. See `parse.ts`'s own remarks for why the
 * strict loader cannot be reused for this.
 */
export interface LintMatcherGroup {
  /** Absolute path of the settings file this group was declared in. */
  readonly file: string;

  /** Which merged layer {@link LintMatcherGroup.file} belongs to. */
  readonly layer: SettingsLayer;

  /** The event this matcher group is declared under. */
  readonly event: EventName;

  /** 1-based line of this group's `matcher` property, or the group itself when no `matcher` is declared. */
  readonly line: number;

  /** This group's own `matcher` value, read tolerantly. */
  readonly matcher: LintMatcherValue;
}

/** What a `LintRule` reads from, to run over every settings source `lint` discovered. */
export interface LintContext {
  /** The loaded hooks spec every rule classifies matchers against. */
  readonly spec: Spec;

  /** The Claude Code version this lint run assumes, or the fact that none could be determined. */
  readonly versionContext: VersionContext;

  /** Every matcher group read from every settings source, across every layer. */
  readonly groups: readonly LintMatcherGroup[];
}

/**
 * One static check over a `LintContext`.
 *
 * @remarks
 * `run` never spawns a process and never writes a file — `lint` is a
 * zero-execution static check, structurally guaranteed by `#2`'s ESLint
 * zone (`src/internal/lint/**` cannot import `exec/`/`record/`), not merely
 * by convention.
 */
export interface LintRule {
  /** Stable id, unchanged across non-breaking releases — the value `Finding.ruleId` carries for every finding this rule produces. */
  readonly id: string;

  /** Run this rule over `ctx`, returning every finding — an empty array when there is nothing to report. */
  run(ctx: LintContext): readonly Finding[];
}
