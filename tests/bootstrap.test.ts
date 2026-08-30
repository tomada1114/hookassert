import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import process from "node:process";

import { format, getFileInfo, resolveConfig } from "prettier";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BootstrapError,
  bootstrap,
  deriveNames,
  findPlaceholders,
  normalizeRelativePath,
  parseArguments,
  promptArguments,
  removeSelfReferentialLines,
  repadMarkdownTable,
  validatePackageName,
} from "../scripts/bootstrap.mjs";
import { copyTemplate as copyTrackedFiles } from "../scripts/verify-bootstrap.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const LEGACY_RELEASE_DIRECTORY = ".change" + "set";
const workspaces: string[] = [];

// The suite itself runs from a git hook (`lefthook.yml` runs `test:related` on
// pre-commit), and git hands a hook GIT_DIR and, for a partial
// `git commit -- <path>`, GIT_INDEX_FILE. `scripts/check-staged.mjs`
// is meant to honor those — it is the pre-commit layer. Here they must go, or
// the fixture repositories below are built inside the checkout this suite is
// running in. See scripts/lib/git-env.mjs.
function clearGitEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) {
      vi.stubEnv(name, undefined);
    }
  }
}

beforeEach(clearGitEnvironment);

function copyTemplate(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "typescript-template-test-"));
  workspaces.push(workspace);
  copyTrackedFiles(workspace, repoRoot);
  const binary = path.join(workspace, "tests", "fixtures", "binary.dat");
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(
    binary,
    Buffer.from([0, 255, 1, 2, 109, 121, 45, 112, 97, 99, 107, 97, 103, 101]),
  );

  return workspace;
}

function relativeFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(path.relative(root, absolute));
      }
    }
  };
  visit(path.join(root, directory));
  return files.sort();
}

function allFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files;
}

// Generalizes #103's single-file AGENTS.md byte-identity assertion: every
// text file Prettier would touch in a real, generated repository must
// already be in the shape `prettier --check .` expects, or a forker's first
// `pnpm check:quick` fails on a file they never edited (see #111). Honors
// the generated tree's own `.gitignore`/`.prettierignore` and Prettier's
// parser inference exactly the way the `prettier` CLI does, so build output,
// the generated `.claude/skills/` mirror, and binary fixtures are skipped
// the same way `pnpm format:check` skips them.
async function assertGeneratedTreeIsFormatted(root: string): Promise<void> {
  const ignorePath = [".gitignore", ".prettierignore"]
    .map((name) => path.join(root, name))
    .filter((candidate) => existsSync(candidate));
  for (const absolute of allFiles(root)) {
    const info = await getFileInfo(absolute, { ignorePath });
    if (info.ignored || info.inferredParser === null) {
      continue;
    }
    const buffer = readFileSync(absolute);
    if (buffer.includes(0)) {
      continue;
    }
    const original = buffer.toString("utf8");
    const formatted = await format(original, {
      ...(await resolveConfig(absolute)),
      filepath: absolute,
    });
    expect(formatted, `${path.relative(root, absolute)} is not Prettier-clean`).toBe(
      original,
    );
  }
}

function aiLayerFiles(root: string): string[] {
  return [
    "AGENTS.md",
    "CLAUDE.md",
    ...relativeFiles(root, ".claude"),
    ...relativeFiles(root, ".agents"),
  ];
}

function options(
  packageName: string,
  profile: "node-library" | "universal-library",
  cli: "yes" | "no" = "no",
  nodeEngines?: string,
): ReturnType<typeof parseArguments> {
  const argv = [
    packageName,
    "--profile",
    profile,
    "--author",
    "Ada Lovelace",
    "--email",
    "ada@example.com",
    "--github-user",
    "ada",
    "--license",
    "MIT",
  ];
  if (cli === "yes") {
    argv.push("--cli", cli);
  }
  if (nodeEngines !== undefined) {
    argv.push("--node-engines", nodeEngines);
  }
  return parseArguments(argv);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("bootstrap validation", () => {
  it.each([
    "",
    "../evil",
    "Uppercase",
    "@scope",
    "@scope/",
    "name with spaces",
    "node_modules",
    "a".repeat(215),
  ])("rejects invalid package name %j", (name) => {
    expect(() => validatePackageName(name)).toThrow(BootstrapError);
  });

  it("derives safe names for a scoped package", () => {
    expect(deriveNames("@acme/widgets")).toEqual({
      unscoped: "widgets",
      identifier: "widgets",
      tarball: "acme-widgets",
    });
  });

  it("normalizes Windows separators without accepting traversal", () => {
    expect(normalizeRelativePath(".\\docs\\reference.md")).toBe("docs/reference.md");
    expect(() => validatePackageName("..\\evil")).toThrow(BootstrapError);
  });

  it("re-pads a table after its widest row is removed", () => {
    expect(
      removeSelfReferentialLines(
        [
          "| Skill                        | Load it when |",
          "| ---------------------------- | ------------ |",
          "| `writing-tests`              | a test       |",
          "| `bootstrapping-the-template` | the flow     |",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "| Skill           | Load it when |",
        "| --------------- | ------------ |",
        "| `writing-tests` | a test       |",
        "",
      ].join("\n"),
    );
  });

  it("keeps a delimiter row's alignment markers when re-padding", () => {
    expect(repadMarkdownTable(["| a | bbbb |", "| :-: | ---: |", "| c | d |"])).toEqual(
      ["|  a  | bbbb |", "| :-: | ---: |", "|  c  |    d |"],
    );
  });

  it("uses the default description when it is omitted", () => {
    const parsed = options("acme-library", "node-library");
    expect(parsed.description).toBe("A TypeScript package.");
  });

  it("defaults to no CLI and accepts a Node CLI option", () => {
    expect(options("library-package", "node-library").cli).toBe(false);
    expect(options("cli-package", "node-library", "yes").cli).toBe(true);
  });

  it("defaults the published Node floor to 24 and accepts a lower floor", () => {
    expect(options("library-package", "node-library").nodeEngines).toBe(">=24");
    expect(options("older-library", "node-library", "no", ">=20").nodeEngines).toBe(
      ">=20",
    );
  });

  it.each(["20", ">=", ">=20.1", ">=20 <24"])(
    "rejects a non-bare Node floor %j",
    (nodeEngines) => {
      expect(() => options("invalid-floor", "node-library", "no", nodeEngines)).toThrow(
        /ERR_NODE_ENGINES_INVALID/,
      );
    },
  );

  it("rejects an unsupported CLI option value", () => {
    expect(() =>
      parseArguments([
        "cli-package",
        "--profile",
        "node-library",
        "--cli",
        "maybe",
        "--author",
        "Ada Lovelace",
        "--email",
        "ada@example.com",
        "--github-user",
        "ada",
        "--license",
        "MIT",
      ]),
    ).toThrow(/ERR_CLI_INVALID/);
  });

  it("refuses a CLI for the universal-library profile with its own error", () => {
    expect(() => options("universal-cli", "universal-library", "yes")).toThrow(
      /ERR_CLI_UNSUPPORTED/,
    );
  });

  it("collects package metadata through the interactive prompts", async () => {
    const answers = [
      "interactive-package",
      "universal-library",
      "",
      "",
      "Ada Lovelace",
      "ada@example.com",
      "ada",
      "ISC",
      "An interactive package.",
    ];
    const prompts: string[] = [];
    const parsed = await promptArguments((prompt) => {
      prompts.push(prompt);
      return Promise.resolve(answers.shift() ?? "");
    });

    expect(parsed).toMatchObject({
      packageName: "interactive-package",
      profile: "universal-library",
      author: "Ada Lovelace",
      email: "ada@example.com",
      githubUser: "ada",
      license: "ISC",
      description: "An interactive package.",
    });
    expect(prompts).toEqual([
      "Package name: ",
      "Profile [node-library]: ",
      "CLI [no]: ",
      "Node engines [>=24]: ",
      "Author name: ",
      "Author email: ",
      "GitHub user: ",
      "License [MIT]: ",
      "Description [A TypeScript package.]: ",
    ]);
  });

  it("uses interactive input when the command has no arguments", () => {
    const root = copyTemplate();
    const output = execFileSync(process.execPath, ["scripts/bootstrap.mjs"], {
      cwd: root,
      encoding: "utf8",
      input:
        [
          "interactive-package",
          "",
          "",
          "",
          "Ada Lovelace",
          "ada@example.com",
          "ada",
          "",
          "",
        ].join("\n") + "\n",
    });

    expect(output).toContain("Bootstrapped interactive-package as node-library.");
    expect(
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")),
    ).toMatchObject({
      name: "interactive-package",
      license: "MIT",
      description: "A TypeScript package.",
    });
  });

  it("rejects unknown options instead of silently ignoring them", () => {
    expect(() =>
      parseArguments([
        "acme-library",
        "--profile",
        "node-library",
        "--author",
        "Ada Lovelace",
        "--email",
        "ada@example.com",
        "--github-user",
        "ada",
        "--license",
        "MIT",
        "--typo",
        "value",
      ]),
    ).toThrow(/ERR_ARGUMENT_UNKNOWN/);
  });
});

describe("bootstrap profiles", () => {
  it.each([
    ["acme-library", "node-library", "no"],
    ["acme-cli", "node-library", "yes"],
    ["browser-kit", "universal-library", "no"],
  ] as const)("generates %s as %s (%s CLI)", async (packageName, profile, cli) => {
    const root = copyTemplate();
    const binaryBefore = readFileSync(
      path.join(root, "tests", "fixtures", "binary.dat"),
    );
    const stableAiFiles = aiLayerFiles(root)
      .filter(
        (file) =>
          (file.startsWith(".claude/skills/") || file.startsWith(".agents/skills/")) &&
          // bootstrapping-the-template documents the bootstrap flow itself, so
          // it self-removes along with scripts/bootstrap.mjs (see
          // SELF_REMOVED_PATHS) rather than staying stable across a run.
          !file.includes("/skills/bootstrapping-the-template/"),
      )
      .map((file) => [file, readFileSync(path.join(root, file), "utf8")] as const);
    bootstrap(root, options(packageName, profile, cli));

    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      packageManager?: string;
      dependencies?: Record<string, string>;
      bin?: Record<string, string>;
      devEngines: { runtime: { onFail: string } };
      engines?: Record<string, string>;
      sideEffects: false | string[];
      repository: { url: string };
    };
    expect(manifest.name).toBe(packageName);
    expect(manifest.version).toBe("0.0.0");
    // Corepack and Dependabot read this field and both need an exact version.
    expect(manifest.packageManager).toBe("pnpm@11.18.0");
    expect(manifest.devEngines.runtime.onFail).toBe("error");
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.repository.url).not.toContain("@acme/");
    expect(findPlaceholders(root)).toEqual([]);
    expect(readFileSync(path.join(root, "tests", "fixtures", "binary.dat"))).toEqual(
      binaryBefore,
    );
    expect(existsSync(path.join(root, LEGACY_RELEASE_DIRECTORY))).toBe(false);
    expect(readFileSync(path.join(root, "README.md"), "utf8")).not.toContain(
      "Use this template",
    );
    // Bootstrap's own script has nothing left to do in a generated repository
    // and is never referenced again, so it removes itself.
    expect(existsSync(path.join(root, "scripts", "bootstrap.mjs"))).toBe(false);
    // The skill documenting the bootstrap flow has nothing left to document
    // once that flow's own files are gone, so it self-removes too.
    expect(
      existsSync(path.join(root, ".agents", "skills", "bootstrapping-the-template")),
    ).toBe(false);
    expect(
      existsSync(path.join(root, ".claude", "skills", "bootstrapping-the-template")),
    ).toBe(false);
    // AGENTS.md's own routing row and Quick reference line must go with the
    // skill and script they name, or a forker's first `pnpm check` sees a
    // Skills table row pointing at a directory that no longer exists.
    const generatedAgentsMd = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(generatedAgentsMd).not.toContain("bootstrapping-the-template");
    expect(generatedAgentsMd).not.toContain("bootstrap:e2e");
    expect(readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8")).not.toContain(
      "Bootstrap profiles",
    );
    const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).not.toMatch(/^## /m);
    expect(changelog).not.toContain("0.1.1");
    expect(changelog).toContain("Keep a Changelog");

    for (const [file, contents] of stableAiFiles) {
      expect(readFileSync(path.join(root, file), "utf8")).toBe(contents);
    }
    // Both copies are real files in a generated repository: Claude Code reads
    // only `.claude/skills/`, Codex CLI only `.agents/skills/`, and a clone on
    // any platform has to get both without a link to resolve.
    const skillCopies = [".agents", ".claude"].map((directory) =>
      path.join(root, directory, "skills", "merge-dependabot", "SKILL.md"),
    );
    for (const copy of skillCopies) {
      expect(existsSync(copy)).toBe(true);
    }
    const [agentsSkill, claudeSkill] = skillCopies.map((copy) =>
      readFileSync(copy, "utf8"),
    );
    expect(claudeSkill).toBe(agentsSkill);
    const dependabotSkill = claudeSkill ?? "";
    expect(dependabotSkill).toContain(".github/PULL_REQUEST_TEMPLATE.md");
    expect(existsSync(path.join(root, ".github", "PULL_REQUEST_TEMPLATE.md"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(root, ".github", "workflows", "check-pr-title.yml")),
    ).toBe(true);
    expect(
      readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8"),
    ).not.toContain("bootstrap:e2e");
    expect(
      existsSync(
        path.join(
          root,
          ".claude",
          "skills",
          "merge-dependabot",
          "scripts",
          "survey-prs.mjs",
        ),
      ),
    ).toBe(true);
    expect(existsSync(path.join(root, "scripts", "lib", "is-main.mjs"))).toBe(true);
    expect(existsSync(path.join(root, "scripts", "lib", "json.mjs"))).toBe(true);

    if (cli === "yes") {
      expect(manifest.bin).toEqual({ [packageName]: "./dist/cli.js" });
      expect(readFileSync(path.join(root, "src", "cli.ts"), "utf8")).toContain(
        "Usage:",
      );
    } else {
      expect(manifest.bin).toBeUndefined();
      expect(existsSync(path.join(root, "src", "cli.ts"))).toBe(false);
    }
    expect(manifest.sideEffects).toBe(false);

    const buildConfig = readFileSync(path.join(root, "tsconfig.build.json"), "utf8");
    if (profile === "universal-library") {
      expect(buildConfig).toContain('"types": []');
      expect(buildConfig).toContain('"DOM"');
      expect(manifest.engines).toBeUndefined();
    } else {
      expect(buildConfig).toContain('"types": ["node"]');
      expect(manifest.engines).toEqual({ node: ">=24" });
    }

    // A `template-only` block at end of file (see #111) or a re-padded
    // Markdown table (see #103) both leave the generated tree failing its
    // own first `pnpm check:quick`. Check every generated text file against
    // Prettier itself, not a hand-picked one.
    await assertGeneratedTreeIsFormatted(root);
  });

  it("writes a selected Node floor and the matching compatibility leg", async () => {
    const root = copyTemplate();
    bootstrap(root, options("node-20-package", "node-library", "no", ">=20"));

    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { engines?: Record<string, string> };
    expect(manifest.engines).toEqual({ node: ">=20" });
    const workflow = readFileSync(
      path.join(root, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("node-version: 20");
    expect(workflow).toContain(
      "pnpm --config.runtime-on-fail=ignore run package:smoke",
    );

    await assertGeneratedTreeIsFormatted(root);
  });

  // #113: bootstrap does a literal string substitution of the template's
  // `my-package` placeholder, not a re-format, so a file that hand-wraps
  // prose or hard-codes a `my-package`-length assumption can overflow
  // Prettier's printWidth once the substituted name is long enough —
  // regardless of which specific fixture name the rest of this suite happens
  // to use. `acme-library`/`browser-kit` above only ever exercise short
  // names; this exercises the actual boundary, an npm package name at its
  // 214-character maximum (a scope counts toward that limit).
  it.each(["node-library", "universal-library"] as const)(
    "keeps the generated tree Prettier-clean for a package name at npm's 214-character limit (%s)",
    async (profile) => {
      const packageName = `@${"a".repeat(105)}/${"b".repeat(107)}`;
      expect(packageName).toHaveLength(214);
      const root = copyTemplate();
      bootstrap(root, options(packageName, profile));
      expect(findPlaceholders(root)).toEqual([]);
      await assertGeneratedTreeIsFormatted(root);
    },
  );

  // npm exposes a bin object's key as the command name, and a scoped package's
  // command is its unscoped half — `npx @acme/widget-cli` runs `widget-cli`.
  // Keying the object by the full scoped name would declare a command nobody
  // can type.
  it("names the generated CLI command after the unscoped package name", () => {
    const root = copyTemplate();

    bootstrap(root, options("@acme/widget-cli", "node-library", "yes"));

    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    expect(manifest.bin).toEqual({ "widget-cli": "./dist/cli.js" });
  });

  it("rewrites only explicit targets", () => {
    const root = copyTemplate();
    const untouched = path.join(root, "unlisted-placeholder.txt");
    writeFileSync(untouched, "my-package");

    bootstrap(root, options("explicit-library", "node-library"));

    expect(readFileSync(untouched, "utf8")).toBe("my-package");
    expect(findPlaceholders(root)).toEqual([]);
  });

  it("makes dry-run non-mutating", () => {
    const root = copyTemplate();
    const before = readFileSync(path.join(root, "package.json"), "utf8");
    const changed = bootstrap(root, {
      ...options("dry-library", "node-library"),
      dryRun: true,
    });
    expect(changed.length).toBeGreaterThan(0);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
  });

  it("validates projected dry-run output without mutating the source", () => {
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    writeFileSync(
      agents,
      `${readFileSync(agents, "utf8")}\nThis reference must be rejected: <!-- template-only:start -->\n`,
    );
    const before = readFileSync(agents, "utf8");

    expect(() =>
      bootstrap(root, {
        ...options("invalid-dry-run", "node-library"),
        dryRun: true,
      }),
    ).toThrow(/ERR_AI_LAYER_REFERENCE/);
    expect(readFileSync(agents, "utf8")).toBe(before);
  });

  it("rejects a Markdown reference to a path the generated tree does not contain", () => {
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    writeFileSync(
      agents,
      `${readFileSync(agents, "utf8")}\nSee \`scripts/does-not-exist.mjs\` for details.\n`,
    );

    expect(() =>
      bootstrap(root, options("dangling-reference", "node-library")),
    ).toThrow(/AGENTS\.md: dangling reference `scripts\/does-not-exist\.mjs`/);
  });

  it("does not treat an ESLint config block name in inline code as a path", () => {
    // A flat-config block name has exactly the shape of a repo-relative path,
    // so naming the gate that enforces a rule used to fail the build (#102).
    // The first segment is what separates the two: the generated root has no
    // `public-api` entry, so the token is not a path to resolve at all.
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    writeFileSync(
      agents,
      `${readFileSync(agents, "utf8")}\nThe \`public-api/internal-stays-private\` block enforces it.\n`,
    );

    expect(() =>
      bootstrap(root, options("eslint-block-name", "node-library")),
    ).not.toThrow();
  });

  it("still rejects a Markdown reference to a path bootstrap itself removes", () => {
    // The narrowing above must not cost the check the case it exists for. A
    // removed file sits inside a directory that survives the removal, so its
    // first segment still resolves and the dry-run preview still reports it.
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    writeFileSync(
      agents,
      `${readFileSync(agents, "utf8")}\nSee \`scripts/bootstrap.mjs\` for details.\n`,
    );

    expect(() => bootstrap(root, options("removed-reference", "node-library"))).toThrow(
      /AGENTS\.md: dangling reference `scripts\/bootstrap\.mjs`/,
    );
  });

  it("does not treat a backticked schemeless URL as a dangling path (#108)", () => {
    // `github.com/owner/repo/blob/main/README.md` has no `://`, has a `/`,
    // and its last segment (`README.md`) has a dot — so #106's shape rule 3
    // would classify it as a repository path before the filesystem is ever
    // consulted, and it would be reported as dangling even though it is
    // ordinary Markdown prose naming a schemeless URL. The first segment
    // (`github.com`) is hostname-shaped — a dot at an interior index — so it
    // must be excluded from the token set entirely, in both a built checkout
    // and a fresh `git ls-files` tree.
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    writeFileSync(
      agents,
      `${readFileSync(agents, "utf8")}\nSee \`github.com/owner/repo/blob/main/README.md\` for details.\n`,
    );

    expect(() =>
      bootstrap(root, options("schemeless-url", "node-library")),
    ).not.toThrow();
  });

  it("does not treat a backticked bare extensionless hostname as a dangling path (#108)", () => {
    // The interior-dot test on the first segment fires regardless of the
    // last segment's extension, so `example.com/path` (no `://`, no dot in
    // the last segment) is excluded by the same rule as the extensioned
    // case above — no separate carve-out needed.
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    writeFileSync(
      agents,
      `${readFileSync(agents, "utf8")}\nSee \`example.com/path\` for details.\n`,
    );

    expect(() =>
      bootstrap(root, options("bare-hostname", "node-library")),
    ).not.toThrow();
  });

  it("still classifies `.claude/settings.local.json` as a path, not as hostname-shaped (#108)", () => {
    // The dot in `.claude` sits at index 0, not an interior index, so the
    // hostname test must not exclude it: it stays a path token, and stays
    // exempt via DANGLING_REFERENCE_EXEMPTIONS rather than being dropped from
    // the token set outright. This pins the distinction between "excluded"
    // (never becomes a token) and "exempt" (becomes a token, then allowed).
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    writeFileSync(
      agents,
      `${readFileSync(agents, "utf8")}\nSee \`.claude/settings.local.json\` for details.\n`,
    );

    expect(() =>
      bootstrap(root, options("dotfile-exempt", "node-library")),
    ).not.toThrow();
  });

  it("still reports a dangling reference under a multi-dot dotfile first segment (#108)", () => {
    // `.prettierrc.json` has two dots, and the first one sits at index 0 —
    // a dotfile, not a hostname. A hostname test that inspects the *last*
    // dot instead of the first would see the interior dot before `.json`,
    // misclassify the first segment as hostname-shaped, and drop the token
    // before the dangling-reference check ever runs — silently hiding an
    // obviously bogus reference into a file that cannot have a subpath.
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    writeFileSync(
      agents,
      `${readFileSync(agents, "utf8")}\nSee \`.prettierrc.json/overrides\` for details.\n`,
    );

    expect(() => bootstrap(root, options("multi-dot-dotfile", "node-library"))).toThrow(
      /AGENTS\.md: dangling reference `\.prettierrc\.json\/overrides`/,
    );
  });

  it.each([
    ["absent", false],
    ["present", true],
  ] as const)(
    "reports a dangling reference under a gitignored build directory whether or not that directory is %s in the checkout (#106)",
    (_label, createDocsDirectory) => {
      // `docs/` is gitignored build output (`pnpm docs:build`): it exists in a
      // developer checkout that has built it and does not exist in a fresh
      // clone or the git-ls-files-based fixture this suite normally builds.
      // A dangling reference under it must be reported either way — the
      // filename has an extension, so shape (rule 3) classifies it as a path
      // before the filesystem is ever consulted.
      const root = copyTemplate();
      if (createDocsDirectory) {
        mkdirSync(path.join(root, "docs"), { recursive: true });
      }
      const agents = path.join(root, "AGENTS.md");
      writeFileSync(
        agents,
        `${readFileSync(agents, "utf8")}\nSee \`docs/getting-started.md\` for details.\n`,
      );

      expect(() =>
        bootstrap(
          root,
          options(`docs-dangling-${String(createDocsDirectory)}`, "node-library"),
        ),
      ).toThrow(
        /ERR_AI_LAYER_REFERENCE[\s\S]*AGENTS\.md: dangling reference `docs\/getting-started\.md`/,
      );
    },
  );

  it.each([
    ["absent", false],
    ["present", true],
  ] as const)(
    "skips every dangling-reference exemption, under either trailing-slash spelling, whether the target directory is %s (#106)",
    (_label, createDocsDirectory) => {
      const root = copyTemplate();
      if (createDocsDirectory) {
        mkdirSync(path.join(root, "docs", "api"), { recursive: true });
      }
      const agents = path.join(root, "AGENTS.md");
      writeFileSync(
        agents,
        `${readFileSync(agents, "utf8")}\n` +
          "Exempt references: `dist/`, `docs/`, `docs/api`, `docs/api/`, " +
          "`.claude/settings.local.json`, `secrets/`.\n",
      );

      expect(() =>
        bootstrap(
          root,
          options(`docs-exempt-${String(createDocsDirectory)}`, "node-library"),
        ),
      ).not.toThrow();
    },
  );

  it("leaves the repository untouched when a real (non-dry-run) bootstrap fails validation", () => {
    // transform() removes its own script and rewrites package.json before any
    // validation runs. If bootstrap() validated against the already-written
    // result instead of a preview, a validation failure here would delete
    // scripts/bootstrap.mjs and rename package.json with no way to recover.
    const root = copyTemplate();
    const agents = path.join(root, "AGENTS.md");
    const before = readFileSync(agents, "utf8");
    writeFileSync(
      agents,
      `${before}\nSee \`scripts/does-not-exist.mjs\` for details.\n`,
    );
    const packageJsonBefore = readFileSync(path.join(root, "package.json"), "utf8");

    expect(() =>
      bootstrap(root, options("untouched-on-failure", "node-library")),
    ).toThrow(BootstrapError);

    expect(existsSync(path.join(root, "scripts", "bootstrap.mjs"))).toBe(true);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(
      packageJsonBefore,
    );
  });

  it("does not scan a gitignored worktree checkout for dangling Markdown references", () => {
    // .claude/worktrees/ holds full checkouts (see .gitignore); a bootstrap
    // run against a real, non-fresh checkout must not fail because of
    // unrelated content sitting in one.
    const root = copyTemplate();
    const worktreeDirectory = path.join(root, ".claude", "worktrees", "some-branch");
    mkdirSync(worktreeDirectory, { recursive: true });
    writeFileSync(
      path.join(worktreeDirectory, "NOTES.md"),
      "See `scripts/only-in-worktree.mjs` for details.\n",
    );

    expect(() =>
      bootstrap(root, options("worktree-ignored", "node-library")),
    ).not.toThrow();
  });

  it("does not let a nested, unrelated file sharing an AI-layer basename affect the AI-layer check", () => {
    // AI_LAYER_TARGETS matches exact repository-relative paths, not a
    // basename at any depth (fixed in #71). A stray bootstrap marker in a
    // nested file that happens to share the top-level AGENTS.md's name must
    // not fail bootstrap, because that nested file is never a generated
    // repository's AI-layer instructions.
    const root = copyTemplate();
    const nestedDirectory = path.join(root, "docs", "guides");
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(
      path.join(nestedDirectory, "AGENTS.md"),
      "# Unrelated guide\n\n" +
        "<!-- template-only:start -->\n" +
        "A stale marker a basename-only match would have wrongly flagged.\n" +
        "<!-- template-only:end -->\n",
    );

    expect(() =>
      bootstrap(root, options("nested-basename", "node-library")),
    ).not.toThrow();
  });

  it("does not depend on package-manager or staging processes", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts", "bootstrap.mjs"),
      "utf8",
    );

    expect(source).not.toContain('from "node:child_process"');
    expect(source).not.toContain("spawnSync");
    expect(source).not.toContain("mkdtempSync");
    expect(source).not.toContain("regenerateLockfile");
    expect(source).not.toContain("corepack");
  });

  it("preserves interactive metadata in generated JSON", () => {
    const root = copyTemplate();
    const description = 'A $& "quoted" package.\nWith a second line.';
    const parsed = parseArguments([
      "quoted-package",
      "--profile",
      "node-library",
      "--author",
      'Ada "The Great"',
      "--email",
      "ada+tag@example.com",
      "--github-user",
      "ada",
      "--license",
      "MIT",
      "--description",
      description,
    ]);

    bootstrap(root, parsed);

    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { author: string; description: string };
    expect(manifest).toMatchObject({
      author: 'Ada "The Great" <ada+tag@example.com>',
      description,
    });
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toContain(description);
  });

  it("keeps package metadata and the license text in sync", () => {
    const root = copyTemplate();
    const isc = parseArguments([
      "licensed-package",
      "--profile",
      "node-library",
      "--author",
      "Ada Lovelace",
      "--email",
      "ada@example.com",
      "--github-user",
      "ada",
      "--license",
      "ISC",
    ]);
    bootstrap(root, isc, { year: 2030 });
    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { license: string };
    expect(manifest.license).toBe("ISC");
    expect(readFileSync(path.join(root, "LICENSE"), "utf8")).toContain(
      'THE SOFTWARE IS PROVIDED "AS IS"',
    );
    expect(readFileSync(path.join(root, "LICENSE"), "utf8")).toContain(
      "Copyright 2030 Ada Lovelace",
    );
  });

  it("uses the injected year in the generated MIT license", () => {
    const root = copyTemplate();
    bootstrap(root, options("mit-package", "node-library"), { year: 2042 });

    expect(readFileSync(path.join(root, "LICENSE"), "utf8")).toContain(
      "Copyright (c) 2042 Ada Lovelace",
    );
  });

  it("refuses a second run without changing generated files", () => {
    const root = copyTemplate();
    bootstrap(root, options("once-only", "node-library"));
    const before = readFileSync(path.join(root, "package.json"), "utf8");
    expect(() => bootstrap(root, options("twice", "node-library"))).toThrow(
      /ERR_ALREADY_BOOTSTRAPPED/,
    );
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
  });
});
