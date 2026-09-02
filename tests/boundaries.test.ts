import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import eslintConfig from "../eslint.config.mjs";

// AGENTS.md's Architecture section splits src/internal/ into a static layer
// that only reads, and a dynamic layer that spawns processes and writes files.
// The rule that keeps them apart — static code never imports dynamic code — is
// a convention until something fails on it, so eslint.config.mjs carries it as
// a zone and this file asserts the zone is actually there and actually reaches
// the static modules.
//
// Why the zone is inspected rather than exercised on a fixture file: the
// TypeScript parser runs under `projectService`, which needs a real file in a
// real project, and no static module exists yet for it to lint. Reading the
// declared patterns is what can be checked today; the zone starts catching
// real violations the moment the first static module lands.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const ZONE_NAME = "boundaries/static-does-not-reach-dynamic";
const TESTS_ZONE_NAME = "boundaries/tests-reach-internal-through-its-index";
const SCRIPTS_ZONE_NAME = "boundaries/internal-is-not-importable";

/** The static layer, from AGENTS.md's Architecture section. */
const STATIC_DIRECTORIES = [
  "settings",
  "spec",
  "matcher",
  "fixture",
  "decision",
  "assert",
  "lint",
  "report",
] as const;

/** The dynamic layer: the only modules allowed to spawn or write. */
const DYNAMIC_DIRECTORIES = ["exec", "record"] as const;

const configs: readonly unknown[] = eslintConfig;

function readKey(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function readStringArray(value: unknown, key: string): readonly string[] {
  const raw = readKey(value, key);
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

function zone(name: string = ZONE_NAME): unknown {
  const found = configs.find((entry) => readKey(entry, "name") === name);
  if (found === undefined) {
    throw new Error(`eslint.config.mjs declares no config named ${name}`);
  }
  return found;
}

/**
 * Every `group` entry of the zone's `no-restricted-imports` patterns, flattened.
 *
 * @remarks
 * The rule matches the specifier *as written*, so both spellings a static
 * module could use have to appear in this list. Reading the options rather
 * than the file's text means a reformat or a reordering cannot break it.
 */
function restrictedGroups(name: string = ZONE_NAME): readonly string[] {
  const setting = readKey(readKey(zone(name), "rules"), "no-restricted-imports");
  // A rule setting is `[severity, options]`, and an array index is an ordinary
  // key — reading it through `readKey` keeps the value `unknown` instead of
  // widening to `any` the way `Array.isArray` narrowing would.
  const patterns = readKey(readKey(setting, "1"), "patterns");
  if (!Array.isArray(patterns)) {
    throw new Error(`${name} declares no no-restricted-imports patterns`);
  }
  return patterns.flatMap((pattern: unknown) => readStringArray(pattern, "group"));
}

describe("the static/dynamic layer boundary", () => {
  it("eslint.config.mjs declares boundaries/static-does-not-reach-dynamic", () => {
    expect(readKey(zone(), "name")).toBe(ZONE_NAME);
    expect(restrictedGroups()).not.toEqual([]);
  });

  it.each(STATIC_DIRECTORIES)("scopes the zone to src/internal/%s", (directory) => {
    expect(readStringArray(zone(), "files")).toContain(
      `src/internal/${directory}/**/*.ts`,
    );
  });

  it.each(DYNAMIC_DIRECTORIES)(
    "lists both the relative and the **/internal/%s/** absolute spelling",
    (directory) => {
      const groups = restrictedGroups();
      // Relative: what a sibling static module writes to reach one level out.
      expect(groups).toContain(`../${directory}/*`);
      // Deeper: what a nested static module writes for the same directory.
      expect(groups).toContain(`../../${directory}/*`);
      // Absolute/group: what a specifier rooted at the package writes.
      expect(groups).toContain(`**/internal/${directory}/**`);
    },
  );

  it("leaves the composition root free to import both layers", () => {
    // src/cli.ts wires the two layers together; restricting it would make the
    // pipeline unbuildable rather than safer.
    expect(readStringArray(zone(), "files")).not.toContain("src/cli.ts");
  });
});

describe("the zone as ESLint resolves it", () => {
  const eslint = new ESLint({ cwd: repoRoot });

  async function restrictedImportsFor(relative: string): Promise<unknown> {
    const config: unknown = await eslint.calculateConfigForFile(
      path.join(repoRoot, relative),
    );
    return readKey(readKey(config, "rules"), "no-restricted-imports");
  }

  it("applies to a static module that does not exist yet", async () => {
    // Nothing lives here today. The assertion is that the zone will be in
    // force for the first module that does, without anyone re-reading this
    // config to remember to switch it on.
    expect(
      await restrictedImportsFor("src/internal/decision/resolve.ts"),
    ).toBeDefined();
  });

  it("does not apply to the composition root", async () => {
    expect(await restrictedImportsFor("src/cli.ts")).toBeUndefined();
  });
});

describe("tests reach internal modules only through a module's index", () => {
  it("forbids the internal tree, then negates a module's index and errors.js", () => {
    const groups = restrictedGroups(TESTS_ZONE_NAME);
    expect(groups).toContain("**/src/internal/**");
    // Gitignore-style negations: the two spellings a test may still name.
    expect(groups).toContain("!**/src/internal/*/index.js");
    expect(groups).toContain("!**/src/internal/errors.js");
    // Build output stays unreachable regardless: a test reads source.
    expect(groups).toContain("**/dist/internal/**");
  });

  it("scopes that exception to tests/** and nothing else", () => {
    expect(readStringArray(zone(TESTS_ZONE_NAME), "files")).toEqual(["tests/**/*.ts"]);
  });

  it("keeps scripts/** on the unconditional form, with no index negation", () => {
    // Automation is a consumer, and a consumer goes through src/index.ts.
    const groups = restrictedGroups(SCRIPTS_ZONE_NAME);
    expect(groups).toContain("**/src/internal/**");
    expect(groups).toContain("**/dist/internal/**");
    expect(groups.filter((group) => group.startsWith("!"))).toEqual([]);
    expect(readStringArray(zone(SCRIPTS_ZONE_NAME), "files")).toEqual([
      "scripts/**/*.mjs",
    ]);
  });

  it("declares no config that switches no-restricted-imports off entirely", () => {
    // The per-file allowlist this replaced (#24) had grown to name every test
    // file the rule applied to. A rule switched off wherever it would fire is
    // a ritual, not a boundary — this is what stops one growing back.
    const disabling = configs.filter(
      (entry) => readKey(readKey(entry, "rules"), "no-restricted-imports") === "off",
    );
    expect(disabling).toEqual([]);
  });
});

describe("the tests zone as ESLint resolves it", () => {
  const eslint = new ESLint({ cwd: repoRoot });

  async function groupsFor(relative: string): Promise<readonly string[]> {
    const config: unknown = await eslint.calculateConfigForFile(
      path.join(repoRoot, relative),
    );
    const setting = readKey(readKey(config, "rules"), "no-restricted-imports");
    const patterns = readKey(readKey(setting, "1"), "patterns");
    if (!Array.isArray(patterns)) {
      throw new Error(`no no-restricted-imports patterns resolved for ${relative}`);
    }
    return patterns.flatMap((pattern: unknown) => readStringArray(pattern, "group"));
  }

  it("resolves the index negations for a test file", async () => {
    expect(await groupsFor("tests/settings.test.ts")).toContain(
      "!**/src/internal/*/index.js",
    );
  });

  it("resolves no negation at all for repository automation", async () => {
    const groups = await groupsFor("scripts/check-package.mjs");
    expect(groups).toContain("**/src/internal/**");
    expect(groups.filter((group) => group.startsWith("!"))).toEqual([]);
  });
});
