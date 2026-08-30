# my-package

[![CI](https://github.com/your-name/my-package/actions/workflows/ci.yml/badge.svg)](https://github.com/your-name/my-package/actions/workflows/ci.yml)

A short description.

## Install

```sh
pnpm add my-package
```

<!-- profile:node-library:start -->

Requires Node.js 24 or newer. The package ships ESM only; on that range `require(esm)`
is unflagged, so a CommonJS consumer can `require()` it directly.
<!-- bootstrap-node-floor -->
<!-- profile:node-library:end -->

<!-- profile:universal-library:start -->

The package does not declare a Node.js floor. The package ships ESM only; on that range
`require(esm)` is unflagged, so a CommonJS consumer can `require()` it directly.
<!-- profile:universal-library:end -->

## Quick start

```ts
import { normalizeIdentifier } from "my-package";

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

<!-- template-only:start -->

## Use this template

Create a repository with GitHub's **Use this template** button, then run the interactive
bootstrap before installing dependencies:

```sh
node scripts/bootstrap.mjs
```

Answer the prompts for the package name, profile, CLI choice, published Node floor,
author, email, GitHub user, license, and description. For automation, pass the package
name together with the `--profile`, `--cli`, `--node-engines`, `--author`, `--email`,
`--github-user`, and `--license` flags.

Use `node-library` for a Node.js package, or `universal-library` for code that must
build without Node APIs. Add `--cli yes` to a `node-library` package to keep its
`src/cli.ts` command entry. A `node-library` publishes `>=24` by default; pass
`--node-engines '>=20'` to choose a different published floor. Bootstrap removes this
section from the generated repository.
<!-- template-only:end -->

## Development

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete workflow.

## License

[MIT](LICENSE) © Your Name
