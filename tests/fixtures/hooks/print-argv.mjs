// Prints its own arguments as JSON, for proving shell-form metacharacter
// interpolation (a "$VAR" argument arrives expanded) versus exec-form's
// verbatim argument passing (the same string arrives literal, unexpanded, no
// shell involved). No filesystem writes, no network calls — see
// tests/executor.test.ts for why that matters here.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
process.exit(0);
