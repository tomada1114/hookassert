# Conformance

This directory is the durable history of `scripts/conformance.mjs`'s findings: every
past mismatch between `spec/claude-code-<range>.json` and a real `claude --debug`
session, and how it was resolved. Unit tests (`tests/matcher.test.ts`,
`tests/spec.test.ts`, and friends) only prove hookassert agrees with the spec file —
they cannot prove the spec file agrees with real Claude Code. `scripts/conformance.mjs`
is the black-box harness that checks the second half, by comparing hookassert's
predicted hook-firing set against what a recorded transcript actually showed happened.

No mismatch has been recorded yet, so this file is only the convention: when
`pnpm conformance` finds one, add `docs/conformance/<date>-<short-description>.md`
recording what disagreed, the proposed diff the script printed, and how it was resolved
(the spec was corrected, or the transcript's own capture was wrong).

## What the harness does, and does not do

- It calls the **built** CLI as a subprocess — `node dist/cli.js explain --format json`
  — never `src/internal/**` or `dist/internal/**` directly, the same `scripts/**`
  boundary every other file under this directory already respects.
- On a mismatch, it prints a proposed spec correction as a diff to stdout/stderr. It
  **never writes to `spec/claude-code-<range>.json` itself.** The spec change and the
  mismatch's history go through an ordinary pull request, reviewed by a human, same as
  any other code change.
- The same rule governs `payloadShape.verified` (`#3`): when a captured payload's keys
  satisfy an event's `requiredKeys`, the harness proposes flipping `verified` from
  `false` to `true` — it does not flip it. Apply the proposal by hand, in the same
  reviewed PR as the mismatch it came with.
- `pnpm conformance` is a maintainer-only, this-repository-only step. It is not run by
  CI, `pnpm test`, or `pnpm check`, and producing a fresh transcript first requires a
  real `claude` binary and network/session access — see "Producing a transcript" below.
  Closing an issue that touches this harness never requires actually running it against
  a live `claude` binary; `tests/conformance.test.ts` covers the comparison logic
  against recorded fixtures instead.

## The transcript format

A transcript is a JSON document:

```json
{
  "claudeVersion": "2.1.255",
  "firingObservations": [
    { "event": "PreToolUse", "matcher": "Bash", "tool": "Bash", "fired": true }
  ],
  "payloadObservations": [
    {
      "event": "SessionStart",
      "payload": {
        "session_id": "...",
        "cwd": "...",
        "hook_event_name": "SessionStart",
        "transcript_path": "...",
        "source": "startup"
      }
    }
  ]
}
```

- `claudeVersion` — the Claude Code version the recorded session ran.
- `firingObservations` — one entry per `(event, matcher, tool)` the session actually
  exercised: whether a hook declaring that matcher fired for that tool. This is the
  ground truth `scripts/conformance.mjs` diffs hookassert's live prediction against.
- `payloadObservations` — raw hook payloads captured along the way, each tied to the
  event it was captured for, for `payloadShape.verified` proposals.

`scripts/lib/conformance/transcript.mjs` validates and normalizes this shape;
`tests/fixtures/conformance/` holds fixtures hand-constructed from
`spec/claude-code-<range>.json`'s own `matcherTable`, standing in for a real recording —
see that module and `tests/conformance.test.ts` for the exact contract.

## Producing a transcript

Capturing a transcript from a real session is a **manual, maintainer-driven step**, not
something this repository automates:

1. Run `claude --debug` for a session that exercises the hook events and matchers you
   want to check, with hooks configured that make firing observable (for example, a hook
   that appends its own invocation to a log file).
2. From that session's debug output and hook logs, extract, for each tool event you want
   to check, whether the hook you configured actually fired, and any payloads you want a
   `payloadShape.verified` proposal for.
3. Write the result as a transcript JSON document (see above) and pass it to the
   harness: `pnpm conformance -- --transcript path/to/transcript.json`.

A script that extracts a transcript automatically from a raw `claude --debug` log is a
plausible future enhancement, out of scope here.
