---
name: designing-errors
description: >
  Covers the shape of a package error class and the vocabulary of its `code` string, for
  both `src/errors.ts`-style errors and `scripts/**` error codes such as `ERR_SMOKE_*`.
  Use when adding or changing an `Error` subclass, choosing or renaming an `ERR_*` code,
  deciding what a rejected-input error should carry, or wiring an `AbortSignal`
  rejection reason.
---

# Designing Errors

**Owns:** the shape of an error type and the vocabulary of `code` strings, in both
`src/**` and `scripts/**`. **Does not own:** general type-system judgment
(`writing-typescript`); how an error is asserted in a test (`writing-tests`); the stderr
message contract for repository automation (`writing-repo-scripts` — the `ERR_` prefix
rule below is shared with it, but the full message shape lives there).

## The one rule that matters

**`code` is the contract; `message` is not.** A caller branches on `code` because it is
a stable string literal that only changes across a breaking release. `message` is prose
for a human reading a log and may be reworded in a patch release. Never write a test, a
catch clause, or a script's own error handling that matches on `message` text — match on
`code`, or on the error's class via `instanceof`.

## Shape of an error class

- Subclass `Error`, set `this.name` to the class name in the constructor, and declare
  `readonly code` typed as a string literal (`"ERR_INVALID_INPUT" as const`) rather than
  as `string`. The literal type is what lets a consumer narrow on `code` and get a typed
  error back.
- Give it domain-specific `readonly` fields describing what was rejected — never the
  rejected value itself when it could hold sensitive input. State the shape, not the
  content: a length that was exceeded, a field path, an allowed set, not the string the
  caller actually passed.
- For an argument-validation error, the field that names what was rejected is the dotted
  path as written in the public signature (`options.maxLength`), matching
  `InvalidInputError.field` — never an internal variable name, which can be renamed
  without that being a contract change.
- When a function forwards an abort onto an `AbortSignal`, abort the controller with the
  exact same error instance the returned promise rejects with, not a fresh error
  carrying the same message. `withTimeout` in `src/timeout.ts` is the model: the
  `TimeoutError` it builds is passed to both `controller.abort(timeout)` and
  `reject(timeout)`, so a cooperating operation reading `signal.reason` sees the
  identical object the caller's `catch` receives.

```ts
/**
 * Thrown when a request exceeds the configured rate limit.
 *
 * @public
 */
export class RateLimitError extends Error {
  /** Stable discriminator, unchanged across non-breaking releases. */
  readonly code = "ERR_RATE_LIMIT" as const;

  /** The limit that was exceeded, in requests per window. */
  readonly limit: number;

  constructor(limit: number) {
    super(`Rate limit of ${String(limit)} requests exceeded.`);
    this.name = "RateLimitError";
    this.limit = limit;
  }
}
```

## Choosing a `code` string

- `ERR_` prefix, `SCREAMING_SNAKE_CASE`, describing the failure rather than the function
  that raised it (`ERR_TIMEOUT`, not `ERR_WITH_TIMEOUT_FAILED`).
- A `scripts/**` error code additionally carries the stage prefix that raised it
  (`ERR_SMOKE_*`, `ERR_ATTW_*`, `ERR_DEPENDENCY_*`), so the code alone — without opening
  the script — tells you which check to go read. Pick an existing stage prefix over
  inventing a new one when the failure belongs to a check that already has one.
- When a function can fail for several structurally different reasons, model them as a
  discriminated union keyed on `code` (or a shared base class per reason) rather than
  one error class with several optional fields — a consumer should be able to `switch`
  on `code` and get every field narrowed, not check which optional fields happen to be
  set.

## Changing a `code`

Adding, renaming, or removing a `code` on a publicly reachable error changes what a
consumer's `switch (error.code)` compiles against — it is a change to the published
contract, not an implementation detail. **REQUIRED:** `release-impact` for what that
means for the semver bump.
