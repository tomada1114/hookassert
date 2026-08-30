// A hook that blocks the action, writing its reason to stderr. No filesystem
// writes, no network calls — see tests/executor.test.ts for why that matters
// here.
process.stderr.write("blocked by policy\n");
process.exit(2);
