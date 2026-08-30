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

```ts
import { normalizeIdentifier } from "hookassert";

console.log(normalizeIdentifier("Hello World"));
// => "hello-world"
```

All public symbols are named exports from the package root. Deep imports are private and
blocked by the package export map.

## API

- `normalizeIdentifier(input, options?)` creates a URL- and filename-safe ASCII
  identifier using `-`, `_`, `.`, or `~` as its separator.
- `withTimeout(operation, options)` runs an abortable operation with a deadline.
- `InvalidInputError` and `TimeoutError` expose stable error codes.

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
