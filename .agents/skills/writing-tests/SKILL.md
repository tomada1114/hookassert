---
name: writing-tests
description: >
  Use when writing or reviewing a test in tests/*.test.ts, or adding the regression test
  a src/ bug fix needs: deciding what a new it() should assert, naming it after
  behavior, asserting an error's class and `code` instead of its message, sweeping edge
  cases with it.each, choosing a fake over a mock, replacing a real sleep with
  vi.useFakeTimers, isolating a filesystem test in mkdtempSync, fixing a flaky or
  skipped test, or writing the missing test a coverage floor is asking for.
---

# Writing Tests

**Owns:** how one test case is written — its name, what it asserts, how it fakes the
world, and the anti-patterns to reject in review. **Does not own:** which file a test
lives in and which vitest project it belongs to (`placing-tests`), `expectTypeOf` type
tests (`type-testing`), the shape of the error classes a test asserts against
(`designing-errors`).

## Naming and scope

- `describe`/`it` names state behavior, not implementation:
  `it("rejects a fractional timeout", ...)`, not `it("calls validate")`.
- One behavior per `it`. Branching inside a test body belongs in a separate `it` or an
  `it.each` table, never an `if` in the test.
- Test public behavior through `src/index.ts`'s exports, never through
  `src/internal/**`. The interface is the test surface: if you find yourself wanting to
  reach past a module's exports to assert something, the module is the wrong shape, not
  the test.
- Cover the happy path and the error path of every public function.

## Asserting errors

Assert the error class and its stable `code`, never the message text:

```ts
expect(() => fn()).toThrow(InvalidInputError);
await expect(promise).rejects.toThrow(TimeoutError);
```

**BACKGROUND:** `designing-errors` explains why `message` is not a contract.

Check that an error propagates through the whole call chain, and that cleanup runs on
the failure path too, not only on success.

## CLI behavior

The observable contract of a command is `argv` → exit code, stdout, and stderr. Drive
that contract through the CLI entry, such as `src/cli.ts`'s exported runner, and assert
the complete result for representative arguments. Do not reach into `src/internal/` to
make command logic testable; if direct unit access is required, the
`public-api-contract` decision makes that logic public instead. A child-process test may
exercise the installed command path when the executable boundary itself matters, but it
should still assert only those caller-visible streams and status.

## Expected values come from outside the code

An expected value must come from an independent source — a known literal, a worked
example, the spec — never recomputed the way the implementation computes it.
`expect(add(a, b)).toBe(a + b)` passes by construction: it restates the implementation
and can never disagree with it, even when the implementation is wrong. Write the number,
string, or object you expect by hand, or take it from a source outside the function
under test.

## Edge cases to sweep every time

`0`, `1`, negative, fractional where an integer is required, `Number.MAX_SAFE_INTEGER`;
an absent optional property versus an explicit `undefined`; long, unicode, and emoji
strings; single-element and duplicate-element collections; cancellation and cleanup for
anything async.

Use `it.each([...])` for input/output variations, labelled through the `%s`/`%p`
placeholders in the title rather than a bare index.

## Fixtures and isolation

- Prefer factory functions (`function makeX(overrides = {})`) to shared mutable
  fixtures.
- `tests/fixtures/` is reserved for data under test, including deliberately malformed
  inputs that must remain byte-for-byte invalid. Keep the test under `tests/*.test.ts`;
  fixture files are never imported as modules.
- Filesystem tests use a fresh `mkdtempSync(path.join(tmpdir(), "prefix-"))` removed in
  `afterEach` with `rmSync(dir, { recursive: true, force: true })` — never write into a
  real project directory.
- Environment and global replacements go through `vi.stubEnv`/`vi.stubGlobal`, not
  direct mutation.
- `vitest.config.ts` already resets mocks and env/global stubs between tests, so an
  `afterEach` whose only body is `vi.restoreAllMocks()` is noise that hides the cleanup
  a test actually needs. Anything the runner does not know about — a timer, a listener,
  a temp directory, a child process — is still cleaned up explicitly, including after a
  failure.

## Independence

Tests are independent: no shared mutable module state, no ordering dependency, no
dependence on timezone, locale, CPU count, or wall-clock time.

Nothing is left as `it.skip`/`it.todo` on `main`, and a flaky test is fixed rather than
retried. Enforced by: the `vitest/*` rules in `eslint.config.mjs`.

## Fakes over mocks

Mock only at boundaries: network, filesystem, clock, child process, randomness. Never
mock the module under test or an internal collaborator — a test that mocks an internal
collaborator breaks on refactor while behavior is unchanged. Prefer a real in-memory
fake to a mock for anything beyond a one-shot call. Assert on behavior and captured
arguments rather than call counts, unless the count itself is the contract.

Do not introduce an abstraction, or a fake for it, until something actually varies
across it.

## Fake timers

No real `setTimeout` or sleep: `vi.useFakeTimers()` plus
`await vi.advanceTimersByTimeAsync(ms)`, restored with `vi.useRealTimers()`. An
abortable API is tested for the caller-visible effect of the abort and for the timer and
listener it removes, on both outcomes — `tests/timeout.test.ts` is the model.

## Anti-patterns

- Testing trivial property access while skipping business-logic edge cases.
- `toBeDefined()`/`not.toBeNull()` where a specific value is checkable.
- Testing that a dependency works, rather than how this package uses it.
- Mocking so much that the real code under test never runs.

## Property-based testing

`fast-check` is worth reaching for when a function has a well-defined invariant over a
large input space — a round trip, an idempotent normalization, an ordering guarantee —
not as a default for ordinary tests. It is not a dependency of this package today, and
adding it goes through the same review as any other dependency. **REQUIRED:**
`managing-dependencies`.
