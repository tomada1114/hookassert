import { readFileSync } from "node:fs";

import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * The `export *` ban, shared by the whole `src/` tree and by the extra
 * index-only rules below.
 *
 * @remarks
 * `no-restricted-syntax` options replace rather than merge across config
 * objects, so the narrower `src/index.ts` block has to restate this entry or
 * it would silently switch `export *` back on for the one file where it does
 * the most damage.
 */
const NO_EXPORT_STAR = {
  selector: "ExportAllDeclaration",
  message:
    "`export *` publishes symbols implicitly. Re-export each public symbol by name from src/index.ts.",
};

/** What `src/internal/**` is, in the words of the rule that made it private. */
const INTERNAL_IS_PRIVATE =
  'src/internal/ is private: see "Architecture" in AGENTS.md. Tests reach it through the public surface in src/index.ts (see the `writing-tests` skill), and repository automation must not depend on package internals at all.';

/**
 * Read one property off a value of unknown shape.
 *
 * @param {unknown} value - Candidate object.
 * @param {string} key - Property to read.
 * @returns {unknown} The property value, or undefined when absent.
 */
function readKey(value, key) {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return /** @type {Record<string, unknown>} */ (value)[key];
}

/**
 * The `universal-library` profile forbids Node built-ins in `src/` by emptying
 * `compilerOptions.types` in the build config. Reading that back here keeps the
 * profile encoded in exactly one place instead of duplicating a profile flag
 * that could drift out of sync with what actually compiles.
 *
 * @returns {boolean} True when `src/` must stay runtime-agnostic.
 */
function isUniversalProfile() {
  const raw = readFileSync(new URL("tsconfig.build.json", import.meta.url), "utf8");
  // The build config is JSONC; strip full-line comments before parsing.
  /** @type {unknown} */
  const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  const types = readKey(readKey(parsed, "compilerOptions"), "types");
  return Array.isArray(types) && types.length === 0;
}

/** @type {import("eslint").Linter.Config[]} */
const universalSourceRestrictions = isUniversalProfile()
  ? [
      {
        name: "universal-profile/no-node-builtins",
        files: ["src/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["node:*"],
                  message:
                    "The universal-library profile must run outside Node. Move Node-only code behind a separate conditional export entry.",
                },
              ],
            },
          ],
        },
      },
    ]
  : [];

export default defineConfig([
  // Only generated trees are ignored; everything hand-written is linted,
  // including repository automation and config files. `.claude/skills/` is a
  // generated mirror of `.agents/skills/` (`pnpm agents:sync`), where the real
  // files are linted at their real path — linting the copy too would report
  // the same violation twice, at a path nobody may edit.
  // `.claude/worktrees/` holds full working copies created by agent sessions,
  // linted in their own checkout.
  // A `tests/fixtures/` file is malformed on purpose, so linting it reports
  // the very defect a test asserts on.
  globalIgnores([
    "dist/",
    "coverage/",
    "docs/api/",
    ".claude/skills/",
    ".claude/worktrees/",
    "tests/fixtures/",
  ]),
  {
    linterOptions: {
      // A disable directive that no longer suppresses anything is dead weight
      // that hides the next real violation.
      reportUnusedDisableDirectives: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          // `@ts-ignore` hides an error forever; `@ts-expect-error` fails once
          // the underlying problem is gone, so it is the only allowed escape
          // hatch and it must say why.
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "no-console": "error",
    },
  },
  {
    name: "public-api/explicit-surface",
    files: ["src/**/*.ts"],
    rules: {
      // The published contract is named exports from src/index.ts. A default
      // export has no stable name for consumers to import, or for a reviewer
      // to read a diff of.
      "no-restricted-exports": [
        "error",
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
      "no-restricted-syntax": ["error", NO_EXPORT_STAR],

      // A `switch` over a union is the one place where adding a member to that
      // union silently changes behavior instead of failing to compile. With
      // `considerDefaultExhaustiveForUnions`, a `default` branch is accepted as
      // the deliberate answer, so this asks for a decision rather than for a
      // case per member.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    name: "public-api/internal-stays-private",
    files: ["src/index.ts"],
    rules: {
      // src/index.ts is the whole published contract, so a re-export here is
      // the one edit that can publish a private symbol by accident. The
      // directory name is not the boundary — this line is.
      //
      // Anchored on the path segment, not on the bare word: an unanchored
      // /internal/ also matches a specifier that merely starts with those
      // letters, so a legitimate `./internal-format.js` re-export would be
      // rejected for a private directory it is not in. src/index.ts sits
      // beside the directory, so `./internal/` is the only spelling that can
      // reach it.
      "no-restricted-syntax": [
        "error",
        NO_EXPORT_STAR,
        {
          selector: "ExportNamedDeclaration[source.value=/^\\.\\/internal\\//]",
          message:
            "exporting an internal symbol publishes it — move it to a public module first",
        },
        {
          selector: "ExportAllDeclaration[source.value=/^\\.\\/internal\\//]",
          message:
            "exporting an internal symbol publishes it — move it to a public module first",
        },
      ],
    },
  },
  ...universalSourceRestrictions,
  {
    name: "automation/node-scripts",
    files: ["scripts/**/*.mjs", ".agents/skills/**/*.mjs"],
    rules: {
      // These files are the CLI surface of repository automation.
      "no-console": "off",

      // Automation must run on plain Node before `pnpm install`, so it is
      // authored as `.mjs` and declares its boundary types in JSDoc, which
      // `checkJs` enforces just as strictly. This rule only recognises
      // TypeScript annotations, so leaving it on would demand syntax that is
      // not valid JavaScript.
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  {
    name: "cli/terminal-output",
    files: ["src/cli.ts", "src/cli/**/*.ts"],
    rules: {
      // Terminal output is the product of a command. Keep this exception at
      // the command boundary so library modules still cannot print as a side
      // effect of an import.
      "no-console": "off",
    },
  },
  {
    // The `writing-tests` skill states these rules in prose; this is what enforces the
    // ones a linter can see. The recommended set is taken as published and the
    // escalations below are the entries this repository will not run on
    // "warn", starting with the two that quietly shrink the suite.
    ...vitest.configs.recommended,
    name: "tests/vitest-rules",
    files: ["tests/**/*.ts"],
    rules: {
      ...vitest.configs.recommended.rules,

      // "No it.skip/it.todo left on main" and "a focused test never lands".
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",

      // An assertion outside a test reports nothing when it fails, and a test
      // with no assertion passes whatever the code does. `expectTypeOf` is
      // listed because tests/types.test.ts asserts entirely at compile time —
      // those tests have no runtime `expect` and are not meant to.
      "vitest/no-standalone-expect": "error",
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expectTypeOf"] },
      ],
      "vitest/valid-expect": "error",

      // One spelling, so a search for a test finds every one of them.
      "vitest/consistent-test-it": ["error", { fn: "it" }],

      // `vitest/require-top-level-describe` is deliberately left off. Several
      // suites here own a fixture for the whole file — a temp git repository,
      // a packed tarball — and set it up in a file-level `beforeAll`, which
      // this rule forbids. Satisfying it would mean wrapping five whole files
      // in an extra describe for no gain in what the tests assert.
      //
      // `vitest/no-conditional-expect` comes from the recommended set and is
      // turned off for the same kind of reason: AGENTS.md prescribes
      // asserting on a caught error inside `catch`, and the workflow and
      // bootstrap suites branch on what the repository actually contains
      // before asserting against it.
      "vitest/no-conditional-expect": "off",
    },
  },
  {
    name: "tests/relaxations",
    files: ["tests/**/*.ts"],
    rules: {
      // Tests deliberately construct invalid input to prove it is rejected.
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    name: "boundaries/internal-is-not-importable",
    files: ["tests/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Both trees: `src/internal` is the module, `dist/internal` is
              // the same module after a build, and neither is importable from
              // outside `src/**`.
              group: [
                "**/src/internal",
                "**/src/internal/**",
                "**/dist/internal",
                "**/dist/internal/**",
              ],
              message: INTERNAL_IS_PRIVATE,
            },
          ],
        },
      ],
    },
  },
  // Must stay last: turns off stylistic rules that would fight Prettier.
  eslintConfigPrettier,
]);
