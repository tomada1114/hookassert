# Troubleshooting map

This page maps the symptoms the official Claude Code hooks documentation describes to
the `hookassert lint` rule that would have caught the underlying config mistake before a
hook ever ran.

**Source:**
[`docs.claude.com/en/docs/claude-code/hooks`](https://docs.claude.com/en/docs/claude-code/hooks),
which redirects to `code.claude.com/docs/en/hooks`. **Fetched:** 2026-09-01.

Like `spec/claude-code-2.1.251-2.2.0.json`'s own transcription of the same documentation
(see `src/types.ts`'s `EventName` remarks), this table is **structural guidance, not
verified content**: it reflects one fetch of a page that changes over time and was
condensed by a fetch tool rather than copied verbatim. Treat a row here as a pointer to
go re-read the live page, not as a substitute for it.

## How to read this table

- **Detecting rule** names the `hookassert lint` rule id, in backticks, that flags the
  config pattern behind the symptom — the same id `Finding.ruleId` carries and
  `src/internal/lint/registry.ts` registers. `tests/troubleshooting-map.test.ts` asserts
  every id named here actually exists in that registry, so this table cannot silently
  drift from the rules it claims to describe.
- A row whose **Detecting rule** column reads "Not covered" names a real documented
  symptom that no static `lint` rule can catch — usually because it requires either
  running the hook (a `test` subcommand concern) or reading a setting `lint` does not
  parse. These rows are listed for completeness, but intentionally cite no rule id.
- This mapping is one-directional: every rule id cited below is checked against the
  registry, but not every registered rule has to appear here. `matcher-is-array`,
  `matcher-hyphen-version`, and `matcher-comma-version` are genuine `hookassert`-only
  refinements — the official troubleshooting guidance never calls out "matcher declared
  as a JSON array" or "notation gated behind a `sinceVersion`" as its own named symptom,
  so requiring the reverse direction (every rule cited somewhere in this table) would
  force either an invented symptom row or a rule id present only to satisfy the test,
  neither of which documents anything real. `tests/troubleshooting-map.test.ts`
  therefore checks map → registry only; see that test file's own remarks for this same
  reasoning.

## Symptom → rule map

| Official symptom                                                                                                                                                                                                              | What it means                                                                                                                                                                                                                                                                                                                                                      | Detecting rule                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| "Hook Not Running" — the settings file's `command` names a path that "doesn't exist or isn't executable"; Claude Code reports `No such file or directory` (exit code around 127) and, for a policy hook, silently disables it | The hook can never start, independent of its matcher or its logic.                                                                                                                                                                                                                                                                                                 | `command-not-found`, `not-executable` |
| Same "Path doesn't exist or isn't executable" family, for a script file that exists and is executable but whose interpreter Claude Code cannot determine under exec form                                                      | A script with no `#!` line behaves unpredictably (or fails outright) once there is no shell to fall back on.                                                                                                                                                                                                                                                       | `missing-shebang`                     |
| "Hook Not Running" — "Matcher doesn't match": the event fires, but the configured matcher filters the hook out                                                                                                                | The matcher is spelled or cased wrong, or lists a tool name the loaded spec does not recognize, so it silently never matches.                                                                                                                                                                                                                                      | `matcher-case`, `matcher-dead`        |
| "Hook Not Blocking" — "Exit code isn't 2": the hook exits `1` (or any code other than `2`) expecting Claude Code to treat it as a denial, but "Exit 1 is non-blocking (doesn't follow Unix convention)"                       | Only exit code `2` blocks the tool call on a blockable event. A policy branch that exits `1` instead of `2` is silently ignored — the action proceeds exactly as if the hook had exited `0`.                                                                                                                                                                       | `exit-1-policy`                       |
| Exit-code semantics — "Even JSON with `"permissionDecision": "allow"` cannot override exit 2" / "Exit 2 blocks whether or not you print JSON"                                                                                 | The reverse trap of the row above: a hook that can both print an `"allow"` decision and exit `2` on some path is not actually granting anything on that path — exit `2` always wins.                                                                                                                                                                               | `exit-2-overrides-allow`              |
| "Path and Command Issues" — shell form: "Wrap path placeholders in double quotes in shell: `"${CLAUDE_PROJECT_DIR}"/hook.sh`"; shell form "tokenizes, expands, interprets" unquoted content                                   | An unquoted shell variable reference in a command that runs through shell form is subject to word splitting and glob expansion — the same class of bug the docs' own example is warning a reader away from.                                                                                                                                                        | `unquoted-var`                        |
| "Hook disabled globally" — `"disableAllHooks": true` in a settings file suppresses every hook, including ones that otherwise look correctly configured                                                                        | Not covered — this is a project-wide settings flag, not a per-hook declaration `lint`'s matcher/command rules inspect.                                                                                                                                                                                                                                             | Not covered                           |
| "Wrong event type" — some events (`PermissionRequest`, `StopFailure`, `PostToolUse`, `PostToolUseFailure`) "can't block via exit code" at all; only their own JSON decision fields can                                        | Not covered — this is a property of the event itself (`spec.events[event].blockable`), not a mistake in a specific hook's declaration. `src/internal/decision/resolve.ts`'s `canProduceDeny` already encodes this at runtime; a future static rule could flag a hook that relies on exit-code blocking for a non-blockable event, but this issue does not add one. | Not covered                           |
| "Unexpected JSON Behavior" — invalid or schema-violating JSON output is a non-blocking error on any exit code but `2`, and is silently ignored                                                                                | Not covered — verifying a hook's actual stdout against the JSON schema requires running the hook, which is `test`'s job, not a zero-spawn static check.                                                                                                                                                                                                            | Not covered                           |

## Not in this table

`matcher-is-array`, `matcher-comma-version`, `matcher-hyphen-version`,
`matcher-unanchored`, and `matcher-catastrophic` catch mistakes the fetched
troubleshooting guidance does not name as their own symptom — a matcher declared as a
JSON array; comma- or hyphen-notation gated behind a Claude Code version too old to
support it; an unanchored regex matcher that over-matches beyond the tool it was written
for; a matcher whose pattern contains a nested unbounded quantifier and can hang instead
of matching. None of these has a distinct row in the page as fetched (2026-09-01); see
"How to read this table" above for why the map does not force one.
