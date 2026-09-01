# hookassert

[![CI](https://github.com/tomada1114/hookassert/actions/workflows/ci.yml/badge.svg)](https://github.com/tomada1114/hookassert/actions/workflows/ci.yml)

Test your Claude Code hooks like code: replay tool events against your merged settings,
run the matching hooks, and fail CI when one doesn't fire or doesn't block.

## Install

```sh
pnpm add hookassert
```

Requires Node.js 20 or newer. The package ships ESM only; on that range `require(esm)`
is unflagged, so a CommonJS consumer can `require()` it directly.

## Quick start

hookassert is a command. Ask it what it ships:

```sh
hookassert --help
```

## Commands

- `hookassert explain <event> [tool]` shows which hooks a tool event fires, and why:
  every firing hook printed with its settings layer, absolute source file, and line, and
  every matcher that did not fire printed with the reason. It never spawns a process —
  the Claude Code version it runs against comes only from `--claude-version` or the
  `HOOKASSERT_CLAUDE_VERSION` environment variable, falling back to `"undetermined"`.
- `hookassert lint` is a zero-execution static check over your settings tree: it never
  spawns a process or writes a file, and reports every matcher mistake it finds as a
  `Finding` — a dead exact-match item, a case mismatch, an unanchored regex that
  over-matches, and a comma- or hyphen-notation matcher used against a Claude Code
  version that cannot be confirmed to support it. Exits `1` when it finds anything, `0`
  when it finds nothing. `--claude-version`, `--settings` and `--format`
  (`pretty`/`json`/`github`) mean exactly what they do for `explain`.
- `hookassert record` captures real hook payloads from a Claude Code session.
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
  here, only a name. Exits `0` when every case passes (and, with `--ci`, none is
  `unknown` either), `1` when at least one fails, and `3` when there are no failures but
  `--ci` was given and at least one case is `unknown`.

`record` alone has no behavior yet: it currently exits `4` with `ERR_USAGE`, so a script
that wires it up fails loudly instead of silently reporting success.

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
