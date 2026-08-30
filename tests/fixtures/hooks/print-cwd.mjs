// Prints its own working directory, for proving cwd is passed through to the
// spawned process. No filesystem writes, no network calls — see
// tests/executor.test.ts for why that matters here.
process.stdout.write(process.cwd());
process.exit(0);
