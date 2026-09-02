/**
 * Screens a matcher pattern for the one construct that makes
 * `new RegExp(pattern).test(target)` backtrack exponentially: an unbounded
 * quantifier (`*`, `+`, `{n,}`) applied to a group that itself contains an
 * unbounded quantifier — `(a+)+`, `(a*)*`, `((ab)*)*`.
 *
 * @remarks
 * Static layer: a pure string scan, no compilation, no I/O. `matcher/` is
 * safe to run over any settings tree — see `AGENTS.md`'s architecture
 * section — and the usual remedy for a runaway regex, evaluating it in a
 * worker or child process under a timeout, is unavailable here: this module
 * may not spawn, and `matchHooks` is synchronous. Screening the pattern
 * before it is ever compiled is the only option left, so
 * {@link findCatastrophicConstruct} is consulted before `classify.ts` ever
 * reaches for `new RegExp(matcher)`.
 *
 * The scan tracks three things in a single left-to-right pass: escape pairs
 * (`\x`, so an escaped `(` or `)` is a literal character, never a group
 * boundary), character classes (`[...]`, whose contents — including a
 * literal `(`, `)`, or `+` — are never parsed as their own constructs), and
 * a stack of open groups. Each open group remembers whether anything
 * scanned inside it (a literal, a character class, or a nested group) was
 * itself given an unbounded quantifier. When a group closes and is
 * *itself* immediately followed by an unbounded quantifier, that memory is
 * exactly the answer to "does this group contain an unbounded quantifier
 * inside it" — no backtracking, no automaton, one pass.
 *
 * Deliberately conservative in two directions:
 *
 * - **Ambiguous alternation with no nested quantifier** (`(a|aa)+$`,
 *   `(x|x)*y`) is out of scope. It is polynomial at the lengths a tool name
 *   or field value reaches, and telling it apart from a harmless
 *   alternation like `(Bash|Edit)+` needs an automaton analysis this
 *   repository will not carry — see the issue this module was built for.
 * - A `|` inside a group does not reset the group's own "contains an
 *   unbounded quantifier" memory: `(a+|b)+` is flagged even though only one
 *   branch is dangerous, because a matcher that is safe on every branch
 *   but one is still a hang waiting for the right target string. A false
 *   positive here costs an `"unknown"` classification with a reason and a
 *   lint suggestion; a false negative costs a hang.
 *
 * Never asked whether `pattern` is a syntactically valid `RegExp` — an
 * unbalanced paren or bracket is `match.ts`'s and `lint`'s own concern, not
 * this scan's. An unmatched `)` is treated as an ordinary character so the
 * scan always terminates instead of throwing on a malformed pattern.
 */

/** One currently open group: where it started, and whether an unbounded quantifier has been seen anywhere directly inside it. */
interface GroupFrame {
  readonly start: number;
  hasInnerUnbounded: boolean;
}

/** Whether a quantifier starts at `pattern[index]`, and — when it does — where it ends and whether it is unbounded. */
interface QuantifierMatch {
  readonly end: number;
  readonly unbounded: boolean;
}

const BRACE_QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;

/**
 * The quantifier (if any) starting at `pattern[index]` — `*`, `+`, `?`, or a
 * `{...}` repetition, each optionally followed by the lazy-modifier `?`.
 *
 * @remarks
 * `?` alone is bounded (0 or 1): it never contributes to catastrophic
 * backtracking on its own. `{n}` and `{n,m}` are bounded (a fixed or capped
 * repeat count); only `{n,}` — a comma with no upper bound — is unbounded,
 * the same as `*` and `+`. A `{` that is not a well-formed repetition
 * (`{foo}`, an unclosed `{2,`) is not a quantifier at all under `RegExp`
 * semantics — it is a literal `{` — so `undefined` is returned and the
 * caller treats it as an ordinary character with no quantifier attached.
 */
function matchQuantifier(pattern: string, index: number): QuantifierMatch | undefined {
  const char = pattern[index];

  if (char === "*" || char === "+") {
    const lazy = pattern[index + 1] === "?";
    return { end: index + (lazy ? 2 : 1), unbounded: true };
  }

  if (char === "?") {
    const lazy = pattern[index + 1] === "?";
    return { end: index + (lazy ? 2 : 1), unbounded: false };
  }

  if (char === "{") {
    const match = BRACE_QUANTIFIER.exec(pattern.slice(index));
    const whole = match?.[0];
    if (whole === undefined) {
      return undefined;
    }
    const comma = match?.[2];
    const max = match?.[3];
    const braceEnd = index + whole.length;
    const lazy = pattern[braceEnd] === "?";
    const unbounded = comma !== undefined && (max === undefined || max.length === 0);
    return { end: lazy ? braceEnd + 1 : braceEnd, unbounded };
  }

  return undefined;
}

/** The index just past the `[...]` character class starting at `pattern[start]`. */
function findClassEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === "^") {
    i += 1;
  }
  // A `]` immediately after `[` or `[^` is a literal member of the class,
  // not its closing bracket.
  if (pattern[i] === "]") {
    i += 1;
  }
  while (i < pattern.length && pattern[i] !== "]") {
    i += pattern[i] === "\\" ? 2 : 1;
  }
  return i < pattern.length ? i + 1 : i;
}

/**
 * Consume the quantifier (if any) at `pattern[index]`, marking `stack`'s
 * innermost open group as containing an unbounded quantifier when it is
 * one. Returns the index just past the quantifier, or `index` unchanged
 * when there is none.
 */
function applyQuantifier(
  pattern: string,
  index: number,
  stack: readonly GroupFrame[],
): number {
  const quantifier = matchQuantifier(pattern, index);
  if (quantifier === undefined) {
    return index;
  }
  if (quantifier.unbounded) {
    const enclosing = stack[stack.length - 1];
    if (enclosing !== undefined) {
      enclosing.hasInnerUnbounded = true;
    }
  }
  return quantifier.end;
}

/**
 * The first nested unbounded quantifier in `pattern`, described for a
 * human, or `undefined` when none is found.
 *
 * @remarks
 * See this file's own remarks for the scan's design and its deliberate
 * scope limits. The returned description names the offset the flagged
 * group starts at and quotes the group plus the quantifier that makes it
 * dangerous, e.g. `nested unbounded quantifier at offset 4: "(a+)+"` for a
 * pattern such as `"^abc(a+)+$"`.
 */
export function findCatastrophicConstruct(pattern: string): string | undefined {
  const stack: GroupFrame[] = [];
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "\\") {
      i = applyQuantifier(pattern, i + 2, stack);
      continue;
    }

    if (char === "[") {
      i = applyQuantifier(pattern, findClassEnd(pattern, i), stack);
      continue;
    }

    if (char === "(") {
      stack.push({ start: i, hasInnerUnbounded: false });
      i += 1;
      continue;
    }

    if (char === ")") {
      const frame = stack.pop();
      const afterGroup = i + 1;
      if (frame === undefined) {
        // Unmatched closing paren in a pattern this scan never assumes is
        // valid `RegExp` syntax — treat it as an ordinary character rather
        // than throwing.
        i = applyQuantifier(pattern, afterGroup, stack);
        continue;
      }

      const quantifier = matchQuantifier(pattern, afterGroup);
      if (quantifier === undefined) {
        i = afterGroup;
        continue;
      }

      if (quantifier.unbounded && frame.hasInnerUnbounded) {
        const construct = pattern.slice(frame.start, quantifier.end);
        return `nested unbounded quantifier at offset ${String(frame.start)}: ${JSON.stringify(construct)}`;
      }

      if (quantifier.unbounded) {
        const enclosing = stack[stack.length - 1];
        if (enclosing !== undefined) {
          enclosing.hasInnerUnbounded = true;
        }
      }
      i = quantifier.end;
      continue;
    }

    if (char === "|") {
      i += 1;
      continue;
    }

    // An ordinary literal atom (or a bare, unattached quantifier character
    // in a pattern this scan never assumes compiles) — check for a
    // quantifier right after it, the same as every other atom kind above.
    i = applyQuantifier(pattern, i + 1, stack);
  }

  return undefined;
}
