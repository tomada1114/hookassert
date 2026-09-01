// A stand-in for `dist/cli.js explain --format json` that echoes its own
// argv, for tests/conformance.test.ts's coverage of runExplain threading
// --claude-version through to the CLI invocation. Reports an empty firing
// set so firedInExplainReport does not throw on the result.
import process from "node:process";

process.stdout.write(
  JSON.stringify({ firing: [], argv: process.argv.slice(2) }),
);
