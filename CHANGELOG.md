# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release pull requests update this file as part of the reviewed release process.

## [0.1.0] - 2026-09-04

Initial release.

### Added

- `hookassert explain <event> [tool]` shows which hooks a tool event fires, and why —
  every firing hook printed with its settings layer, source file, and line, and every
  non-firing matcher printed with the reason. It never spawns a process.
- `hookassert lint` is a zero-execution static check over your settings tree: it reports
  a dead exact-match matcher, a case mismatch, an unanchored regex that over-matches, and
  a comma- or hyphen-notation matcher used against a Claude Code version that cannot be
  confirmed to support it. A version-notation finding distinguishes "version known but
  outside the spec's declared range" from "version could not be determined".
- `hookassert record` inserts a side-effect-free capture hook into your local settings
  layer so a real Claude Code session accumulates real hook payloads as envelope files;
  `hookassert record --stop` removes it again with a byte-for-byte restore guarantee, or
  a clear error when something else edited the settings file in the meantime.
  `hookassert explain --emit-fixtures <dir>` turns captured payloads into ready-to-edit
  fixture files.
- `hookassert test <fixture>...` replays one or more YAML fixtures against your merged
  settings, runs the hooks that actually fire, and asserts what happened against each
  case's declared `expect` (`fires`, `decision`, `exitCode`, `stdoutContains`,
  `stderrContains`, `context`, `updatedInput`, `timedOut`). It is the one command that
  spawns processes, so it asks for consent first — on a terminal it prints every exact
  command about to run and waits for confirmation; `--yes` and `--ci` skip the prompt,
  and a non-interactive run given neither exits without spawning anything. `--dry-run`,
  a fixture case's own `dryRun: true`, and `stub` all keep a case out of the spawn plan.
  `--timeout`, a repeatable `--env <NAME>`, and `--concurrency <n>` (default 8; the
  consent prompt states how many commands will run at once) tune a run. A hook whose
  process never starts at all is reported as `decision: error` (`cause: launch-failed`)
  rather than mistaken for a hook that ran and exited non-zero, and every firing hook's
  launch failure for a case is surfaced in the JSON report's `launchFailures[]` array,
  not only the deciding hook's. When no hook fires at all, `fires: false` passes as the
  explicit "nothing should fire" case; a case pairing `fires: false` with any other
  `expect` field is rejected when the fixture loads, and a case that declares any other
  `expect` field with nothing firing fails outright instead of silently passing.
- `pretty`, `json`, and `github` report formats across `explain`, `lint`, and `test`,
  including GitHub Actions error/warning annotations.
- A spec-driven matcher and decision engine, versioned against a declared Claude Code
  release range, resolving which hooks fire for a given event and tool and folding every
  firing hook's exit code and JSON output into one case verdict (any deny wins).
- A three-layer settings merge (user, project, local) with per-hook provenance (file and
  line), and a fixture format (`settings`, `defaults`, `cases`) with its own schema for
  editor validation. A fixture's own `defaults.timeoutMs` is honored as written, never
  clamped by the spec's timeout ceiling; `--dry-run` never spawns the Claude Code version
  probe used to resolve `undetermined`.
- A black-box conformance harness proving the CLI's observable behavior — output,
  exit codes, and report shapes — against recorded transcripts.

[0.1.0]: https://github.com/tomada1114/hookassert/releases/tag/v0.1.0
