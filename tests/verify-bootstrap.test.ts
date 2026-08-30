import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";
import {
  assertCopyable,
  assertGenerated,
  copyTemplate,
  listRoutingTableSkillNames,
  main,
  run,
} from "../scripts/verify-bootstrap.mjs";

// This suite itself runs from a git hook (`lefthook.yml` runs `test:related`
// on pre-commit), and git hands a hook GIT_DIR. `copyTemplate` already spawns
// git through `isolatedGitEnv()`, but the fixture repositories below still
// call `git init`/`git add` directly, so those calls need the same isolation —
// see scripts/lib/git-env.mjs and tests/git-env.test.ts.
const directories: string[] = [];

/** A fresh, empty git repository to copy from, isolated from the surrounding one. */
function makeSourceRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-bootstrap-source-"));
  directories.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: isolatedGitEnv() });
  return dir;
}

/** An empty directory to copy into. */
function makeDestination(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-bootstrap-dest-"));
  directories.push(dir);
  return dir;
}

/** Stage a relative path in the fixture repository. */
function stage(source: string, relative: string): void {
  execFileSync("git", ["add", relative], { cwd: source, env: isolatedGitEnv() });
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("copyTemplate", () => {
  it("copies an ordinary tracked file", () => {
    const source = makeSourceRepo();
    const destination = makeDestination();
    writeFileSync(path.join(source, "kept.txt"), "hello\n");
    stage(source, "kept.txt");

    copyTemplate(destination, source);

    expect(readFileSync(path.join(destination, "kept.txt"), "utf8")).toBe("hello\n");
  });

  it("skips a stale index entry whose file was removed without a commit", () => {
    const source = makeSourceRepo();
    const destination = makeDestination();
    const removed = path.join(source, "removed.txt");
    writeFileSync(removed, "gone\n");
    stage(source, "removed.txt");
    rmSync(removed);

    expect(() => copyTemplate(destination, source)).not.toThrow();
    expect(existsSync(path.join(destination, "removed.txt"))).toBe(false);
  });

  it("refuses a tracked dangling symlink instead of silently skipping it", () => {
    const source = makeSourceRepo();
    const destination = makeDestination();
    symlinkSync("does-not-exist", path.join(source, "dangling-link"));
    stage(source, "dangling-link");

    expect(() => copyTemplate(destination, source)).toThrow(
      /ERR_BOOTSTRAP_UNSUPPORTED_ENTRY/,
    );
    expect(existsSync(path.join(destination, "dangling-link"))).toBe(false);
  });

  it("refuses a tracked symlink to a directory instead of throwing a bare EISDIR", () => {
    const source = makeSourceRepo();
    const destination = makeDestination();
    mkdirSync(path.join(source, "real-dir"));
    symlinkSync("real-dir", path.join(source, "link-to-dir"), "dir");
    stage(source, "link-to-dir");

    expect(() => copyTemplate(destination, source)).toThrow(
      /ERR_BOOTSTRAP_UNSUPPORTED_ENTRY/,
    );
  });

  // `git`'s own untracked-file walk drops a genuine socket before it ever
  // reaches `ls-files --others` (confirmed against the git this suite runs
  // under: neither `ls-files --others` nor `git add` will surface one), so
  // this exercises `assertCopyable` directly rather than through
  // `copyTemplate`. It reproduces the shape of the failure found while
  // shipping #67 — an untracked `.pnpm-store/` holding a unix socket, where
  // the old `existsSync` guard let a bare ENOTSUP take down the suite — for
  // whichever entry point a non-regular file does reach this check through.
  it.skipIf(process.platform === "win32")(
    "refuses a non-regular file such as a unix socket",
    async () => {
      const source = makeSourceRepo();
      const socketPath = path.join(source, "untracked.sock");
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });

        expect(() => assertCopyable(socketPath, "untracked.sock")).toThrow(
          /ERR_BOOTSTRAP_UNSUPPORTED_ENTRY/,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe("assertCopyable", () => {
  it("returns true for a regular file", () => {
    const source = makeSourceRepo();
    const file = path.join(source, "kept.txt");
    writeFileSync(file, "hello\n");

    expect(assertCopyable(file, "kept.txt")).toBe(true);
  });

  it("returns false for a path that no longer exists", () => {
    const source = makeSourceRepo();

    expect(assertCopyable(path.join(source, "missing.txt"), "missing.txt")).toBe(false);
  });
});

describe("run", () => {
  it("does not throw when the command exits 0", () => {
    const cwd = makeDestination();

    expect(() => run(process.execPath, ["-e", "process.exit(0)"], cwd)).not.toThrow();
  });

  it("throws ERR_BOOTSTRAP_E2E naming the command and exit code when it fails", () => {
    const cwd = makeDestination();

    expect(() => run(process.execPath, ["-e", "process.exit(3)"], cwd)).toThrow(
      /ERR_BOOTSTRAP_E2E:.*exit 3/,
    );
  });
});

describe("listRoutingTableSkillNames", () => {
  it("reads every backticked name in the first column under the Skills heading", () => {
    const source =
      "## Skills\n\n" +
      "| Skill | Load it when you are working on |\n" +
      "| --- | --- |\n" +
      "| `writing-typescript` | a module under `src/**/*.ts` |\n" +
      "| `writing-tests` | the body of a test under `tests/` |\n" +
      "\n## Security\n\n" +
      "| `not-a-skill` | this row is outside the Skills section |\n";

    expect(listRoutingTableSkillNames(source)).toEqual([
      "writing-typescript",
      "writing-tests",
    ]);
  });

  it("returns an empty list when the file has no Skills heading", () => {
    expect(listRoutingTableSkillNames("# AGENTS.md\n")).toEqual([]);
  });
});

describe("assertGenerated", () => {
  /**
   * A minimal fixture tree that satisfies every check `assertGenerated`
   * makes: the four marker targets (with no residual marker text), a
   * changelog with no version heading, and a manifest naming `packageName`
   * at version 0.0.0 with no bin and sideEffects: false. `manifestOverrides`
   * is merged onto that base manifest so a test can deviate a single field
   * without duplicating the whole shape.
   */
  function writeValidFixture(
    destination: string,
    packageName: string,
    manifestOverrides: Record<string, unknown> = {},
  ): void {
    for (const relative of [
      "AGENTS.md",
      "README.md",
      "CONTRIBUTING.md",
      ".github/workflows/ci.yml",
    ]) {
      const target = path.join(destination, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `# ${relative}\n`);
    }
    writeFileSync(
      path.join(destination, "CHANGELOG.md"),
      "# Changelog\n\nAll notable changes are documented here.\n",
    );
    writeFileSync(
      path.join(destination, "package.json"),
      `${JSON.stringify(
        {
          name: packageName,
          version: "0.0.0",
          sideEffects: false,
          ...manifestOverrides,
        },
        null,
        2,
      )}\n`,
    );
  }

  it("passes for a well-formed generated repository", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");

    expect(() => assertGenerated(destination, "acme-node-library")).not.toThrow();
  });

  it("throws ERR_PLACEHOLDER_REMAINING when a placeholder target still holds a placeholder", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");
    // README.md is both a marker target and a placeholder target; "my-package"
    // mirrors bootstrap.mjs's own TEMPLATE_PACKAGE constant.
    writeFileSync(path.join(destination, "README.md"), "# my-package\n");

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_PLACEHOLDER_REMAINING/,
    );
  });

  it("throws ERR_BOOTSTRAP_MARKER when a marker target retains a bootstrap marker", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");
    writeFileSync(
      path.join(destination, ".github", "workflows", "ci.yml"),
      "# template-only block\n",
    );

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_BOOTSTRAP_MARKER/,
    );
  });

  it("throws ERR_RELEASE_INTENT_PATH_REMAINING when the legacy .changeset directory remains", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");
    mkdirSync(path.join(destination, ".changeset"), { recursive: true });

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_RELEASE_INTENT_PATH_REMAINING/,
    );
  });

  it("throws ERR_BOOTSTRAP_SCRIPT_REMAINING when scripts/bootstrap.mjs remains", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");
    mkdirSync(path.join(destination, "scripts"), { recursive: true });
    writeFileSync(path.join(destination, "scripts", "bootstrap.mjs"), "export {};\n");

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_BOOTSTRAP_SCRIPT_REMAINING/,
    );
  });

  it("passes when every routed skill in AGENTS.md's Skills table has a directory", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");
    writeFileSync(
      path.join(destination, "AGENTS.md"),
      "## Skills\n\n" +
        "| Skill | Load it when you are working on |\n" +
        "| --- | --- |\n" +
        "| `writing-typescript` | a module under `src/**/*.ts` |\n",
    );
    mkdirSync(path.join(destination, ".agents", "skills", "writing-typescript"), {
      recursive: true,
    });

    expect(() => assertGenerated(destination, "acme-node-library")).not.toThrow();
  });

  it("throws ERR_BOOTSTRAP_STALE_SKILL_ROUTE when a routed skill has no directory", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");
    // Same shape as an unremoved SELF_REMOVED_PATHS entry would leave behind:
    // a row naming a skill whose directory bootstrap already removed.
    writeFileSync(
      path.join(destination, "AGENTS.md"),
      "## Skills\n\n" +
        "| Skill | Load it when you are working on |\n" +
        "| --- | --- |\n" +
        "| `bootstrapping-the-template` | the bootstrap flow |\n",
    );

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_BOOTSTRAP_STALE_SKILL_ROUTE/,
    );
  });

  it("throws ERR_CHANGELOG_ENTRY_REMAINING when the changelog retains a version heading", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");
    writeFileSync(
      path.join(destination, "CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 - 2024-01-01\n",
    );

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_CHANGELOG_ENTRY_REMAINING/,
    );
  });

  it("throws ERR_MANIFEST_SHAPE when package.json does not parse to an object", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library");
    writeFileSync(path.join(destination, "package.json"), "null\n");

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_MANIFEST_SHAPE/,
    );
  });

  it("throws ERR_PACKAGE_NAME when package.json#name does not match", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "some-other-name");

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_PACKAGE_NAME/,
    );
  });

  it("throws ERR_VERSION_REMAINING when package.json#version is not 0.0.0", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library", { version: "1.0.0" });

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_VERSION_REMAINING/,
    );
  });

  it("throws ERR_BIN_REMAINING when package.json still declares bin", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library", { bin: "./dist/cli.js" });

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_BIN_REMAINING/,
    );
  });

  it("accepts a CLI-shaped generated repository", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library", {
      bin: { "acme-node-library": "./dist/cli.js" },
    });
    mkdirSync(path.join(destination, "src"), { recursive: true });
    writeFileSync(path.join(destination, "src", "cli.ts"), "export {};");

    expect(() => assertGenerated(destination, "acme-node-library", true)).not.toThrow();
  });

  it("accepts a generated Node floor whose CI package-smoke leg uses the same major", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library", {
      engines: { node: ">=20" },
    });
    writeFileSync(
      path.join(destination, ".github", "workflows", "ci.yml"),
      [
        "jobs:",
        "  package-floor:",
        "    steps:",
        "      - uses: actions/setup-node@sha # v1.0.0",
        "        with:",
        "          node-version: 20",
        "      - run: pnpm --config.runtime-on-fail=ignore run package:smoke -- --pack-dir .smoke",
        "",
      ].join("\n"),
    );

    expect(() => assertGenerated(destination, "acme-node-library")).not.toThrow();
  });

  it("throws ERR_NODE_ENGINES_CI_MISMATCH when the generated CI floor drifts", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library", {
      engines: { node: ">=20" },
    });
    writeFileSync(
      path.join(destination, ".github", "workflows", "ci.yml"),
      "  package-floor:\n    node-version: 24\n    run: pnpm run package:smoke\n",
    );

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_NODE_ENGINES_CI_MISMATCH/,
    );
  });

  it("throws ERR_BIN_REMAINING when a CLI package has no emitted CLI entry", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library", {
      bin: { "acme-node-library": "./dist/other.js" },
    });
    mkdirSync(path.join(destination, "src"), { recursive: true });
    writeFileSync(path.join(destination, "src", "cli.ts"), "export {};");

    expect(() => assertGenerated(destination, "acme-node-library", true)).toThrow(
      /ERR_BIN_REMAINING/,
    );
  });

  it("throws ERR_SIDE_EFFECTS_REMAINING when package.json#sideEffects is not false", () => {
    const destination = makeDestination();
    writeValidFixture(destination, "acme-node-library", { sideEffects: undefined });

    expect(() => assertGenerated(destination, "acme-node-library")).toThrow(
      /ERR_SIDE_EFFECTS_REMAINING/,
    );
  });
});

describe("main", () => {
  it("bootstraps both profiles into a disposable workspace and validates the result", () => {
    // A real, fast (well under a second) end-to-end run: main() copies this
    // repository's own tracked files, runs the real scripts/bootstrap.mjs
    // subprocess against each profile, and validates the result with
    // assertGenerated. This exercises main()'s full orchestration and both
    // run()/assertGenerated() success paths without any mocking.
    expect(main()).toBe(0);
  });
});
