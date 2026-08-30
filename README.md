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
- `hookassert lint` checks hook declarations for matcher and command mistakes.
- `hookassert record` captures real hook payloads from a Claude Code session.
- `hookassert test` replays recorded events and asserts on what the hooks did.

`lint`, `record`, and `test` have no behavior yet: each currently exits `4` with
`ERR_USAGE`, so a script that wires one up fails loudly instead of silently reporting
success.

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
