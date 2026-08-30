// Narrowing helpers for values that arrive as `unknown` from `JSON.parse`.
//
// `noPropertyAccessFromIndexSignature` (tsconfig) and `dot-notation` (typed
// lint) disagree about how to read a literal key off a `Record`, so every read
// goes through a helper that takes the key as a value instead.

/**
 * Read one property off a value of unknown shape.
 *
 * @param {unknown} value - Candidate object.
 * @param {string} key - Property to read.
 * @returns {unknown} The property value, or undefined when absent.
 */
export function readKey(value, key) {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return /** @type {Record<string, unknown>} */ (value)[key];
}

/**
 * Read a property that must be a string.
 *
 * @param {unknown} value - Candidate object.
 * @param {string} key - Property to read.
 * @returns {string | undefined} The string, or undefined when absent or of
 * another type.
 */
export function readString(value, key) {
  const read = readKey(value, key);
  return typeof read === "string" ? read : undefined;
}

/**
 * Parse JSON text without widening the result to `any`.
 *
 * @param {string} text - JSON document.
 * @returns {unknown} The parsed value, for the caller to narrow.
 */
export function parseJson(text) {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  return parsed;
}
