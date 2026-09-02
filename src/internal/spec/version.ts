/**
 * Semver-lite comparison for Claude Code's own version numbers.
 *
 * @remarks
 * Static layer: pure parsing and comparison, no I/O. Hand-written rather than
 * a `semver` dependency, per this repository's dependency-minimization stance
 * (see `managing-dependencies`) — Claude Code versions are plain
 * `major.minor.patch`, with no prerelease or build metadata to model, and
 * `claudeCodeRange` is a small space-separated list of comparator clauses
 * rather than the full npm range grammar.
 */

import type { Spec } from "./types.js";

/** A parsed `major.minor.patch` Claude Code version. */
export interface ClaudeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * An alias for `RegExp`, used only to annotate {@link CLAUDE_VERSION_PATTERN} and
 * {@link CLAUDE_CODE_RANGE_PATTERN}.
 *
 * @remarks
 * `tsconfig.build.json`'s `isolatedDeclarations` requires an explicit type on an
 * exported `RegExp` constant, but `@typescript-eslint/no-inferrable-types` then
 * rejects that exact annotation as redundant — the two gates disagree on a literal
 * `: RegExp`. Annotating with this structurally-identical alias instead satisfies
 * both: `no-inferrable-types` only matches the literal `RegExp` keyword, so an
 * alias is not "trivially inferred" to it in the same way.
 */
type Pattern = RegExp;

/**
 * Matches a bare `major.minor.patch` Claude Code version — `parseClaudeVersion`'s
 * grammar, and a `MatcherRule.sinceVersion` / `MatcherTableRow.sinceVersion`'s.
 *
 * @remarks
 * The single source of truth for this grammar: `guards.ts` applies this pattern at
 * spec-load time, and `schema/spec.schema.json`'s matching `pattern` strings are
 * asserted (in `tests/spec.test.ts`) to be byte-identical to this pattern's `.source`.
 */
export const CLAUDE_VERSION_PATTERN: Pattern = /^\d+\.\d+\.\d+$/;

/**
 * Matches `claudeCodeRange`: a space-separated list of `(>=|<=|>|<|=)major.minor.patch`
 * comparator clauses — the only range grammar this package understands. The npm range
 * operators `^`, `~`, `x`, and `||` are deliberately unsupported; see this module's own
 * doc comment for why.
 *
 * @remarks
 * The single source of truth for this grammar — see {@link CLAUDE_VERSION_PATTERN}'s
 * remarks for how `guards.ts` and the schema stay in sync with it.
 */
export const CLAUDE_CODE_RANGE_PATTERN: Pattern =
  /^(>=|<=|>|<|=)\d+\.\d+\.\d+(?:\s+(>=|<=|>|<|=)\d+\.\d+\.\d+)*$/;

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a `major.minor.patch` string into a {@link ClaudeVersion}.
 *
 * @throws {TypeError} `version` is not a plain `major.minor.patch` string.
 */
export function parseClaudeVersion(version: string): ClaudeVersion {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) {
    throw new TypeError(`"${version}" is not a major.minor.patch Claude Code version`);
  }
  const [, majorText, minorText, patchText] = match;
  if (majorText === undefined || minorText === undefined || patchText === undefined) {
    throw new TypeError(`"${version}" is not a major.minor.patch Claude Code version`);
  }
  return {
    major: Number(majorText),
    minor: Number(minorText),
    patch: Number(patchText),
  };
}

function compareClaudeVersions(a: ClaudeVersion, b: ClaudeVersion): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

type Comparator = ">=" | ">" | "<=" | "<" | "=";

function isComparator(value: string): value is Comparator {
  return (
    value === ">=" || value === ">" || value === "<=" || value === "<" || value === "="
  );
}

interface RangeClause {
  readonly comparator: Comparator;
  readonly version: ClaudeVersion;
}

const RANGE_CLAUSE_PATTERN = /^(>=|<=|>|<|=)(\d+\.\d+\.\d+)$/;

function parseRange(range: string): readonly RangeClause[] {
  const trimmed = range.trim();
  if (!CLAUDE_CODE_RANGE_PATTERN.test(trimmed)) {
    throw new TypeError(
      `"${range}" is not a valid claudeCodeRange: expected a space-separated list of ` +
        `(>=|<=|>|<|=)major.minor.patch clauses`,
    );
  }
  return trimmed.split(/\s+/).map((clause) => {
    const match = RANGE_CLAUSE_PATTERN.exec(clause);
    if (match === null) {
      throw new TypeError(
        `"${clause}" is not a valid claudeCodeRange comparator clause`,
      );
    }
    const [, comparatorText, versionText] = match;
    if (
      comparatorText === undefined ||
      versionText === undefined ||
      !isComparator(comparatorText)
    ) {
      throw new TypeError(
        `"${clause}" is not a valid claudeCodeRange comparator clause`,
      );
    }
    return { comparator: comparatorText, version: parseClaudeVersion(versionText) };
  });
}

function satisfiesClause(version: ClaudeVersion, clause: RangeClause): boolean {
  const comparison = compareClaudeVersions(version, clause.version);
  switch (clause.comparator) {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    case "=":
      return comparison === 0;
  }
}

/**
 * Whether `version` satisfies `spec.claudeCodeRange` — every comparator
 * clause in the range, AND'd together.
 */
export function isInDeclaredRange(spec: Spec, version: ClaudeVersion): boolean {
  return parseRange(spec.claudeCodeRange).every((clause) =>
    satisfiesClause(version, clause),
  );
}

/**
 * Whether `version` is at or after `sinceVersion` — the gate a
 * `MatcherRule`'s own `sinceVersion` field expresses.
 */
export function meetsSinceVersion(
  version: ClaudeVersion,
  sinceVersion: string,
): boolean {
  return compareClaudeVersions(version, parseClaudeVersion(sinceVersion)) >= 0;
}
