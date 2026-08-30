// A hook that explicitly allows the action through PreToolUse's own
// hookSpecificOutput.permissionDecision JSON channel. No filesystem writes,
// no network calls — see tests/executor.test.ts for why that matters here.
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
);
process.exit(0);
