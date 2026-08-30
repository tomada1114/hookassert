// A hook that outlives any timeout the executor test gives it, for proving
// ExecOutcome.timedOut === true. Self-terminates after argv[2] milliseconds
// (default 3000) regardless of whether the executor's own timeout killed it
// first, so a bug in the kill logic cannot leave an orphaned process running
// past the test's own lifetime. No filesystem writes, no network calls — see
// tests/executor.test.ts for why that matters here.
const ms = Number(process.argv[2] ?? "3000");
setTimeout(() => {
  process.exit(0);
}, ms);
