// A hook that succeeds without printing anything. No filesystem writes, no
// network calls — see tests/executor.test.ts for why that matters here.
process.exit(0);
