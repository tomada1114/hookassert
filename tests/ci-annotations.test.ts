/**
 * The mechanical proof behind the CI job `.github/workflows/ci.yml`'s
 * `ci-annotation-proof` job runs: `lint --format github` against #13's own
 * `matcher-is-array` violating fixture emits the exact GitHub Actions
 * `::error file=…,line=…,title=…::<message>` line that job greps its own
 * output for.
 *
 * @remarks
 * This is the "mechanical" half of #18's acceptance criteria — it runs on
 * every future PR and fails the moment the annotation's exact shape
 * regresses. The other half — that the line actually renders as a visible
 * annotation on the correct diff line of a real GitHub Actions run — is a
 * human, PR-review-time observation only the PR that introduced this job
 * can make; see that PR's own body for the reviewer checklist item.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../src/cli.js";
import { createUnimplementedSpawner } from "../src/internal/exec/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const VIOLATING_FIXTURE = fileURLToPath(
  new URL("./fixtures/lint/matcher-is-array/violating.json", import.meta.url),
);

/** The shipped spec path, resolved the same way `src/cli.ts` resolves its own default. */
const SPEC_PATH = fileURLToPath(
  new URL("../spec/claude-code-2.1.251-2.2.0.json", import.meta.url),
);

/**
 * The fixture's own `"matcher"` line, found by a plain text search rather
 * than through the same JSON-position parser `src/internal/lint/parse.ts`
 * uses to compute `Finding.line` — an independent derivation, not a restated
 * implementation. This is what keeps the line number pinned below from
 * silently rotting if the fixture's own formatting ever changes: it is read
 * off the fixture itself, not hand-copied from a one-time inspection of it.
 */
function matcherLineNumber(fixturePath: string): number {
  const lines = readFileSync(fixturePath, "utf8").split("\n");
  const index = lines.findIndex((line) => line.trim().startsWith('"matcher"'));
  if (index === -1) {
    throw new Error(`no line starting with "matcher" found in ${fixturePath}`);
  }
  return index + 1;
}

/** `lint`'s own default deps, with no explicit settings/version/spawner — mirrors `explainDeps` in `tests/cli.test.ts`. */
function lintDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: overrides.cwd ?? REPO_ROOT,
    home: overrides.home ?? path.join(REPO_ROOT, "tests", "fixtures", "no-such-home"),
    env: overrides.env ?? {},
    spawner: overrides.spawner ?? createUnimplementedSpawner(),
    specPath: overrides.specPath ?? SPEC_PATH,
    isTTY: overrides.isTTY ?? false,
    confirm: overrides.confirm ?? (() => Promise.resolve(false)),
  };
}

describe("lint --format github: the CI annotation proof's mechanical half", () => {
  it("emits the exact expected ::error file=…,line=…,title=…::<message> line for the known broken fixture", async () => {
    const result = await runCli(
      ["lint", "--format", "github", "--settings", VIOLATING_FIXTURE],
      "hookassert",
      lintDeps(),
    );

    const relativePath = path
      .relative(REPO_ROOT, VIOLATING_FIXTURE)
      .split(path.sep)
      .join("/");
    const line = matcherLineNumber(VIOLATING_FIXTURE);

    // Golden, exact-line assertion — not a substring/prefix check. Hand
    // transcribed from `src/internal/lint/rules/matcherIsArray.ts`'s own
    // message and suggestion text, and from `renderLintGithub`'s "Suggestion:
    // " fold, so a change to either shows up here as a failing diff rather
    // than an unnoticed drift.
    const expectedLine =
      `::error file=${relativePath},line=${String(line)},title=matcher-is-array::` +
      `The "PreToolUse" hook's matcher is a JSON array, not a string. ` +
      `Claude Code's settings schema rejects this, which disables every hook ` +
      `declared in this entire settings file — not just this one hook. ` +
      `Suggestion: Change the matcher to the string "Edit,Write" instead of a JSON array.`;

    expect(result.stdout.split("\n")).toContain(expectedLine);
  });

  it("renders the annotation's file path relative to the repository/workspace root, not an unresolvable absolute path", async () => {
    const result = await runCli(
      ["lint", "--format", "github", "--settings", VIOLATING_FIXTURE],
      "hookassert",
      lintDeps({ cwd: REPO_ROOT }),
    );

    const relativePath = path
      .relative(REPO_ROOT, VIOLATING_FIXTURE)
      .split(path.sep)
      .join("/");

    expect(result.stdout).toContain(`file=${relativePath},`);
    // The trap #12 left a note about: GitHub Actions resolves `file=` against
    // the checkout root, so an absolute path never matches any line in the
    // PR diff and the annotation silently fails to attach.
    expect(result.stdout).not.toContain(VIOLATING_FIXTURE);
  });
});
