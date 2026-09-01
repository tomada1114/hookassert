// A stand-in "built CLI" that always fails, for
// tests/conformance.test.ts's coverage of runExplain's non-zero-exit path.
process.stderr.write("simulated explain failure\n");
process.exitCode = 3;
