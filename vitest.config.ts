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
  "tests/conformance.test.ts",
  "tests/docs.test.ts",
  "tests/emit.test.ts",
  "tests/executor.test.ts",
  "tests/git-env.test.ts",
  "tests/is-main.test.ts",
  "tests/labels.test.ts",
  "tests/node-tools.test.ts",
  "tests/package-smoke.test.ts",
  "tests/package.test.ts",
  "tests/record.test.ts",
  "tests/skills-frontmatter.test.ts",
  "tests/smoke-package.test.ts",
  "tests/sync-agents.test.ts",
  "tests/sync-labels.test.ts",
  "tests/tarball.test.ts",
  "tests/test-cmd.test.ts",
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
        // Raised from 80 once src/ became hookassert's own code rather than the
        // template's sample module. Measured at the time of this raise: 96.88%
        // statements, 91.67% branches, 100% functions, 96.55% lines — the only
        // uncovered line is the `process.exitCode = main(...)` call that runs
        // when the CLI is the process entry point, which no in-process test can
        // reach. 90 sits below every one of those numbers with room for a new
        // module to land slightly under its own eventual coverage, and is not a
        // guess: it is the measurement, not a target invented ahead of one.
        "src/**/*.ts": {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 90,
        },
        // scripts/lib/guard/** is the credential/path-detection rule engine —
        // the most security-critical code in the repository — so it carries a
        // higher floor than the rest of scripts/**. Raised to 90 by issue #22,
        // which added the missing empty-input and no-basename-segment cases
        // for checkCredentials/checkRead/describePath. Measured baseline at
        // the time of this raise: 100% statements, 100% branches, 100%
        // functions, 100% lines — every branch in this file is now covered,
        // so the floor is set at 90 rather than 100 to leave headroom for a
        // future rule this suite has not yet been extended to cover, not
        // because the measurement itself fell short.
        "scripts/lib/guard/**": {
          lines: 90,
          functions: 100,
          statements: 90,
          branches: 90,
        },
        // Raised to 90 by issue #22, mainly by giving check-package.mjs's
        // `main` an injectable repository root (matching sync-agents.mjs's
        // own `main(argv, root = ...)` shape) so its publishable and
        // rejection paths could be driven in-process, plus
        // real coverage for smoke-package.mjs's and package-smoke.mjs's own
        // argument parsing and error paths, sync-labels.mjs's spawnGh, and
        // several small defensive branches (is-main.mjs, tarball.mjs,
        // node-tools.mjs's npmCliPath, check-staged.mjs's git() failures).
        // Measured baseline at the time of this raise: 96.27% statements,
        // 90.26% branches, 99.28% functions, 96.27% lines. Branches — the
        // binding constraint both times this threshold has been raised — sit
        // barely above 90, so the floor is set at a flat 90 across every
        // metric rather than rounded down further: rounding statements,
        // functions and lines down to their own nearest multiple of 5 (95)
        // would leave branches as the one outlier at 90, which reads as an
        // arbitrary exception rather than the uniform floor this raise set
        // out to establish. A few branches remain deliberately uncovered: the
        // `process.exitCode = main(...)` line every CLI entry point guards
        // with `isMain()`, reachable only when the file is the process entry
        // point itself, and smoke-package.mjs's ERR_SMOKE_NO_PACKAGE_NAME
        // path, which only an injected root could reach and this issue's
        // scope limited that injection to check-package.mjs alone (see its
        // PR's UNRESOLVED note). It exists so a new automation script can't
        // ship with zero tests and nothing reporting the number moving;
        // scripts/lib/guard/** also counts toward this aggregate, on top of
        // its own stricter floor above.
        "scripts/**": {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 90,
        },
      },
    },
  },
});
