# hookassert

[![CI](https://github.com/tomada1114/hookassert/actions/workflows/ci.yml/badge.svg)](https://github.com/tomada1114/hookassert/actions/workflows/ci.yml)

hookassert tests your Claude Code hooks like code: it resolves your merged
`settings.json`, replays recorded or synthetic tool events, actually runs the matching
hooks, and fails CI when one doesn't fire, doesn't block, or exits in a way you didn't
declare.

> [!WARNING]
>
> **hookassert actually runs your hooks. Run it in an isolated environment.**
>
> `hookassert test` spawns your hooks' real commands as real child processes — the exact
> shell or exec form your settings already declare — outside of any Claude Code
> session's own permission prompts. If a hook pushes to a remote, deletes files, or
> calls an external API, `test` makes that happen for real. This is not tone, it is
> backed by concrete mitigations you can verify yourself:
>
> - `explain`, `lint`, and `record` never spawn a process at all; `test` is the only
>   command that does, and it is opt-in.
> - `test` asks for consent before running anything: on a terminal it prints every exact
>   command it is about to run and waits for a `y`/`N` answer. `--yes` and `--ci` are
>   the only way to skip that prompt, and a non-interactive run given neither exits `6`
>   (`ERR_CONSENT_REQUIRED`) instead of spawning anything.
> - A spawned hook's environment is built from an explicit allowlist —
>   `spec.hookEnv.provided` plus whatever `--env <NAME>` or a fixture's own
>   `defaults.env` names — never a full passthrough of your shell's environment.
> - A fixture case's `stub` and a whole run's `--dry-run` both keep a case out of the
>   spawn plan entirely, so you can write and check a fixture's expectations before
>   letting anything actually run.
>
> None of that makes running an unreviewed hook risk-free — hookassert cannot know what
> your hook's command does. Run it in a container, VM, or disposable checkout, not on
> your primary machine or against a settings tree you have not read.

## Install

```sh
pnpm add hookassert
```

Requires Node.js 20 or newer. The package ships ESM only; on that range `require(esm)`
is unflagged, so a CommonJS consumer can `require()` it directly.

## Quick start

No separate install step is required for a first run — `npx` fetches the package and
runs it once:

```sh
npx hookassert explain PreToolUse Bash
```

Ask it what it ships:

```sh
hookassert --help
```

## Commands

- `hookassert explain <event> [tool]` shows which hooks a tool event fires, and why:
  every firing hook printed with its settings layer, absolute source file, and line, and
  every matcher that did not fire printed with the reason. It never spawns a process —
  the Claude Code version it runs against comes only from `--claude-version` or the
  `HOOKASSERT_CLAUDE_VERSION` environment variable, falling back to `"undetermined"`.

  ```console
  $ hookassert explain PreToolUse Bash
  Claude Code version: undetermined
  Spec range: >=2.1.251 <2.2.0

  PreToolUse Bash

  Firing hooks:
    [project] /path/to/project/.claude/settings.json:7 ./scripts/block-force-push.sh

  Not firing: none
  ```

- `hookassert lint` is a zero-execution static check over your settings tree: it never
  spawns a process or writes a file, and reports every matcher mistake it finds as a
  `Finding` — a dead exact-match item, a case mismatch, an unanchored regex that
  over-matches, and a comma- or hyphen-notation matcher used against a Claude Code
  version that cannot be confirmed to support it. Exits `1` when it finds anything, `0`
  when it finds nothing. `--claude-version`, `--settings` and `--format`
  (`pretty`/`json`/`github`) mean exactly what they do for `explain`.

  ```console
  $ hookassert lint
  Claude Code version: undetermined
  Spec range: >=2.1.251 <2.2.0

  Findings (1):
    [matcher-case] /path/to/project/.claude/settings.json:5 — Matcher "bash" uses the wrong case for "Bash". Matcher comparison is case-sensitive, so this never matches.
      suggestion: Use "Bash" instead of "bash".
  ```

- `hookassert record` inserts a side-effect-free capture hook into
  `.claude/settings.local.json` — the smallest-blast-radius settings layer, per-user and
  typically gitignored — for every event Claude Code documents (or only the ones named
  by a comma-separated `--events <list>`), so a real session accumulates real hook
  payloads. Each captured payload is written as its own envelope file (`capturedAt`,
  `event`, `claudeVersion`, `sourceFile`, plus the raw payload) under
  `.hookassert/captures/`, overridable with `--capture-dir <dir>`. It never spawns a
  process itself — only the capture hook runs later, under Claude Code.
  `hookassert record --stop` removes the capture hook again with a byte-for-byte restore
  guarantee: if nothing else touched the settings file while recording was active, it is
  restored exactly; if it was edited by hand in the meantime, only the capture hook is
  removed — your edit is never silently overwritten — and the command exits `5` with
  `ERR_RECORD_RESTORE` to say so. `--stop` also exits `5` with the same code when no
  recording session is active.

  ```console
  $ hookassert record --events PreToolUse
  Recording started: capture hook inserted into /path/to/project/.claude/settings.local.json (file created).
  Capturing events: PreToolUse
  Capture directory: /path/to/project/.hookassert/captures
  Run `hookassert record --stop` when you are done recording.

  $ hookassert record --stop
  Recording stopped: /path/to/project/.claude/settings.local.json restored to its pre-recording state (zero diff).
  ```

- `hookassert test <fixture>...` replays one or more fixture files against your merged
  settings, runs the hooks that actually fire, and asserts what happened against each
  case's declared `expect`. It is the one command that spawns processes, so it asks for
  consent first: on a terminal it prints the exact commands about to run and waits for
  confirmation; `--yes` and `--ci` both skip the prompt, and a non-interactive run given
  neither exits `6` with `ERR_CONSENT_REQUIRED` instead of running anything. `--dry-run`
  excludes every case from the spawn plan; `--claude-version`, `--settings` and
  `--format` (`pretty`/`json`/`github`) mean exactly what they do for `explain`, and two
  options are `test`'s own: `--timeout <ms>` sets the default hook timeout in
  milliseconds for hooks that declare none (a fixture file's own `defaults.timeoutMs`
  still wins over it), and a repeatable `--env <NAME>` opts one ambient environment
  variable into every spawned hook's environment by name — a value is never accepted
  here, only a name. When several hooks fire for one case, any deny wins; the report
  names the hook that decided. A hook whose process never starts at all — an exec-form
  hook (one declaring `args`) naming a command that does not exist, a missing
  interpreter — resolves to `decision: error` (`cause: launch-failed`) rather than being
  mistaken for a hook that ran and exited non-zero. A failing case's `pretty` and
  `github` output then shows the OS-reported reason (`spawn python33 ENOENT`, say)
  alongside the hook's own declaration, and the JSON report carries it as
  `decidedBy.launchError`. A shell-form hook (no `args`, the shape Claude Code's own
  docs show) always launches `/bin/sh` successfully, so a typo'd `command` there is
  reported by the shell itself — usually exit `127` — not as `launch-failed`. Exits `0`
  when every case passes (and, with `--ci`, none is `unknown` either), `1` when at least
  one fails, and `3` when there are no failures but `--ci` was given and at least one
  case is `unknown`.

  ```console
  $ hookassert test fixtures/force-push.fixture.yaml --ci
  Claude Code version: 2.1.258
  Spec range: >=2.1.251 <2.2.0

  PASS  /path/to/project/fixtures/force-push.fixture.yaml#0 (PreToolUse Bash)

  asserted 1 (0 from recorded), 0 failed, 0 unknown, 0 skipped
  ```

  Passing `--ci` in a real terminal that would otherwise prompt is fine — it simply
  skips the confirmation the same way `--yes` does; in an actual CI job it additionally
  turns an `unknown` result into a failing exit code (`3`) instead of a silent pass.

## Fixture format

A fixture is a YAML file with three top-level keys: an optional `settings` list that
restricts candidate hooks to the named settings files, an optional `defaults` block
(`timeoutMs`, `env`, `cwd`) applied to every case in the file, and a required `cases`
list with at least one entry. Start every fixture with the schema comment so an editor
with the YAML language server validates it as you type:

```yaml
# yaml-language-server: $schema=./node_modules/hookassert/schema/fixture.schema.json
settings:
  - .claude/settings.json
defaults:
  timeoutMs: 5000
  env:
    MY_FLAG: "1"
cases:
  - event: PreToolUse
    tool: Bash
    input:
      tool_name: Bash
      tool_input:
        command: git push --force
    expect:
      fires: true
      decision: deny
      exitCode: 2
      stderrContains: force push blocked
```

Each entry in `cases` may declare:

- `event` (required) and `tool` — the Claude Code event and matcher target to replay.
- `input` — the payload the fired hook receives on stdin; defaults to `null`.
- `origin.recorded: <path>` — point at an envelope file `record` produced instead of
  writing `input` by hand. A case with a recorded origin counts toward `test`'s own
  `(N from recorded)` summary count.
- `expect` — any of `fires`, `decision` (`deny`/`allow`/`pass`/`error`/`unknown`),
  `exitCode`, `stdoutContains`, `stderrContains`, `timedOut`. Only the fields you set
  are asserted.
- `stub` — map an exact hook `command` string to a canned `{ exitCode }` instead of
  actually spawning it.
- `dryRun: true` — skip execution for this one case, the same effect `--dry-run` has for
  the whole run.
- `cwd` — override the working directory this case's hooks spawn from.

A case whose every firing hook is stubbed, or that declares `dryRun: true`, is reported
as `"skipped"` rather than run or left `"unknown"`.

## Workflow: `record` → `explain --emit-fixtures` → `test`

Turning a real Claude Code session into a fixture you can run in CI is three steps:

1. **Capture real payloads.** `hookassert record --events PreToolUse` (or `record` with
   no `--events`, to capture every documented event) inserts the capture hook and prints
   where it wrote it. Use Claude Code normally; every matching event writes its own
   envelope file under `.hookassert/captures/`. When you are done,
   `hookassert record --stop` removes the capture hook and restores the settings file
   exactly.

2. **Turn captures into fixtures.** `hookassert explain --emit-fixtures <dir>` reads
   every envelope under `.hookassert/captures/` (or `--capture-dir <dir>`) and writes
   one fixture file per envelope into `<dir>`, each starting with the `$schema` comment
   and a single case: `input` is the captured payload verbatim, `origin.recorded` points
   back at the envelope, and `expect` is always exactly `{ fires: true }` — deliberately
   nothing more specific, since a guessed `decision` or `exitCode` you never reviewed
   would be worse than no assertion at all.

   ```console
   $ hookassert explain --emit-fixtures fixtures/
   Wrote 1 fixture file(s) to /path/to/project/fixtures:
     /path/to/project/fixtures/capture-2026-09-02T14-06-27-048Z-00986e68b8da.fixture.yaml
   ```

3. **Fill in real expectations and run them in CI.** Edit the generated `expect` block
   to say what the hook is actually supposed to do (`decision: deny`, a specific
   `exitCode`, a `stderrContains` substring), then run it with `--ci`:

   ```console
   $ hookassert test fixtures/*.fixture.yaml --ci
   Claude Code version: 2.1.258
   Spec range: >=2.1.251 <2.2.0

   PASS  /path/to/project/fixtures/capture-2026-09-02T14-06-27-048Z-00986e68b8da.fixture.yaml#0 (PreToolUse Bash)

   asserted 1 (1 from recorded), 0 failed, 0 unknown, 0 skipped
   ```

   `--ci` is what turns an `unknown` result — an unverified payload shape, an
   undetermined Claude Code version, a plugin hook file hookassert has not read, and so
   on — into a failing exit code (`3`) instead of a silent pass, so give it to `test` in
   the CI job even though you would use `--yes` locally.

## Official tools, and what hookassert adds

Claude Code ships its own diagnostics: `claude doctor` checks your installation and
configuration, `claude --debug` prints verbose runtime logging including which hooks
fired during a session, and the `/hooks` slash command lists what is currently
configured. All three need a real, interactive Claude Code session and a real tool call
per observation — there is no way to inject a synthetic input and see what a hook would
do without actually causing it to happen.

That is precisely the gap hookassert closes: it asserts N synthetic or recorded cases in
one run, without launching an interactive Claude Code session at all. `explain` and
`lint` read your settings and report on them without spawning anything; `test` replays
as many cases as your fixtures declare against your real, merged settings and real hook
commands, and reports pass/fail/unknown counts a CI job can act on.

## Platform support

hookassert is developed and exercised on macOS and Linux. **Windows is unverified**, not
claimed as unsupported: `test`'s shell-form and exec-form spawn logic behaves
differently across Git Bash, PowerShell, and a `.cmd` shim, and none of that divergence
has been checked against a Windows Claude Code installation. No claim is made about
hookassert working there one way or the other — if you try it, verify your own hook
commands spawn the way you expect before relying on it in CI.

## API

The package root publishes the type vocabulary those commands report in, and no runtime
value — `EventName`, `SettingsLayer`, `Provenance`, and `ResolvedHook`:

```ts
import type { ResolvedHook } from "hookassert";

function summarize(hook: ResolvedHook): string {
  const at = `${hook.provenance.file}:${String(hook.provenance.line)}`;
  return `${hook.event} runs ${hook.command} (declared at ${at})`;
}
```

All public symbols are named exports from the package root. Deep imports are private and
blocked by the package export map.

See the generated TypeDoc documentation from `pnpm docs:build` for the full API
reference.

## Development

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete workflow.

## License

[MIT](LICENSE) © tomada
