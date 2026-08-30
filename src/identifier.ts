import { InvalidInputError } from "./errors.js";
import { assertPositiveInteger } from "./internal/assert.js";

/**
 * Options for {@link normalizeIdentifier}.
 *
 * @public
 */
export interface NormalizeIdentifierOptions {
  /**
   * One URL-unreserved, filename-safe punctuation character used to join
   * retained runs: `-`, `_`, `.`, or `~`.
   *
   * @defaultValue `"-"`
   */
  readonly separator?: string;

  /**
   * Maximum length of the returned identifier.
   *
   * @remarks
   * Truncation happens after normalization, and a separator left at the cut
   * point is removed, so the result never ends with the separator.
   *
   * @defaultValue unlimited
   */
  readonly maxLength?: number;

  /**
   * Whether to lowercase the result.
   *
   * @defaultValue `true`
   */
  readonly lowercase?: boolean;
}

const DEFAULT_SEPARATOR = "-";
const UNSAFE_RUN = /[^A-Za-z0-9]+/g;
const SAFE_SEPARATORS = new Set(["-", "_", ".", "~"]);

/**
 * Remove the separator from both ends of a value.
 *
 * @remarks
 * Written as an index walk rather than a regular expression because the
 * separator is caller-supplied and may be a regex metacharacter such as `.`.
 */
function trimSeparator(value: string, separator: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === separator) {
    start += 1;
  }
  while (end > start && value[end - 1] === separator) {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * Convert arbitrary text into a URL- and cross-platform filename-safe ASCII
 * identifier.
 *
 * @remarks
 * Every run of characters outside `[A-Za-z0-9]` collapses into one separator,
 * which means non-ASCII letters are replaced rather than transliterated:
 * `"café"` becomes `"caf"`, not `"cafe"`. If you need transliteration, do it
 * before calling this function.
 *
 * The result always starts and ends with an alphanumeric character.
 *
 * @param input - Text to normalize. Surrounding whitespace is ignored.
 * @param options - See {@link NormalizeIdentifierOptions}.
 * @returns The normalized identifier, never empty.
 * @throws InvalidInputError when `input` holds no ASCII letter or digit, or
 * when an option is out of range.
 *
 * @example
 * ```ts
 * normalizeIdentifier("Hello World"); // "hello-world"
 * normalizeIdentifier("Hello World", { separator: "_" }); // "hello_world"
 * ```
 *
 * @public
 */
export function normalizeIdentifier(
  input: string,
  options: NormalizeIdentifierOptions = {},
): string {
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  if (!SAFE_SEPARATORS.has(separator)) {
    throw new InvalidInputError(
      "options.separator",
      "options.separator must be one of: -, _, ., ~.",
    );
  }

  const { maxLength } = options;
  if (maxLength !== undefined) {
    assertPositiveInteger(maxLength, "options.maxLength");
  }

  const trimmed = input.trim();
  if (trimmed === "") {
    throw new InvalidInputError("input", "input must not be empty or whitespace only.");
  }

  const collapsed = trimSeparator(trimmed.replace(UNSAFE_RUN, separator), separator);
  if (collapsed === "") {
    throw new InvalidInputError(
      "input",
      "input must contain at least one ASCII letter or digit.",
    );
  }

  const cased = (options.lowercase ?? true) ? collapsed.toLowerCase() : collapsed;
  if (maxLength === undefined || cased.length <= maxLength) {
    return cased;
  }
  // The first character is always alphanumeric, so trimming the cut point can
  // never empty the string.
  return trimSeparator(cased.slice(0, maxLength), separator);
}
