// A stand-in for `dist/cli.js explain --format json` that reports a firing
// hook only when invoked with a throwaway cwd and HOME, both under
// os.tmpdir() -- for tests/conformance.test.ts's coverage of
// defaultRunExplainCase pointing the child at throwaway directories rather
// than this repository's real root or the maintainer's real home directory,
// where a stray ~/.claude/settings.json or repo .claude/settings.json could
// otherwise leak into the single-hook prediction.
//
// Compares realpath()s rather than raw strings: a spawned child's cwd is
// reported through getcwd(), which resolves symlinks (e.g. macOS's
// /var -> /private/var), while an inherited HOME env var is not resolved by
// the OS at all -- a bare startsWith(tmpdir()) would spuriously fail for one
// side or the other.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";

const resolvedTmpdir = realpathSync(tmpdir());

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isUnderTmpdir(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return realpathSync(value).startsWith(resolvedTmpdir);
  } catch {
    return false;
  }
}

const isolated = isUnderTmpdir(process.cwd()) && isUnderTmpdir(process.env["HOME"]);

process.stdout.write(JSON.stringify({ firing: isolated ? [{ matcher: "Bash" }] : [] }));
