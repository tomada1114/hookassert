#!/usr/bin/env node
// Prove the tarball works for someone who does not have this repository.
//
// Every check below runs against a throwaway consumer in the OS temp directory
// that installed the packed tarball. This script never imports `src/` or
// `dist/`, and the TypeScript step asserts that the consumer's compiler never
// read them either — which is what turns "the published declarations are
// self-contained" from a hope into a fact (spec 02 §4).
//
// Build and pack happen in the package.json script that calls this one, because
// pnpm's own path is not discoverable from a `.mjs` under pnpm 11.
import console from "node:console";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  findAbsoluteMapSources,
  findDanglingMapSources,
  findMissingRequiredPaths,
  findUnreadableManifest,
  inspectPackageEntries,
  parsePackedManifest,
  readTarEntries,
  requiredEntryPaths,
} from "./check-package.mjs";
import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";
import {
  npmCliPath,
  repoRoot,
  resolveDependencyBin,
  runNode,
} from "./lib/node-tools.mjs";
import { findSingleTarball } from "./lib/tarball.mjs";

const USAGE = `Usage: node scripts/smoke-package.mjs (--pack-dir <dir> | --tarball <file>)

Installs an already-packed tarball into a throwaway consumer and exercises it.

Exit codes:
  0  the tarball is usable by a consumer
  1  a check failed
  2  the arguments were wrong`;

/** Raised for a check failure whose message is already agent-readable. */
class SmokeError extends Error {}

/**
 * Fail the smoke test with a message shaped for spec 02 §7.3.
 *
 * @param {string} code - Stable error code.
 * @param {object} detail - What went wrong.
 * @param {string} detail.what - The failed check, in one sentence.
 * @param {string} [detail.subject] - Path, export or profile concerned.
 * @param {string} [detail.expected] - Expected value.
 * @param {string} [detail.actual] - Observed value.
 * @param {string} detail.next - The next safe command or edit.
 * @returns {never}
 * @throws SmokeError always.
 */
function fail(code, detail) {
  const lines = [`${code}: ${detail.what}`];
  if (detail.subject !== undefined) {
    lines.push(`Subject: ${detail.subject}`);
  }
  if (detail.expected !== undefined) {
    lines.push(`Expected: ${detail.expected}`);
  }
  if (detail.actual !== undefined) {
    lines.push(`Actual: ${detail.actual}`);
  }
  lines.push(`Next: ${detail.next}`);
  throw new SmokeError(lines.join("\n"));
}

/**
 * Report progress, so a failure is easy to place in the sequence.
 *
 * @param {string} message - What is about to happen.
 * @returns {void}
 */
function step(message) {
  console.log(`smoke: ${message}`);
}

/**
 * Truncate captured output so a failure message stays readable.
 *
 * @param {string} text - Captured stream.
 * @returns {string} At most a dozen lines of it.
 */
function excerpt(text) {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "<empty>";
  }
  const lines = trimmed.split("\n");
  return lines.length <= 12 ? trimmed : `${lines.slice(0, 12).join("\n")}\n…`;
}

/**
 * Read the profile this template is configured as.
 *
 * @remarks
 * `tsconfig.build.json`'s `compilerOptions.types` is the single source of truth
 * for the profile — an empty array means `src/` may not use Node built-ins — so
 * the bundler-resolution check is driven by the same value that decides what
 * actually compiles, and cannot drift from it. Exported so
 * `tests/smoke-package.test.ts` can assert this repository's own profile
 * matches what the rest of the suite assumes.
 *
 * @returns {boolean} True for the `universal-library` profile.
 */
export function isUniversalProfile() {
  const raw = readFileSync(path.join(repoRoot, "tsconfig.build.json"), "utf8");
  // The build config is JSONC; drop full-line comments before parsing.
  const parsed = parseJson(raw.replace(/^\s*\/\/.*$/gm, ""));
  const types = readKey(readKey(parsed, "compilerOptions"), "types");
  return Array.isArray(types) && types.length === 0;
}

/**
 * Public subpaths a consumer is allowed to import as a module.
 *
 * @remarks
 * A `.json` subpath — `"./package.json"` is the conventional one — is data, not
 * a module: importing it needs an import attribute and it exposes no named
 * exports, so it is excluded here and exercised by {@link checkRequireInterop}
 * instead.
 *
 * @param {unknown} manifest - The packed `package.json`.
 * @returns {string[]} Specifier suffixes, `""` for the package root.
 *
 * @remarks
 * Exported so `tests/smoke-package.test.ts` can exercise every branch
 * directly against a synthetic manifest, rather than only through a real
 * installed tarball.
 */
export function publicSubpaths(manifest) {
  const exports = readKey(manifest, "exports");
  if (typeof exports !== "object" || exports === null) {
    return [""];
  }
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (exports));
  // A conditions-only `exports` object, with no "." key, still describes the root.
  if (!keys.some((key) => key.startsWith("."))) {
    return [""];
  }
  return keys
    .filter(
      (key) => key.startsWith(".") && !key.includes("*") && !key.endsWith(".json"),
    )
    .map((key) => (key === "." ? "" : key.slice(1)))
    .sort();
}

/**
 * Command names a consumer gets from a packed `bin` field.
 *
 * @param {unknown} manifest - Packed package manifest.
 * @param {string} packageName - Installed package name, used for unnamed bins.
 * @returns {string[]} Sorted command names.
 */
export function publicBinCommands(manifest, packageName) {
  const bin = readKey(manifest, "bin");
  const defaultName = packageName.slice(packageName.lastIndexOf("/") + 1);
  if (typeof bin === "string") {
    return [defaultName];
  }
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) {
    return [];
  }
  return [
    ...new Set(
      Object.keys(/** @type {Record<string, unknown>} */ (bin)).map((name) =>
        name === "" ? defaultName : name,
      ),
    ),
  ].sort();
}

// -----------------------------------------------------------------------------
// Checks
// -----------------------------------------------------------------------------

/**
 * Steps 3 to 5: what the tarball contains, and what it must not.
 *
 * @remarks
 * The declared-entry-point check ({@link inspectPackageEntries}'s `manifest`
 * option) is driven by the manifest parsed out of the tarball itself, via
 * {@link parsePackedManifest} — the same function `check-package.mjs`'s
 * `inspectTarball` uses — not by the repository's own `package.json`. What a
 * consumer resolves against is whatever shipped, and after `publishConfig` is
 * folded in the two can legitimately differ (see issue #83).
 *
 * @param {readonly import("./check-package.mjs").TarEntry[]} entries - Tarball entries.
 * @param {string} label - Tarball file name, for error messages.
 * @returns {void}
 * @throws {Error} A {@link SmokeError} when a check fails; exported so
 * `tests/package.test.ts` can prove a `publishConfig`-redirected manifest is
 * caught here too, not only by `check-package.mjs`'s `inspectTarball`.
 */
export function checkTarballContents(entries, label) {
  step("inspecting tarball paths, forbidden paths, size limits and required files");
  const packedManifest = parsePackedManifest(entries);
  const problems = [
    ...inspectPackageEntries(entries, { manifest: packedManifest }),
    ...findMissingRequiredPaths(entries),
    ...findDanglingMapSources(entries),
    ...findUnreadableManifest(entries, packedManifest),
  ];
  if (problems.length > 0) {
    fail("ERR_SMOKE_TARBALL_CONTENTS", {
      what: `The tarball failed ${String(problems.length)} content check(s).`,
      subject: label,
      actual: problems
        .map((problem) => `[${problem.code}] ${problem.message}`)
        .join("\n\n"),
      next: "Fix the paths listed above, then run `pnpm run package:smoke` again.",
    });
  }

  step("checking that no published map leaks an absolute path");
  const leaks = findAbsoluteMapSources(entries);
  if (leaks.length > 0) {
    fail("ERR_SMOKE_MAP_ABSOLUTE_PATH", {
      what: "A published map references its sources by absolute path, exposing the build machine's layout.",
      subject: leaks.map((leak) => leak.path).join(", "),
      expected: "every `sources` entry relative to the map file",
      actual: `${String(leaks.length)} absolute reference(s)`,
      next: "Check `rootDir` and `outDir` in tsconfig.build.json, then rebuild.",
    });
  }
}

/**
 * Step 6: a throwaway consumer that installed the tarball.
 *
 * @param {string} workspace - Temp directory to build inside.
 * @param {string} tarball - Path to the packed `.tgz`.
 * @returns {string} The consumer's directory.
 *
 * @remarks
 * Exported so `tests/smoke-package.test.ts` can exercise both outcomes
 * directly, mocking `runNode` at the subprocess boundary rather than
 * installing a real tarball for every case; see {@link checkRuntimeImports}
 * for why that boundary is the one mocked.
 */
export function installConsumer(workspace, tarball) {
  step("installing the tarball into a throwaway consumer");
  const consumer = path.join(workspace, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify(
      { name: "smoke-consumer", version: "0.0.0", private: true, type: "module" },
      null,
      2,
    )}\n`,
  );

  const result = runNode(
    npmCliPath(),
    [
      "install",
      tarball,
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      // A published package must be usable without running install scripts, and
      // this keeps the smoke test from executing anything the tarball ships.
      "--ignore-scripts",
      // The strict layout is the point: npm's default hoisting would let an
      // undeclared transitive dependency resolve and hide a phantom dependency.
      "--install-strategy=nested",
      // Peers are the consumer's to provide, not this smoke test's to fetch
      // from the registry; this keeps the install offline for any peer range.
      "--legacy-peer-deps",
    ],
    {
      cwd: consumer,
      env: {
        ...process.env,
        npm_config_cache: path.join(workspace, "npm-cache"),
      },
    },
  );
  if (result.status !== 0) {
    fail("ERR_SMOKE_INSTALL_FAILED", {
      what: "A consumer could not install the tarball.",
      subject: path.basename(tarball),
      expected: "npm install exits 0",
      actual: `exit ${String(result.status)}\n${excerpt(result.stderr || result.stdout)}`,
      next: "Run `pnpm run package:check` to check the manifest, then pack again.",
    });
  }
  return consumer;
}

/**
 * Run a generated ESM script inside the consumer.
 *
 * @param {string} consumer - Consumer directory.
 * @param {string} name - File name to write.
 * @param {string} source - Script body.
 * @returns {import("./lib/node-tools.mjs").RunResult} The captured result.
 */
function runInConsumer(consumer, name, source) {
  const file = path.join(consumer, name);
  writeFileSync(file, source);
  return runNode(file, [], { cwd: consumer });
}

/**
 * Steps 7 and 8: import every public entry point and read its export shape.
 *
 * @remarks
 * Names no concrete symbol on purpose: an assertion about *this* package's API
 * would have to be rewritten by every repository generated from this template,
 * inside automation nobody expects to edit. A module that throws while
 * evaluating is still caught; one that throws on first call is the package's
 * own test suite's concern.
 *
 * @param {string} consumer - Consumer directory.
 * @param {string} packageName - Installed package name.
 * @param {readonly string[]} subpaths - From {@link publicSubpaths}.
 * @param {boolean} [checkLibrary=true] Whether the packed manifest has exports.
 * @returns {void}
 *
 * @remarks
 * Exported so `tests/smoke-package.test.ts` can exercise both outcomes
 * directly, mocking `runNode` at the subprocess boundary rather than
 * installing a real tarball for every case.
 */
export function checkRuntimeImports(
  consumer,
  packageName,
  subpaths,
  checkLibrary = true,
) {
  if (!checkLibrary) {
    step("skipping library entry-point checks: the package declares no exports");
    return;
  }
  step(`importing ${String(subpaths.length)} public entry point(s)`);
  const result = runInConsumer(
    consumer,
    "check-runtime.mjs",
    `import assert from "node:assert/strict";

for (const subpath of ${JSON.stringify(subpaths)}) {
  const specifier = ${JSON.stringify(packageName)} + subpath;
  const module = await import(specifier);
  assert.equal(
    Object.hasOwn(module, "default"),
    false,
    \`\${specifier} exposes a default export; the contract is named exports only\`,
  );
  const names = Object.keys(module).filter((name) => name !== "__esModule");
  assert.ok(names.length > 0, \`\${specifier} exposes no named exports\`);
  console.log(\`  \${specifier} -> \${names.sort().join(", ")}\`);
}
`,
  );

  if (result.status !== 0) {
    fail("ERR_SMOKE_IMPORT_FAILED", {
      what: "A consumer could not import the published entry points.",
      subject: subpaths.map((subpath) => packageName + subpath).join(", "),
      expected: "every public subpath imports and exposes at least one named export",
      actual: `exit ${String(result.status)}\n${excerpt(result.stderr || result.stdout)}`,
      next: "Check `exports` in package.json and the re-exports in src/index.ts.",
    });
  }
  process.stdout.write(result.stdout);
}

/**
 * Execute every command exposed by the packed package and require usable help.
 *
 * @param {string} consumer - Consumer directory.
 * @param {string} packageName - Installed package name.
 * @param {unknown} manifest - Installed package manifest.
 * @returns {void}
 * @throws {SmokeError} When a declared command is missing or unusable.
 */
export function checkBinCommands(consumer, packageName, manifest) {
  const bin = readKey(manifest, "bin");
  if (bin === undefined) {
    return;
  }

  const commands = publicBinCommands(manifest, packageName);
  if (commands.length === 0) {
    fail("ERR_SMOKE_BIN_INVALID", {
      what: "The packed package declares bin in an unusable shape.",
      subject: packageName,
      expected: "a string bin or a non-empty object of command names",
      actual: "no command names",
      next: "Set package.json#bin to a string or a non-empty object, then repack.",
    });
  }

  const binDirectory = path.join(consumer, "node_modules", ".bin");
  for (const command of commands) {
    if (
      command === "." ||
      command === ".." ||
      command.includes("/") ||
      command.includes("\\")
    ) {
      fail("ERR_SMOKE_BIN_INVALID", {
        what: "The packed package declares an unsafe bin command name.",
        subject: command,
        expected: "a command name without path separators",
        actual: command,
        next: "Use a plain command name in package.json#bin, then repack.",
      });
    }

    const executable = path.join(binDirectory, command);
    step(`running ${command} --help through node_modules/.bin`);
    if (!existsSync(executable)) {
      fail("ERR_SMOKE_BIN_MISSING", {
        what: "The installed package did not create a declared bin command.",
        subject: command,
        expected: executable,
        actual: "path is absent",
        next: "Build the declared bin target, then repack and reinstall.",
      });
    }
    const result = runNode(executable, ["--help"], { cwd: consumer });
    if (result.status !== 0 || result.stdout.trim() === "") {
      fail("ERR_SMOKE_BIN_FAILED", {
        what: "A declared bin command did not provide usable help.",
        subject: command,
        expected: "exit 0 with non-empty stdout for --help",
        actual: `exit ${String(result.status)}\n${excerpt(result.stderr || result.stdout)}`,
        next: "Run the installed command manually with --help, then fix its entry point.",
      });
    }
    process.stdout.write(result.stdout);
  }
}

/**
 * A CommonJS consumer resolves the package and its manifest.
 *
 * @remarks
 * The package's published Node floor is checked separately by the package-floor
 * CI job. On runtimes where `require(esm)` is supported, a CommonJS consumer
 * can require an ESM entry point. Without a condition that matches `require`,
 * resolution fails first with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` — an error that says nothing about the real
 * situation, which is that the module is ESM. This is the regression test for
 * the `default` condition in `exports`, and for the `./package.json` subpath
 * that tooling routinely reads.
 *
 * Both requires are unconditional. Reading the subpath out of the packed
 * manifest first would make the check describe whatever the manifest happens
 * to say rather than what a consumer is promised: dropping `./package.json`
 * from `exports` would silently skip the assertion instead of failing it,
 * which is the one outcome this check exists to prevent.
 *
 * @param {string} consumer - Consumer directory.
 * @param {string} packageName - Installed package name.
 * @returns {void}
 *
 * @remarks
 * Exported so `tests/smoke-package.test.ts` can exercise both outcomes
 * directly; see {@link checkRuntimeImports} for why `runNode` is the boundary
 * mocked rather than a real tarball install.
 */
export function checkRequireInterop(consumer, packageName) {
  step("requiring the package from a CommonJS consumer");
  const result = runInConsumer(
    consumer,
    "check-require.cjs",
    `const assert = require("node:assert/strict");

const api = require(${JSON.stringify(packageName)});
assert.equal(
  typeof api,
  "object",
  "require() did not return a module namespace; check the exports conditions",
);
assert.ok(
  Object.keys(api).filter((name) => name !== "__esModule").length > 0,
  "require() returned no named exports; check the exports conditions",
);
console.log("  require() resolved the package root");

const manifest = require(${JSON.stringify(`${packageName}/package.json`)});
assert.equal(manifest.name, ${JSON.stringify(packageName)});
console.log("  require() resolved the ./package.json subpath");
`,
  );

  if (result.status !== 0) {
    fail("ERR_SMOKE_REQUIRE_FAILED", {
      what: "A CommonJS consumer could not require the published package.",
      subject: packageName,
      expected:
        "require() resolves through a matching exports condition on a runtime with require(esm)",
      actual: `exit ${String(result.status)}\n${excerpt(result.stderr || result.stdout)}`,
      next: 'Keep a "default" condition on the "." export and a "./package.json" subpath in package.json.',
    });
  }
  process.stdout.write(result.stdout);
}

/**
 * A packed file path that `exports` must refuse to resolve for a consumer.
 *
 * @remarks
 * Derived from the manifest so this holds for any package, including one with
 * no private directory at all. A path the manifest points at is a real file in
 * the tarball, and is unreachable by that path unless `exports` also spells it
 * as a subpath key — which the filter excludes.
 *
 * @param {unknown} manifest - The installed package manifest.
 * @returns {string | undefined} A path relative to the package root.
 */
export function unexportedEntryPath(manifest) {
  const exports = readKey(manifest, "exports");
  const exportedKeys = new Set(
    typeof exports === "object" && exports !== null
      ? Object.keys(/** @type {Record<string, unknown>} */ (exports))
          .filter((key) => key.startsWith("./"))
          .map((key) => key.slice(2))
      : [],
  );
  return requiredEntryPaths(manifest).find(
    (candidate) => candidate.endsWith(".js") && !exportedKeys.has(candidate),
  );
}

/**
 * Step 11: a packed file must not be reachable by deep import.
 *
 * @param {string} consumer - Consumer directory.
 * @param {string} packageName - Installed package name.
 * @param {string | undefined} entryPath - From {@link unexportedEntryPath}.
 * @returns {void}
 *
 * @remarks
 * Exported so `tests/smoke-package.test.ts` can exercise both outcomes
 * directly; see {@link checkRuntimeImports} for why `runNode` is the boundary
 * mocked rather than a real tarball install.
 */
export function checkDeepImportBlocked(consumer, packageName, entryPath) {
  if (entryPath === undefined) {
    step("skipping the deep-import check: the manifest points at no packed .js file");
    return;
  }
  const specifier = `${packageName}/${entryPath}`;
  step(`checking that ${specifier} is not reachable`);
  const result = runInConsumer(
    consumer,
    "check-deep-import.mjs",
    `import assert from "node:assert/strict";

// The file is inside the tarball on purpose — the manifest points at it. What
// must hold is that \`exports\` refuses to resolve it by that path.
await assert.rejects(
  import(${JSON.stringify(specifier)}),
  (error) => {
    assert.equal(
      error.code,
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      \`expected ERR_PACKAGE_PATH_NOT_EXPORTED, received \${String(error.code)}\`,
    );
    return true;
  },
);
console.log("  deep import correctly refused");
`,
  );

  if (result.status !== 0) {
    fail("ERR_SMOKE_DEEP_IMPORT_ALLOWED", {
      what: "A packed file was reachable by deep import, or the import failed for the wrong reason.",
      subject: specifier,
      expected: "the import rejects with ERR_PACKAGE_PATH_NOT_EXPORTED",
      actual: `exit ${String(result.status)}\n${excerpt(result.stderr || result.stdout)}`,
      next: 'Keep `exports` an allowlist of subpaths and never add a "./*" pattern.',
    });
  }
  process.stdout.write(result.stdout);
}

/**
 * Compile a generated TypeScript consumer against the installed package.
 *
 * @remarks
 * The project is created *inside* the consumer directory so ordinary upward
 * `node_modules` resolution finds the installed package. No `paths` mapping is
 * involved, which means this exercises the same resolution a real consumer gets.
 *
 * @param {string} consumer - Directory holding the installed package.
 * @param {string} packageName - Installed package name.
 * @param {"NodeNext" | "Bundler"} resolution - `moduleResolution` under test.
 * @returns {string} `tsc --listFiles` output.
 *
 * @remarks
 * Exported so `tests/smoke-package.test.ts` can exercise both outcomes of
 * {@link checkTypeScriptConsumers} directly, mocking `runNode` at the
 * subprocess boundary rather than compiling a real project for every case.
 */
export function compileTypeScriptConsumer(consumer, packageName, resolution) {
  const project = path.join(consumer, `ts-${resolution.toLowerCase()}`);
  mkdirSync(project, { recursive: true });

  const nodeNext = resolution === "NodeNext";
  writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify(
      {
        name: `ts-${resolution.toLowerCase()}`,
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          // Bundler resolution is only valid with `module: Preserve`; NodeNext
          // pairs with itself. Both are what a real consumer would write.
          module: nodeNext ? "NodeNext" : "Preserve",
          moduleResolution: resolution,
          strict: true,
          noEmit: true,
          // Check the published declarations rather than trusting them.
          skipLibCheck: false,
          ...(nodeNext
            ? {
                // A Node consumer has @types/node. Borrowing this repository's
                // copy keeps the check offline; it is ambient environment for
                // the consumer, not this package's source, and the assertion
                // below still forbids reading src/ or dist/.
                lib: ["ES2023"],
                types: ["node"],
                typeRoots: [
                  path
                    .join(repoRoot, "node_modules", "@types")
                    .split(path.sep)
                    .join("/"),
                ],
              }
            : {
                // A bundler consumer may have no Node types at all, so the
                // declarations must rest on standard globals only.
                lib: ["ES2023", "DOM"],
                types: [],
              }),
        },
        include: ["index.ts"],
      },
      null,
      2,
    )}\n`,
  );
  // A namespace import names no symbol, so this compiles for any package. Not
  // a weaker check: `skipLibCheck` is off above, so the import makes tsc fully
  // check every published declaration. Reading the keys keeps it from being
  // elided.
  writeFileSync(
    path.join(project, "index.ts"),
    `import * as api from ${JSON.stringify(packageName)};

export type PublicSurface = typeof api;

export function publicNames(): readonly string[] {
  const surface: PublicSurface = api;
  return Object.keys(surface);
}
`,
  );

  const tsc = resolveDependencyBin("typescript", "tsc");
  const result = runNode(tsc, ["-p", "tsconfig.json", "--listFiles"], { cwd: project });
  if (result.status !== 0) {
    fail("ERR_SMOKE_CONSUMER_TSC_FAILED", {
      what: `A TypeScript consumer using ${resolution} resolution did not compile.`,
      subject: `moduleResolution: ${resolution}`,
      expected: "tsc exits 0 against the published declarations",
      actual: `exit ${String(result.status)}\n${excerpt(result.stdout || result.stderr)}`,
      next: "Run `pnpm run build` and `pnpm run package:check`, then check `exports.types`.",
    });
  }
  return result.stdout;
}

/**
 * Steps 9 and 10: the consumer compiles, and does so without this repository.
 *
 * @param {string} consumer - Directory holding the installed package.
 * @param {string} packageName - Installed package name.
 * @returns {void}
 *
 * @remarks
 * Exported so `tests/smoke-package.test.ts` can exercise the
 * repository-leak check directly.
 */
export function checkTypeScriptConsumers(consumer, packageName) {
  step("compiling a NodeNext TypeScript consumer");
  const listed = compileTypeScriptConsumer(consumer, packageName, "NodeNext");

  step("checking that the consumer's compiler never read this repository's code");
  // The proof that the published declarations are self-contained: if any file
  // under this repository's src/ or dist/ appears, the consumer only
  // type-checked because the repository happens to be on this disk.
  const forbiddenRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "dist")];
  const offenders = listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) =>
      forbiddenRoots.some(
        (root) =>
          line === root ||
          line.startsWith(`${root}${path.sep}`) ||
          line.startsWith(`${root}/`),
      ),
    );
  if (offenders.length > 0) {
    fail("ERR_SMOKE_CONSUMER_READ_REPOSITORY", {
      what: "The consumer's compiler read this repository's own sources.",
      subject: offenders.slice(0, 5).join(", "),
      expected: "only the installed package and the TypeScript lib files",
      actual: `${String(offenders.length)} file(s) under src/ or dist/`,
      next: "Check that `exports.types` points into dist/ and that no published declaration re-exports a path outside the package.",
    });
  }

  if (isUniversalProfile()) {
    step("compiling a Bundler-resolution consumer (universal-library profile)");
    compileTypeScriptConsumer(consumer, packageName, "Bundler");
  } else {
    step(
      "skipping the Bundler-resolution consumer: this is a Node profile " +
        "(tsconfig.build.json sets compilerOptions.types to a non-empty list)",
    );
  }
}

// -----------------------------------------------------------------------------
// Command-line entry point
// -----------------------------------------------------------------------------

/**
 * Resolve the tarball to smoke test from the command line.
 *
 * @remarks
 * `--tarball` exists for the release workflow, which packs once and must verify
 * and publish that exact file rather than an equivalent rebuild.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {string} Path to the tarball.
 * @throws Error when the arguments are unusable.
 */
export function resolveTarballArgument(argv) {
  /** @type {string | undefined} */
  let packDir;
  /** @type {string | undefined} */
  let tarball;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--pack-dir" && flag !== "--tarball") {
      throw new Error(`Unknown argument: ${String(flag)}\n\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.\n\n${USAGE}`);
    }
    if (flag === "--pack-dir") {
      packDir = value;
    } else {
      tarball = value;
    }
    index += 1;
  }

  if ((packDir === undefined) === (tarball === undefined)) {
    throw new Error(`Pass exactly one of --pack-dir or --tarball.\n\n${USAGE}`);
  }
  return tarball ?? findSingleTarball(/** @type {string} */ (packDir));
}

/**
 * Run the smoke test as a command.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {number} Process exit code.
 *
 * @remarks
 * Exported so `tests/smoke-package.test.ts` can exercise the argument-error,
 * unreadable-tarball, tarball-content-failure and full-success paths
 * directly, mocking `runNode` at the subprocess boundary and, for the
 * success path, a synthetic tarball built without a real `npm pack`/install.
 */
export function main(argv) {
  /** @type {string} */
  let tarball;
  try {
    tarball = path.resolve(resolveTarballArgument(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const manifest = parseJson(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const packageName = readString(manifest, "name");
  if (packageName === undefined) {
    console.error(
      "ERR_SMOKE_NO_PACKAGE_NAME: package.json has no name field.\n" +
        "Next: restore the `name` field before packing.",
    );
    return 1;
  }

  // Created before the try block so the cleanup in `finally` always has
  // something to remove, whichever step fails.
  const workspace = mkdtempSync(path.join(tmpdir(), "package-smoke-"));
  try {
    step(`tarball: ${path.basename(tarball)}`);
    const entries = readTarEntries(readFileSync(tarball));
    checkTarballContents(entries, path.basename(tarball));

    const consumer = installConsumer(workspace, tarball);

    // The packed manifest is the authority throughout this function: it is what
    // a consumer resolves against, and it can differ from the repository's
    // working copy once `publishConfig` is folded in. `checkTarballContents`
    // above already reads it out of `entries`; this re-reads it from the
    // installed copy so npm's own resolution — not this script's tar parsing —
    // is the source for `publicSubpaths`.
    const installedManifest = parseJson(
      readFileSync(
        path.join(consumer, "node_modules", packageName, "package.json"),
        "utf8",
      ),
    );

    checkRuntimeImports(
      consumer,
      packageName,
      publicSubpaths(installedManifest),
      readKey(installedManifest, "exports") !== undefined,
    );
    checkBinCommands(consumer, packageName, installedManifest);
    checkRequireInterop(consumer, packageName);
    checkTypeScriptConsumers(consumer, packageName);
    checkDeepImportBlocked(
      consumer,
      packageName,
      unexportedEntryPath(installedManifest),
    );

    step("all checks passed");
    return 0;
  } catch (error) {
    if (error instanceof SmokeError) {
      console.error(`\n${error.message}`);
      return 1;
    }
    console.error(
      `\nERR_SMOKE_UNEXPECTED: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return 1;
  } finally {
    // Runs on success and on failure, so the throwaway consumer never survives.
    // The pack directory is left alone on purpose: it is gitignored, the next
    // run empties it before packing, and keeping it means a failed run leaves
    // the exact tarball available for inspection. `pnpm clean` removes it.
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
