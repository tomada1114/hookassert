// A stand-in for `dist/cli.js explain --format json`, for
// tests/conformance.test.ts's own coverage of scripts/conformance.mjs's
// runExplain/defaultRunExplainCase without a real built dist/. Ignores its
// argv and always answers with one firing hook whose matcher is "Bash".
process.stdout.write(JSON.stringify({ firing: [{ matcher: "Bash" }] }));
