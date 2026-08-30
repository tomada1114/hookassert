import { InvalidInputError } from "../errors.js";

/**
 * Reject anything that is not a whole number of at least one.
 *
 * @remarks
 * Internal helper: not re-exported from `src/index.ts`, so it is not part of
 * the published contract and may change without a version bump.
 *
 * @param value - The number to validate.
 * @param field - Dotted path used in the resulting error.
 * @throws InvalidInputError when `value` is fractional, non-finite, or below 1.
 */
export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidInputError(
      field,
      `${field} must be a whole number greater than 0, received ${String(value)}.`,
    );
  }
}

/**
 * Coerce an unknown rejection or abort reason into an `Error`.
 *
 * @remarks
 * Returns the value unchanged when it already is an `Error`, so callers keep
 * reference identity and can compare the rejection they observe with the one
 * they threw.
 *
 * @param reason - The value to coerce.
 * @param fallbackMessage - Message used when `reason` is not an `Error`.
 * @returns The original error, or a new one wrapping `reason` as its `cause`.
 */
export function asError(reason: unknown, fallbackMessage: string): Error {
  return reason instanceof Error
    ? reason
    : new Error(fallbackMessage, { cause: reason });
}
