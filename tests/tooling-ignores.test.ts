import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { getFileInfo } from "prettier";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config.js";

// The skills are authored under `.agents/skills/` and mirrored into
// `.claude/skills/` by `pnpm agents:sync`. Both tools must therefore see the
// real files and ignore the generated copy: linting or reformatting the mirror
// reports the same finding twice, at a path nobody may edit, and a Prettier
// rewrite of the copy alone is drift the sync check then has to undo. What
// must not come back is the opposite ignore: a skill file that is checked
// nowhere drifts unlinted and unformatted with CI green.
//
// Both tools are asked through their own APIs rather than by spawning their
// CLIs. A subprocess reports "ignored" and "could not run at all" with the same
// exit code, so an exit-status assertion passes on a run where the tool never
// started — which is what the minimum-Node CI leg does to a nested `pnpm exec`.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const source = ".agents/skills/merge-dependabot";
const mirror = ".claude/skills/merge-dependabot";
const fixtures = "tests/fixtures/";

type RuleSetting = number | readonly [number, ...unknown[]];

interface EffectiveConfig {
  rules?: Record<string, RuleSetting | undefined>;
}

function ruleSeverity(setting: RuleSetting | undefined): number | undefined {
  return typeof setting === "number" ? setting : setting?.[0];
}

const eslint = new ESLint({ cwd: repoRoot });

function readKey(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The `exclude` list of vitest.config.ts's `unit` project. */
function unitProjectExclude(): readonly string[] {
  const projects = readKey(readKey(vitestConfig, "test"), "projects");
  // The `every` predicate is what narrows `Array.isArray`'s `any[]`.
  if (
    !Array.isArray(projects) ||
    !projects.every(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    )
  ) {
    throw new TypeError("vitest.config.ts must declare test.projects");
  }
  const unit = projects.find(
    (project) => readKey(readKey(project, "test"), "name") === "unit",
  );
  const exclude = readKey(readKey(unit, "test"), "exclude");
  if (
    !Array.isArray(exclude) ||
    !exclude.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new TypeError("the unit project's exclude must be an array of strings");
  }
  return exclude;
}

function ignoredByEslint(relative: string): Promise<boolean> {
  return eslint.isPathIgnored(path.join(repoRoot, relative));
}

async function ignoredByPrettier(relative: string): Promise<boolean> {
  const info = await getFileInfo(path.join(repoRoot, relative), {
    ignorePath: path.join(repoRoot, ".prettierignore"),
  });
  return info.ignored;
}

describe("the .claude/skills ignore entry in eslint.config.mjs", () => {
  // Every path here is `.mjs` on purpose. ESLint answers `isPathIgnored: true`
  // for anything no flat-config entry matches, so a `.md` or `.py` probe comes
  // back ignored whether or not the ignore list mentions it — see the last case
  // in this block, which pins that behavior so the trap stays visible.
  it.each([
    ["a file directly under the source directory", ".agents/skills/codex-only.mjs"],
    ["a file in a source skill directory", `${source}/scripts/survey-prs.mjs`],
    ["a nested file in a source skill", `${source}/lib/nested/helper.mjs`],
  ])("lints %s", async (_label, relative) => {
    expect(await ignoredByEslint(relative)).toBe(false);
  });

  it.each([
    ["a file inside the mirror", `${mirror}/scripts/survey-prs.mjs`],
    ["a nested file inside the mirror", `${mirror}/lib/nested/helper.mjs`],
  ])("still ignores %s", async (_label, relative) => {
    expect(await ignoredByEslint(relative)).toBe(true);
  });

  it("reports any path it has no configuration for as ignored", async () => {
    // Why the cases above are restricted to `.mjs`: this file is under the
    // linted source tree and would still answer `true` on an empty ignore list.
    await expect(ignoredByEslint(`${source}/SKILL.md`)).resolves.toBe(true);
  });
});

describe("the CLI-only no-console boundary in eslint.config.mjs", () => {
  it.each([
    ["the CLI entry", "src/cli.ts", 0],
    ["a nested CLI module", "src/cli/commands.ts", 0],
    ["the public library entry", "src/index.ts", 2],
    ["a private library module", "src/internal/assert.ts", 2],
  ])("sets no-console to %s for %s", async (_label, relative, expected) => {
    const config = (await eslint.calculateConfigForFile(
      path.join(repoRoot, relative),
    )) as EffectiveConfig;
    const setting = config.rules?.["no-console"];
    expect(ruleSeverity(setting)).toBe(expected);
  });
});

describe("the .claude/skills entry in .prettierignore", () => {
  // Prettier's `ignored` reflects the ignore file alone — whether it knows a
  // parser for the extension is a separate field — so any path discriminates.
  it.each([
    ["a file directly under the source directory", ".agents/skills/codex-only.mjs"],
    ["a Markdown file in a source skill", `${source}/SKILL.md`],
    ["a nested reference in a source skill", `${source}/references/failure-modes.md`],
  ])("formats %s", async (_label, relative) => {
    expect(await ignoredByPrettier(relative)).toBe(false);
  });

  it.each([
    ["the mirror directory itself", mirror],
    ["a file inside the mirror", `${mirror}/SKILL.md`],
    ["a nested file inside the mirror", `${mirror}/scripts/survey.py`],
  ])("still ignores %s", async (_label, relative) => {
    expect(await ignoredByPrettier(relative)).toBe(true);
  });

  it("ignores the invalid JSON fixture", async () => {
    expect(await ignoredByPrettier(`${fixtures}broken.json`)).toBe(true);
  });
});

/**
 * Pull the quoted entries out of `typos.toml`'s `[files].extend-exclude`
 * array. Not a general TOML parser — the array is a flat list of quoted
 * strings, same shape as `scripts/lib/labels-manifest.mjs`'s hand-rolled
 * scanner for `.github/labels.yml`, for the same reason: a dependency is a
 * bigger cost than a few lines of line scanning for a fixed, small shape.
 */
function typosExtendExclude(): string[] {
  const text = readFileSync(path.join(repoRoot, "typos.toml"), "utf8");
  const match = /extend-exclude\s*=\s*\[([\s\S]*?)\]/.exec(text);
  const body = match?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? "");
}

describe("the generated/ignored tree stays consistent across tooling", () => {
  // Build/doc output nobody commits: .gitignore keeps it out of git
  // entirely, so there is nothing in it for ESLint, Prettier, or typos to
  // usefully check either.
  const BUILD_OUTPUT = ["dist/", "coverage/", "docs/api/"];

  // The opposite case: `.claude/skills/` IS tracked (AGENTS.md — both the
  // authored `.agents/skills/` and its generated mirror are committed real
  // files), so it must NOT appear in .gitignore. But every tool that would
  // otherwise check its content redundantly must still skip it, exactly like
  // the ESLint/Prettier describe blocks above already assert.
  const GENERATED_MIRROR = ".claude/skills/";

  const gitignoreLines = readFileSync(path.join(repoRoot, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const typosExclude = typosExtendExclude();

  it.each(BUILD_OUTPUT)(
    "%s is ignored by git, ESLint, Prettier, and typos alike",
    async (entry) => {
      expect(gitignoreLines).toContain(entry);
      expect(await ignoredByEslint(`${entry}probe.mjs`)).toBe(true);
      expect(await ignoredByPrettier(`${entry}probe.mjs`)).toBe(true);
      expect(typosExclude).toContain(entry);
    },
  );

  it("does not gitignore the tracked .claude/skills mirror", () => {
    expect(gitignoreLines).not.toContain(GENERATED_MIRROR);
  });

  it("excludes the tracked-but-generated .claude/skills mirror from typos, like ESLint and Prettier already do", () => {
    expect(typosExclude).toContain(GENERATED_MIRROR);
  });

  it("excludes test fixtures from typos", () => {
    expect(typosExclude).toContain(fixtures);
  });

  // A file lands there because it is malformed, deliberately failing, or
  // written for another toolchain. All five tools are asserted together so they
  // cannot drift apart.
  describe("tests/fixtures/ is data under test for every tool", () => {
    it("is not linted by ESLint", async () => {
      expect(await ignoredByEslint(`${fixtures}project/src/leaky.ts`)).toBe(true);
    });

    it("is not formatted by Prettier", async () => {
      expect(await ignoredByPrettier(`${fixtures}project/src/leaky.ts`)).toBe(true);
    });

    it("is not type-checked by TypeScript, while the rest of tests/ still is", () => {
      const workspace = mkdtempSync(path.join(tmpdir(), "tsconfig-fixtures-glob-"));
      try {
        mkdirSync(path.join(workspace, "tests/fixtures/project"), { recursive: true });
        writeFileSync(
          path.join(workspace, "tests/fixtures/project/broken.ts"),
          "export const wrong: number = 'not a number';\n",
        );
        writeFileSync(path.join(workspace, "tests/real.test.ts"), "export {};\n");

        const parsed = ts.parseJsonConfigFileContent(
          { include: ["tests"], exclude: excludeSpec() },
          ts.sys,
          workspace,
        );
        const found = new Set(
          parsed.fileNames.map((file) =>
            path.relative(workspace, file).replace(/\\/g, "/"),
          ),
        );

        expect(found.has("tests/fixtures/project/broken.ts")).toBe(false);
        expect(found.has("tests/real.test.ts")).toBe(true);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("is not collected as a test by the unit Vitest project", () => {
      expect(unitProjectExclude()).toContain(`${fixtures}**`);
    });
  });

  it("dropped the stale .rehearsal/ entry now that publish-rehearsal.mjs is gone", () => {
    expect(gitignoreLines).not.toContain(".rehearsal/");
  });
});

// Hoisted: two describe blocks below replay this exclude spec.
const configFile = ts.readConfigFile(path.join(repoRoot, "tsconfig.json"), (file) =>
  ts.sys.readFile(file),
);

function excludeSpec(): readonly string[] {
  const config: unknown = configFile.config;
  const exclude =
    typeof config === "object" && config !== null && "exclude" in config
      ? config.exclude
      : undefined;
  if (
    !Array.isArray(exclude) ||
    !exclude.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new TypeError("tsconfig.json's exclude must be an array of strings");
  }
  return exclude;
}

describe("the .claude/skills bridge in tsconfig.json", () => {
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const resolved = new Set(
    parsed.fileNames.map((file) => path.relative(repoRoot, file).replace(/\\/g, "/")),
  );

  it("type-checks the authored skill source", () => {
    expect(resolved.has(`${source}/scripts/survey-prs.mjs`)).toBe(true);
  });

  it("does not double-report the byte-identical mirror", () => {
    expect(resolved.has(`${mirror}/scripts/survey-prs.mjs`)).toBe(false);
  });

  it("names .claude/skills in include and a structural glob (not a per-skill name) in exclude", () => {
    // The exclude entry is a structural pattern -- "anything nested inside an
    // immediate subdirectory of .claude/skills" -- not a hand-maintained list
    // of skill names. It must generalize to a skill that does not exist yet
    // (proved below via a synthetic directory) while still leaving a
    // hypothetical Codex-only file added directly under .claude/skills/
    // (outside any subdirectory) covered by include and unmatched by exclude.
    const config: unknown = configFile.config;
    const include =
      typeof config === "object" && config !== null && "include" in config
        ? config.include
        : undefined;
    // Exact, not `toContain`: the property pinned is that no per-skill name
    // has crept into the list.
    expect(include).toContain(".claude/skills");
    expect(excludeSpec()).toEqual([".claude/skills/*/**/*", "tests/fixtures/**"]);
  });

  describe("generalizes to a skill that does not exist on disk", () => {
    // tsconfig.json's own `exclude` array (the JSONC-parsed value above, not
    // a copy re-typed here) is replayed through `ts.parseJsonConfigFileContent`
    // itself -- the same call `configFile`/`parsed` above make against the
    // real repository -- against a throwaway directory tree that mirrors
    // `.claude/skills/`'s shape but contains a skill name
    // ("hypothetical-skill") this repository has never had. This proves the
    // pattern's genericity through TypeScript's own config parser rather than
    // by re-implementing glob semantics (e.g. Node's `path.matchesGlob`,
    // which was tried first and rejected: it disagrees with
    // `ts.parseJsonConfigFileContent` on this exact repository's rejected
    // candidate pattern `.claude/skills/*/**`, proving the two glob dialects
    // are not interchangeable for this case).
    const workspaces: string[] = [];

    afterEach(() => {
      while (workspaces.length > 0) {
        const dir = workspaces.pop();
        if (dir !== undefined) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // `basePath` is set to the directory containing tsconfig.json (the
    // repository root in the real config, the workspace root here) -- not
    // `.claude/skills` -- because both `include` and the exclude spec
    // (".claude/skills/*/**/*") are written relative to that root. Matching
    // that call shape here, rather than scoping `basePath` to `.claude/skills`
    // itself, is what makes this a faithful replay of the real matching.
    function readWorkspaceMjsFiles(workspaceRoot: string): Set<string> {
      const config = {
        compilerOptions: { allowJs: true },
        include: [".claude/skills"],
        exclude: excludeSpec(),
      };
      const parsed = ts.parseJsonConfigFileContent(config, ts.sys, workspaceRoot);
      return new Set(
        parsed.fileNames.map((file) =>
          path.relative(workspaceRoot, file).replace(/\\/g, "/"),
        ),
      );
    }

    function makeSkillsWorkspace(): string {
      const workspace = mkdtempSync(path.join(tmpdir(), "tsconfig-skills-glob-"));
      workspaces.push(workspace);
      mkdirSync(path.join(workspace, ".claude/skills"), { recursive: true });
      return workspace;
    }

    it("excludes a nested file under a brand-new skill directory", () => {
      const workspace = makeSkillsWorkspace();
      const skillsRoot = path.join(workspace, ".claude/skills");
      mkdirSync(path.join(skillsRoot, "hypothetical-skill/nested"), {
        recursive: true,
      });
      writeFileSync(
        path.join(skillsRoot, "hypothetical-skill/anything.mjs"),
        "// probe\n",
      );
      writeFileSync(
        path.join(skillsRoot, "hypothetical-skill/nested/deeper.mjs"),
        "// probe\n",
      );

      const found = readWorkspaceMjsFiles(workspace);

      expect(found.has(".claude/skills/hypothetical-skill/anything.mjs")).toBe(false);
      expect(found.has(".claude/skills/hypothetical-skill/nested/deeper.mjs")).toBe(
        false,
      );
    });

    it("still includes a file placed directly under .claude/skills, outside any subdirectory", () => {
      const workspace = makeSkillsWorkspace();
      const skillsRoot = path.join(workspace, ".claude/skills");
      writeFileSync(path.join(skillsRoot, "codex-only.mjs"), "// probe\n");

      const found = readWorkspaceMjsFiles(workspace);

      expect(found.has(".claude/skills/codex-only.mjs")).toBe(true);
    });
  });
});
