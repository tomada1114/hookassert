import { defineConfig } from "vitest/config";

// Without this, a fixture suite written to fail is collected as one of this
// repository's own tests.
const fixtures = "tests/fixtures/**";

// Tests that import repository automation, touch the filesystem, spawn a
// subprocess, or use git. They are listed explicitly so a new test defaults to
// the short-timeout unit project until its I/O needs are deliberately reviewed.
// The four files not listed here are pure unit tests; guard-rules.test.ts is the
// intentional exception to the usual `src/**` rule because it calls the guard
// engine's pure functions directly.
const automationTests = [
  "tests/bootstrap.test.ts",
  "tests/boundaries.test.ts",
  "tests/check-attw.test.ts",
  "tests/check-staged.test.ts",
  "tests/ci-sync.test.ts",
  "tests/clean.test.ts",
  "tests/docs.test.ts",
  "tests/git-env.test.ts",
  "tests/labels.test.ts",
  "tests/node-tools.test.ts",
  "tests/package-smoke.test.ts",
  "tests/package.test.ts",
  "tests/skills-frontmatter.test.ts",
  "tests/smoke-package.test.ts",
  "tests/sync-agents.test.ts",
  "tests/sync-labels.test.ts",
  "tests/tooling-ignores.test.ts",
  "tests/verify-bootstrap.test.ts",
  "tests/verify-package.test.ts",
  "tests/workflows.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    // Cleanup is the runner's job, not each test's. A spy, a stubbed env var or
    // a stubbed global that outlives the test that created it turns a later
    // failure into a mystery whose cause is in a different file, and makes the
    // "each test passes when run alone" rule in AGENTS.md unenforceable.
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // A focused test silently shrinks the suite to one case. Failing on it
    // everywhere — not only under CI, which is the default — means the author
    // finds it before the commit rather than the pipeline finding it after.
    allowOnly: false,
    // Two projects, split by what a test actually touches rather than by
    // where it lives: a new test is unit by default, while the explicit
    // automation list receives the long budget only after its I/O needs are
    // known. A hung unit test (no I/O, so it can only be looping or awaiting
    // forever) is a bug that should be visible in seconds. `coverage` below is
    // unaffected by this split — Vitest collects and thresholds coverage once
    // for the whole run, never per project.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [...automationTests, fixtures],
          testTimeout: 5_000,
          hookTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: "automation",
          include: automationTests,
          // Repository automation tests shell out to git/node in temp
          // directories, which is slower than a unit test but must not be
          // allowed to hang CI.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov"],
      // Report every source and automation file, so an untested module shows
      // up as 0% instead of vanishing from the denominator.
      include: ["src/**/*.ts", "scripts/**/*.mjs"],
      // No top-level lines/functions/statements/branches here: Vitest's v8
      // provider checks those against the coverage of *all* included files
      // combined (src and scripts together), which would let a well-tested
      // src/ subsidize an untested scripts/ file or vice versa. Each glob
      // below is its own independent threshold set instead, so src/**,
      // scripts/**, and scripts/lib/guard/** are each judged only against
      // their own coverage.
      thresholds: {
        "src/**/*.ts": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
        // scripts/lib/guard/** is the credential/path-detection rule engine —
        // the most security-critical code in the repository — so it carries a
        // higher floor than the rest of scripts/**. Measured baseline at the
        // time this floor was set: 90.9% statements, 82.35% branches, 100%
        // functions, 90% lines. Each value below is that measurement rounded
        // down to the nearest multiple of 5.
        "scripts/lib/guard/**": {
          lines: 90,
          functions: 100,
          statements: 90,
          branches: 80,
        },
        // Raised again by issue #98, which added dedicated coverage for
        // verify-bootstrap.mjs's main()/run()/assertGenerated(),
        // verify-package.mjs's main()/runCheck(), sync-agents.mjs's
        // main()/listFiles()/assertSourceDirectory(), and smoke-package.mjs's
        // main()/installConsumer()/publicSubpaths() — the functions issue #88
        // deliberately left out of its own, smaller raise. Measured baseline
        // at the time of this raise: 88.52% statements, 80.05% branches,
        // 93.79% functions, 88.48% lines, rounded down to the nearest
        // multiple of 5, the same convention used for both earlier raises
        // (#44, #88). It exists so a new automation script can't ship with
        // zero tests and nothing reporting the number moving;
        // scripts/lib/guard/** also counts toward this aggregate, on top of
        // its own stricter floor above.
        "scripts/**": {
          lines: 85,
          functions: 90,
          statements: 85,
          branches: 80,
        },
      },
    },
  },
});
