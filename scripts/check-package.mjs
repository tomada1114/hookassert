#!/usr/bin/env node
// Inspect a packed tarball: what it contains, what it must not contain, how
// large it is, and whether every declared entry point is actually inside it.
//
// The tarball is parsed here rather than by shelling out to `tar` or adding a
// dependency: one implementation behaves identically on every OS, and the
// dependency review surface of a template stays at zero. Everything below the
// command-line entry point is a pure function so `tests/package.test.ts` can
// exercise the boundaries without packing anything.
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey } from "./lib/json.mjs";
import { findSingleTarball } from "./lib/tarball.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * One file recorded in a tarball.
 *
 * @typedef {object} TarEntry
 * @property {string} path - Path with npm's leading `package/` removed.
 * @property {number} size - Size in bytes as recorded in the header.
 * @property {"file" | "directory" | "symlink" | "other"} type - Entry kind.
 * @property {Buffer} [data] - Contents, present when the entry was parsed from
 * an archive rather than constructed in a test.
 */

/**
 * One reason a tarball is not publishable.
 *
 * @typedef {object} PackageProblem
 * @property {string} code - Stable identifier, safe to match in a test or hook.
 * @property {string} message - What failed, expected versus actual, and the next
 * safe command. Never contains a secret or an absolute home path.
 * @property {string} [path] - The entry responsible, when there is one.
 */

/**
 * Size and count ceilings for the published tarball.
 *
 * @typedef {object} PackageLimits
 * @property {number} maxUnpackedBytes - Total of every regular file.
 * @property {number} maxFileCount - Number of regular files.
 * @property {number} maxSingleFileBytes - Largest individual file.
 */

// -----------------------------------------------------------------------------
// Policy
// -----------------------------------------------------------------------------

/**
 * Ceilings enforced by {@link inspectPackageEntries}.
 *
 * @remarks
 * Deliberately literals in a tracked file rather than an environment variable or
 * a generated baseline: raising a ceiling then shows up as a reviewable diff
 * instead of happening silently (spec 02 §4).
 *
 * These are tripwires for unintended inclusion, not a size budget for the
 * package's own design. A bundled dependency tree should trip the file and
 * unpacked-size limits, while a committed binary should trip the single-file
 * limit. The values stay deliberately reviewable literals so raising one is a
 * visible policy decision rather than a silent change.
 *
 * @type {PackageLimits}
 */
export const PACKAGE_LIMITS = {
  maxUnpackedBytes: 1_048_576,
  maxFileCount: 200,
  maxSingleFileBytes: 131_072,
};

/**
 * The only paths allowed in the tarball.
 *
 * @remarks
 * An allowlist, not a denylist: a new kind of file has to be added here on
 * purpose. The first three patterns are the files npm and pnpm include
 * regardless of `files`, so refusing them would be unimplementable; the last is
 * the build output and JSON metadata, restricted to extensions that belong in a
 * published package.
 */
export const ALLOWED_PATHS = [
  { label: "the package manifest", pattern: /^package\.json$/ },
  { label: "the readme npm always includes", pattern: /^README(\.[A-Za-z0-9]+)?$/i },
  {
    label: "the license npm always includes",
    pattern: /^LICEN[SC]E(\.[A-Za-z0-9]+)?$/i,
  },
  {
    label: "compiled output and JSON metadata under dist/",
    // The extension list is the whole point: only compiled output and package
    // metadata may live under dist/.
    // Interior dots are allowed in the basename because a source file may be
    // named `date.utils.ts`, which emits `dist/date.utils.js`. A leading dot is
    // not, so a stray `.DS_Store`-style file cannot slip through, and `.` and
    // `..` are excluded as directory segments.
    pattern:
      /^dist\/(?:(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:d\.ts\.map|d\.ts|js\.map|js|json)$/,
  },
];

/**
 * Paths the tarball must contain.
 *
 * @remarks
 * `ALLOWED_PATHS` says what may ship; without this list nothing says what has
 * to. A tarball that lost its LICENSE or README would otherwise pass every
 * check while being unpublishable in practice.
 *
 * The patterns are the very entries of {@link ALLOWED_PATHS}, referenced rather
 * than re-spelled, so "allowed" and "required" cannot drift apart.
 */
export const REQUIRED_PATHS = [
  { label: "the package manifest", sample: "package.json" },
  { label: "a readme", sample: "README" },
  { label: "a license", sample: "LICENSE" },
].map(({ label, sample }) => {
  const rule = ALLOWED_PATHS.find((candidate) => candidate.pattern.test(sample));
  if (rule === undefined) {
    throw new Error(
      `ERR_PACKAGE_POLICY_INCONSISTENT: no ALLOWED_PATHS pattern matches ${sample}.\n` +
        "Expected: every required file to also be on the allowlist.\n" +
        "Next: fix ALLOWED_PATHS in scripts/check-package.mjs so the two lists agree.",
    );
  }
  return { label, sample, pattern: rule.pattern };
});

/**
 * Paths that are dangerous rather than merely unexpected.
 *
 * @remarks
 * Every one of these would already fail the allowlist. They are checked
 * separately so the error names the actual hazard — "an SSH private key" — which
 * is what a maintainer or an agent needs in order to react, instead of the
 * uninformative "not allowed".
 */
export const FORBIDDEN_PATHS = [
  {
    // Any segment beginning `.env`, which is the spec's `.env*`: this covers
    // `.env`, `.env.local`, `.envrc` and an `.env/` directory alike.
    pattern: /(^|\/)\.env/i,
    reason: "an environment file, which routinely holds credentials",
  },
  { pattern: /(^|\/)secrets?(\/|$)/i, reason: "a secrets directory" },
  {
    pattern: /(^|\/)\.npmrc$/i,
    reason: "an .npmrc, which can hold a registry auth token",
  },
  { pattern: /\.(pem|key|p12|pfx)$/i, reason: "private key or certificate material" },
  { pattern: /(^|\/)id_rsa(\.|$)/i, reason: "an SSH private key" },
  {
    pattern: /^src(\/|$)/,
    reason: "TypeScript source; consumers must resolve types from dist/*.d.ts",
  },
  {
    // Matched at any depth, not just the root: `dist/tests/helper.js` satisfies
    // the allowlist above on its own, so this is the only thing that stops
    // compiled tests from shipping.
    pattern: /(^|\/)tests?(\/|$)/,
    reason: "a test directory, which is not part of the contract",
  },
  { pattern: /(^|\/)[^/]*\.test\.[^/]+$/, reason: "a test file" },
  { pattern: /(^|\/)fixtures?(\/|$)/, reason: "test fixtures" },
  { pattern: /(^|\/)coverage(\/|$)/, reason: "coverage output" },
  { pattern: /(^|\/)node_modules(\/|$)/, reason: "installed dependencies" },
  { pattern: /\.tsbuildinfo$/, reason: "a TypeScript incremental build cache" },
  { pattern: /(^|\/)\.git/, reason: "git metadata or GitHub workflow configuration" },
  { pattern: /(^|\/)\.claude(\/|$)/, reason: "local agent configuration" },
  {
    pattern: /^(scripts|etc|docs)(\/|$)/,
    reason: "repository tooling or documentation, which consumers never load",
  },
];

/**
 * `scripts` entries that npm and pnpm run automatically during install,
 * without a consumer ever asking for them.
 *
 * @remarks
 * `prepare` is included even though it also runs on `git clone` of the
 * package's own repository (a case this tarball is never in): once published,
 * npm runs it on every install too, which is the behavior this check exists
 * to catch.
 */
export const INSTALL_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
];

/**
 * Manifest fields compared between the repository's `package.json` (with
 * `publishConfig` folded on top, the way `pnpm pack` folds it) and the
 * manifest actually found inside the tarball.
 *
 * @remarks
 * Not every field is worth comparing: `description`, `keywords`, `license`
 * and similar carry no install-time behavior. These six decide what code
 * runs and which files a consumer can resolve, which is exactly what a
 * `publishConfig` override could redirect without touching anything else a
 * reviewer would think to check. `imports` is included alongside `exports`
 * and `bin` because it governs the package's own internal `#specifier`
 * resolution the same way `exports` governs a consumer's.
 */
export const MANIFEST_COMPARISON_FIELDS = [
  "name",
  "version",
  "exports",
  "imports",
  "bin",
  "files",
];

// -----------------------------------------------------------------------------
// tar reading
// -----------------------------------------------------------------------------

const BLOCK_SIZE = 512;
const NPM_ROOT_PREFIX = "package/";

/**
 * Read a NUL-terminated string out of a header field.
 *
 * @param {Buffer} block - The 512-byte header.
 * @param {number} offset - Field start.
 * @param {number} length - Field width.
 * @returns {string} The field value without its padding.
 */
function readField(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/**
 * Read a numeric header field.
 *
 * @remarks
 * Octal with NUL or space padding is the ustar encoding. GNU switches to
 * base 256 with the high bit of the first byte set once a value no longer fits,
 * which matters for a file over 8 GB — handled for completeness rather than
 * because a package should ever get there.
 *
 * @param {Buffer} block - The 512-byte header.
 * @param {number} offset - Field start.
 * @param {number} length - Field width.
 * @returns {number} The decoded value, or 0 when the field is blank.
 */
function readNumeric(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const first = field[0] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let index = 1; index < field.length; index += 1) {
      value = value * 256 + (field[index] ?? 0);
    }
    return value;
  }
  const text = readField(block, offset, length).trim();
  if (text === "") {
    return 0;
  }
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Verify a header's checksum.
 *
 * @remarks
 * This is what separates "a valid header" from "arbitrary bytes", so it is also
 * how truncated or tampered input is caught instead of being read as a wildly
 * wrong size. Both the unsigned and the historical signed sum are accepted,
 * because some old writers emitted the latter.
 *
 * @param {Buffer} block - The 512-byte header.
 * @returns {boolean} True when the recorded checksum matches.
 */
function hasValidChecksum(block) {
  const recorded = readNumeric(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const byte = block[index] ?? 0;
    // The checksum field itself counts as eight spaces.
    const value = index >= 148 && index < 156 ? 0x20 : byte;
    unsigned += value;
    signed += value > 0x7f ? value - 0x100 : value;
  }
  return recorded === unsigned || recorded === signed;
}

/**
 * Extract the `path` record from a pax extended header.
 *
 * @remarks
 * Records are `"<length> <key>=<value>\n"` where `<length>` counts its own
 * digits. npm's packer emits one of these for any path that cannot be split
 * across the ustar `prefix` and `name` fields.
 *
 * @param {Buffer} data - The extended header's payload.
 * @returns {string | undefined} The overriding path, when the header sets one.
 */
function readPaxPath(data) {
  let offset = 0;
  const text = data.toString("utf8");
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) {
      return undefined;
    }
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) {
      return undefined;
    }
    const record = text.slice(space + 1, offset + length).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") {
      return record.slice(equals + 1);
    }
    offset += length;
  }
  return undefined;
}

/**
 * Map a tar type flag onto the entry kinds this script distinguishes.
 *
 * @param {string} flag - The raw type flag character.
 * @returns {TarEntry["type"]} The entry kind.
 */
function entryType(flag) {
  if (flag === "0" || flag === "\0" || flag === "7") {
    return "file";
  }
  if (flag === "5") {
    return "directory";
  }
  if (flag === "1" || flag === "2") {
    return "symlink";
  }
  return "other";
}

/**
 * Parse a gzipped tar archive.
 *
 * @param {Buffer} buffer - Contents of a `.tgz` file.
 * @returns {TarEntry[]} Every entry, in archive order, with npm's leading
 * `package/` removed.
 * @throws Error with code `ERR_TARBALL_UNREADABLE` when the input is not gzip
 * data, or `ERR_TARBALL_CORRUPT` when a header fails its checksum.
 */
export function readTarEntries(buffer) {
  /** @type {Buffer} */
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch {
    throw new Error(
      "ERR_TARBALL_UNREADABLE: the input is not gzip data.\n" +
        "Expected: a .tgz produced by `pnpm pack`.\n" +
        "Next: run `pnpm pack --pack-destination .smoke` and pass that directory.",
    );
  }

  /** @type {TarEntry[]} */
  const entries = [];
  /** @type {string | undefined} */
  let overridePath;
  let offset = 0;

  while (offset + BLOCK_SIZE <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    if (block.every((byte) => byte === 0)) {
      // Two zero blocks terminate an archive; one is enough to stop reading.
      break;
    }
    if (!hasValidChecksum(block)) {
      throw new Error(
        "ERR_TARBALL_CORRUPT: a tar header failed its checksum.\n" +
          `Expected: a valid ustar header at byte ${String(offset - BLOCK_SIZE)}.\n` +
          "Actual: the recorded checksum does not match the header bytes.\n" +
          "Next: run `node scripts/clean.mjs .smoke` and pack again.",
      );
    }

    const size = readNumeric(block, 124, 12);
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    const flag = readField(block, 156, 1);
    if (flag === "L") {
      // GNU long name: the payload is the next entry's real path.
      overridePath = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (flag === "K") {
      // GNU long link target; irrelevant to which paths are published.
      continue;
    }
    if (flag === "x" || flag === "g") {
      overridePath = readPaxPath(data) ?? overridePath;
      continue;
    }

    const name = readField(block, 0, 100);
    const prefix = readField(block, 345, 155);
    const joined = overridePath ?? (prefix === "" ? name : `${prefix}/${name}`);
    overridePath = undefined;

    const stripped = joined.startsWith(NPM_ROOT_PREFIX)
      ? joined.slice(NPM_ROOT_PREFIX.length)
      : joined;
    if (stripped === "") {
      continue;
    }

    entries.push({
      path: stripped,
      size,
      type: entryType(flag),
      data,
    });
  }

  return entries;
}

// -----------------------------------------------------------------------------
// Declared entry points
// -----------------------------------------------------------------------------

/**
 * Collect every relative path appearing as a string leaf.
 *
 * @param {unknown} node - Manifest fragment.
 * @param {Set<string>} found - Accumulator.
 * @returns {void}
 */
function collectPathLeaves(node, found) {
  if (typeof node === "string") {
    if (node === "" || node.includes("://") || node.startsWith("/")) {
      return;
    }
    const normalized = node.startsWith("./") ? node.slice(2) : node;
    // A bare package name is a valid `exports` target for re-export but is not
    // a file in this tarball; only paths with a directory or an extension are.
    if (normalized === "" || normalized === "." || normalized.startsWith("..")) {
      return;
    }
    if (!node.startsWith("./") && !normalized.includes("/")) {
      return;
    }
    found.add(normalized);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPathLeaves(item, found);
    }
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const value of Object.values(/** @type {Record<string, unknown>} */ (node))) {
      collectPathLeaves(value, found);
    }
  }
}

/**
 * Derive the files a manifest promises consumers, from the manifest itself.
 *
 * @remarks
 * Nothing here is hard-coded on purpose. This is the test that spec 01 §1.3 asks
 * for: adding a subpath to `exports` without building its file, or renaming a
 * build output without updating `exports`, becomes a failure rather than a
 * runtime `ERR_MODULE_NOT_FOUND` in someone else's project.
 *
 * @param {unknown} manifest - Parsed `package.json`.
 * @returns {string[]} Sorted, de-duplicated paths relative to the package root.
 */
export function requiredEntryPaths(manifest) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const field of ["exports", "types", "bin", "main", "module"]) {
    collectPathLeaves(readKey(manifest, field), found);
  }
  return [...found].sort();
}

// -----------------------------------------------------------------------------
// Source maps
// -----------------------------------------------------------------------------

const ABSOLUTE_SOURCE = /^(?:\/|[A-Za-z]:[\\/]|file:\/\/)/;

/**
 * Find source map references that leak a build machine's filesystem layout.
 *
 * @remarks
 * `tsc` with `rootDir` emits paths relative to the map, so an absolute entry
 * means the build was misconfigured. Publishing one exposes the directory
 * structure — often including a username — of whoever ran the release.
 *
 * @param {readonly TarEntry[]} entries - Entries from {@link readTarEntries}.
 * @returns {{ path: string; source: string }[]} Every offending reference.
 */
export function findAbsoluteMapSources(entries) {
  /** @type {{ path: string; source: string }[]} */
  const found = [];
  for (const entry of entries) {
    if (!entry.path.endsWith(".map") || entry.data === undefined) {
      continue;
    }
    /** @type {unknown} */
    let map;
    try {
      map = parseJson(entry.data.toString("utf8"));
    } catch {
      found.push({ path: entry.path, source: "<unparsable source map>" });
      continue;
    }
    const sourceRoot = readKey(map, "sourceRoot");
    if (typeof sourceRoot === "string" && ABSOLUTE_SOURCE.test(sourceRoot)) {
      found.push({ path: entry.path, source: sourceRoot });
    }
    const sources = readKey(map, "sources");
    if (!Array.isArray(sources)) {
      continue;
    }
    for (const source of sources) {
      if (typeof source === "string" && ABSOLUTE_SOURCE.test(source)) {
        found.push({ path: entry.path, source });
      }
    }
  }
  return found;
}

/**
 * Find published maps whose sources a consumer cannot reach.
 *
 * @remarks
 * `src/` is on {@link FORBIDDEN_PATHS}, so a map that only names `../src/*.ts`
 * points at nothing once installed — the debugger shows an empty frame instead
 * of the code. A map is self-contained only when it embeds `sourcesContent` for
 * every source, or when every source it names is itself in the tarball.
 *
 * References that are absolute are left to {@link findAbsoluteMapSources}: they
 * are the same file being wrong for a different, more serious reason, and
 * reporting them twice would bury it.
 *
 * @param {readonly TarEntry[]} entries - Entries from {@link readTarEntries}.
 * @returns {PackageProblem[]} One problem per unreachable source.
 */
export function findDanglingMapSources(entries) {
  const present = new Set(
    entries.filter((entry) => entry.type === "file").map((entry) => entry.path),
  );
  /** @type {PackageProblem[]} */
  const problems = [];

  for (const entry of entries) {
    if (!entry.path.endsWith(".map") || entry.data === undefined) {
      continue;
    }
    /** @type {unknown} */
    let map;
    try {
      // An unparsable map is already reported as a leak by
      // findAbsoluteMapSources; nothing further can be said about it here.
      map = parseJson(entry.data.toString("utf8"));
    } catch {
      continue;
    }

    const sources = readKey(map, "sources");
    if (!Array.isArray(sources)) {
      continue;
    }
    const contents = readKey(map, "sourcesContent");
    const sourceRoot = readKey(map, "sourceRoot");
    const root = typeof sourceRoot === "string" ? sourceRoot : "";
    const mapDirectory = path.posix.dirname(entry.path);

    for (const [index, source] of sources.entries()) {
      if (typeof source !== "string" || ABSOLUTE_SOURCE.test(source)) {
        continue;
      }
      const embedded = Array.isArray(contents)
        ? /** @type {readonly unknown[]} */ (contents)[index]
        : undefined;
      if (typeof embedded === "string") {
        continue;
      }
      if (ABSOLUTE_SOURCE.test(root)) {
        continue;
      }
      const resolved = path.posix.normalize(
        path.posix.join(mapDirectory, root, source),
      );
      if (present.has(resolved)) {
        continue;
      }
      problems.push({
        code: "ERR_PACKAGE_MAP_DANGLING_SOURCE",
        path: entry.path,
        message:
          `${entry.path} points at ${resolved}, which the tarball does not contain, ` +
          "and carries no embedded copy of it.\n" +
          "Expected: `sourcesContent` for every source, or a source that is itself published.\n" +
          `Actual: sources[${String(index)}] is ${source} with no sourcesContent entry.\n` +
          "Next: set `inlineSources` in tsconfig.build.json (TypeScript honours it " +
          "for .js.map only, so turn `declarationMap` off), then rebuild and pack again.",
      });
    }
  }

  return problems;
}

// -----------------------------------------------------------------------------
// Inspection
// -----------------------------------------------------------------------------

/**
 * Find the files every published tarball must carry.
 *
 * @remarks
 * npm includes these regardless of `files`, so an absent one means it is absent
 * from the repository root — a package published without its license or readme.
 * The check is kept out of {@link inspectPackageEntries} because it is only
 * meaningful for a complete tarball, never for a fragment of one.
 *
 * @param {readonly TarEntry[]} entries - Entries from {@link readTarEntries}.
 * @returns {PackageProblem[]} One problem per missing requirement.
 */
export function findMissingRequiredPaths(entries) {
  const files = entries.filter((entry) => entry.type === "file");
  /** @type {PackageProblem[]} */
  const problems = [];

  for (const rule of REQUIRED_PATHS) {
    if (files.some((entry) => rule.pattern.test(entry.path))) {
      continue;
    }
    problems.push({
      code: "ERR_PACKAGE_REQUIRED_MISSING",
      path: rule.sample,
      message:
        `The tarball contains no file matching ${rule.label} (${String(rule.pattern)}).\n` +
        `Expected: ${rule.label}, for example ${rule.sample}.\n` +
        "Actual: no entry in the tarball matches.\n" +
        `Next: check that ${rule.sample} exists at the repository root; npm includes ` +
        'it regardless of "files".',
    });
  }

  return problems;
}

/**
 * Format a byte count without a locale-dependent separator.
 *
 * @param {number} bytes - The count.
 * @returns {string} Bytes and a rounded KiB figure.
 */
function formatBytes(bytes) {
  return `${String(bytes)} bytes (${(bytes / 1024).toFixed(1)} KiB)`;
}

/**
 * Check a tarball's entries against the allowlist, the hazard list, the size
 * ceilings, and the manifest's own promises.
 *
 * @param {readonly TarEntry[]} entries - Entries from {@link readTarEntries}.
 * @param {object} [options] - Inspection inputs.
 * @param {unknown} [options.manifest] - Parsed `package.json`; when omitted, the
 * declared-entry-point check is skipped.
 * @param {PackageLimits} [options.limits] - Overrides {@link PACKAGE_LIMITS}.
 * @returns {PackageProblem[]} Every problem found, in a stable order. Empty
 * means the tarball is publishable.
 */
export function inspectPackageEntries(entries, options = {}) {
  const limits = options.limits ?? PACKAGE_LIMITS;
  /** @type {PackageProblem[]} */
  const problems = [];

  for (const entry of entries) {
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
      problems.push({
        code: "ERR_PACKAGE_PATH_UNSAFE",
        path: entry.path,
        message:
          `The tarball contains ${entry.path}, which is absolute or escapes the package root.\n` +
          "Expected: every path relative to the package root.\n" +
          "Next: run `node scripts/clean.mjs dist` and `pnpm run build` before packing.",
      });
      continue;
    }

    const hazard = FORBIDDEN_PATHS.find((rule) => rule.pattern.test(entry.path));
    if (hazard !== undefined) {
      problems.push({
        code: "ERR_PACKAGE_PATH_FORBIDDEN",
        path: entry.path,
        message:
          `The tarball contains ${entry.path}, which is ${hazard.reason}.\n` +
          "Expected: no such path in a published tarball.\n" +
          'Next: narrow `files` in package.json (it should stay ["dist"]) and pack again.',
      });
      continue;
    }

    if (entry.type === "directory") {
      // Directory records carry no content and are not part of the file budget.
      continue;
    }
    if (entry.type !== "file") {
      problems.push({
        code: "ERR_PACKAGE_ENTRY_TYPE",
        path: entry.path,
        message:
          `The entry ${entry.path} is a ${entry.type}, not a regular file.\n` +
          "Expected: regular files only, so installation cannot follow a link out of the package.\n" +
          "Next: remove the link from the packed directory and pack again.",
      });
      continue;
    }

    if (!ALLOWED_PATHS.some((rule) => rule.pattern.test(entry.path))) {
      problems.push({
        code: "ERR_PACKAGE_PATH_NOT_ALLOWED",
        path: entry.path,
        message:
          `The tarball contains ${entry.path}, which is not on the allowlist.\n` +
          `Expected: one of ${ALLOWED_PATHS.map((rule) => rule.label).join("; ")}.\n` +
          "Next: if this file genuinely belongs in the package, add a pattern to " +
          "ALLOWED_PATHS in scripts/check-package.mjs in the same change.",
      });
      continue;
    }

    if (entry.size > limits.maxSingleFileBytes) {
      problems.push({
        code: "ERR_PACKAGE_FILE_TOO_LARGE",
        path: entry.path,
        message:
          `${entry.path} is larger than the single-file ceiling.\n` +
          `Expected: at most ${formatBytes(limits.maxSingleFileBytes)}.\n` +
          `Actual: ${formatBytes(entry.size)}.\n` +
          "Next: check for an accidentally bundled dependency; raise " +
          "PACKAGE_LIMITS.maxSingleFileBytes in scripts/check-package.mjs only deliberately.",
      });
    }
  }

  const files = entries.filter((entry) => entry.type === "file");
  const unpackedBytes = files.reduce((total, entry) => total + entry.size, 0);

  if (files.length > limits.maxFileCount) {
    problems.push({
      code: "ERR_PACKAGE_TOO_MANY_FILES",
      message:
        "The tarball holds more files than the ceiling allows.\n" +
        `Expected: at most ${String(limits.maxFileCount)} files.\n` +
        `Actual: ${String(files.length)} files.\n` +
        "Next: check `files` in package.json; raise PACKAGE_LIMITS.maxFileCount in " +
        "scripts/check-package.mjs only deliberately.",
    });
  }

  if (unpackedBytes > limits.maxUnpackedBytes) {
    const largest = [...files]
      .sort((left, right) => right.size - left.size)
      .slice(0, 5)
      .map((entry) => `  ${entry.path} — ${formatBytes(entry.size)}`)
      .join("\n");
    problems.push({
      code: "ERR_PACKAGE_TOO_LARGE",
      message:
        "The unpacked tarball is larger than the ceiling allows.\n" +
        `Expected: at most ${formatBytes(limits.maxUnpackedBytes)}.\n` +
        `Actual: ${formatBytes(unpackedBytes)}.\n` +
        `Largest files:\n${largest}\n` +
        "Next: check for an accidentally bundled dependency; raise " +
        "PACKAGE_LIMITS.maxUnpackedBytes in scripts/check-package.mjs only deliberately.",
    });
  }

  if (options.manifest !== undefined) {
    const present = new Set(files.map((entry) => entry.path));
    for (const required of requiredEntryPaths(options.manifest)) {
      if (!present.has(required)) {
        problems.push({
          code: "ERR_PACKAGE_ENTRY_MISSING",
          path: required,
          message:
            `package.json promises ${required} but the tarball does not contain it.\n` +
            "Expected: every path named by exports, types, bin, main or module.\n" +
            "Actual: missing from the tarball.\n" +
            "Next: run `pnpm run build`, then check that `files` covers the output.",
        });
      }
    }
  }

  return problems;
}

// -----------------------------------------------------------------------------
// Manifest integrity
// -----------------------------------------------------------------------------

/**
 * Narrow a value to a plain object for property reads, without widening it to
 * `any`.
 *
 * @param {unknown} value - Candidate object.
 * @returns {Record<string, unknown>} `value` itself when it is a non-null
 * object, otherwise an empty object.
 */
function asRecord(value) {
  return typeof value === "object" && value !== null
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * Overlay a manifest's `publishConfig` onto its own top level, the way
 * `pnpm pack` and `npm publish` do when they decide what a consumer sees.
 *
 * @remarks
 * `publishConfig` exists precisely so a package can develop with one `exports`
 * or `bin` and publish another; folding it in before comparing is what makes
 * {@link findManifestMismatch} judge an *intended* override as a match rather
 * than as tampering. Treating any `publishConfig` at all as suspicious would
 * make this repository's own `publishConfig.access`/`provenance`/`registry`
 * block (see package.json) fail the check it exists to run.
 *
 * @param {unknown} manifest - Parsed `package.json`.
 * @returns {Record<string, unknown>} A shallow copy with `publishConfig`
 * fields overlaid on top of the matching top-level keys.
 */
function withPublishConfigApplied(manifest) {
  const base = asRecord(manifest);
  const publishConfig = asRecord(readKey(base, "publishConfig"));
  return { ...base, ...publishConfig };
}

/**
 * Find an install-time lifecycle script in the manifest actually packed into
 * the tarball.
 *
 * @remarks
 * `pnpm pack` folds `publishConfig` onto the manifest before writing it into
 * the archive, so a `publishConfig.scripts.postinstall` that never appears at
 * the manifest's top level would otherwise run for every consumer while
 * passing a check that only reads the repository's `package.json` on disk.
 * This is checked against the manifest already read out of the tarball, which
 * is the one a real `npm install` acts on.
 *
 * @param {unknown} packedManifest - Manifest parsed from the tarball's own
 * `package.json` entry.
 * @returns {PackageProblem[]} One problem per lifecycle script found.
 */
export function findInstallScripts(packedManifest) {
  const scripts = asRecord(readKey(packedManifest, "scripts"));
  /** @type {PackageProblem[]} */
  const problems = [];

  for (const name of INSTALL_LIFECYCLE_SCRIPTS) {
    const command = readKey(scripts, name);
    if (command === undefined) {
      continue;
    }
    problems.push({
      code: "ERR_PACKAGE_INSTALL_SCRIPT",
      path: "package.json",
      message:
        `The packed manifest declares a "${name}" script, which npm and pnpm run ` +
        "automatically during install, with no consumer action required.\n" +
        "Expected: no preinstall, install, postinstall or prepare script in a published package.json.\n" +
        `Actual: scripts.${name} is ${JSON.stringify(command)}.\n` +
        "Next: remove the script from package.json and from publishConfig.scripts if set " +
        "there, then rebuild and pack again.",
    });
  }

  return problems;
}

/**
 * Compare the manifest packed into the tarball against the repository's own
 * `package.json`, after folding the repository manifest's `publishConfig`
 * onto it.
 *
 * @remarks
 * Every other check in this file that reads "the manifest" reads the
 * repository's file on disk, never the one npm or pnpm actually wrote into the
 * archive. A `publishConfig` that redirects `exports`, adds a `bin`, or
 * renames `files` would pass every one of those checks while shipping
 * something different to a consumer's `npm install`. This is the one check
 * that compares the two directly, field by field, so an override has to be
 * the one recorded in `publishConfig` — nothing else can explain a
 * difference.
 *
 * @param {unknown} packedManifest - Manifest parsed from the tarball's own
 * `package.json` entry.
 * @param {unknown} repositoryManifest - Parsed `package.json` at the
 * repository root.
 * @returns {PackageProblem[]} One problem per field that differs.
 */
export function findManifestMismatch(packedManifest, repositoryManifest) {
  const expected = withPublishConfigApplied(repositoryManifest);
  const packed = asRecord(packedManifest);
  /** @type {PackageProblem[]} */
  const problems = [];

  for (const field of MANIFEST_COMPARISON_FIELDS) {
    const expectedValue = readKey(expected, field);
    const actualValue = readKey(packed, field);
    if (isDeepStrictEqual(expectedValue, actualValue)) {
      continue;
    }
    problems.push({
      code: "ERR_PACKAGE_MANIFEST_MISMATCH",
      path: "package.json",
      message:
        `The packed manifest's "${field}" does not match the repository manifest ` +
        "with publishConfig applied.\n" +
        `Expected: ${JSON.stringify(expectedValue)}\n` +
        `Actual: ${JSON.stringify(actualValue)}\n` +
        "Next: check package.json's publishConfig for an unintended override, then " +
        "rebuild and pack again.",
    });
  }

  return problems;
}

/**
 * Parse the `package.json` entry actually shipped inside the tarball.
 *
 * @remarks
 * A tar archive can validly contain more than one header for the same path;
 * a sequential extractor (the one `npm install` uses) writes each entry to
 * disk in archive order, so the *last* one is what a consumer actually ends
 * up running. Reading the first match here instead would let a crafted
 * tarball smuggle a clean, first "package.json" past this check while a
 * second, tampered one is what gets installed — so this reads the last entry
 * at that path, not the first.
 *
 * @param {readonly TarEntry[]} entries - Entries from {@link readTarEntries}.
 * @returns {unknown} The parsed manifest, or `undefined` when the tarball
 * carries no top-level `package.json` file or its contents do not parse as
 * JSON. The latter case is not silently swallowed: {@link inspectTarball}
 * still finds the raw entry and reports it as unreadable, since
 * {@link findMissingRequiredPaths} only checks that a matching path exists,
 * never that its contents parse.
 *
 * @remarks
 * Exported so `scripts/smoke-package.mjs` can read the same packed manifest
 * before it installs the tarball, instead of checking tarball contents
 * against the repository's own `package.json`.
 */
export function parsePackedManifest(entries) {
  const manifestEntry = entries.findLast(
    (candidate) => candidate.path === "package.json" && candidate.type === "file",
  );
  if (manifestEntry?.data === undefined) {
    return undefined;
  }
  try {
    return parseJson(manifestEntry.data.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A problem for a packed `package.json` that is present but did not parse.
 *
 * @remarks
 * `findMissingRequiredPaths` only checks that a path matching `package.json`
 * exists, never that its contents parse, so without this an unreadable
 * manifest would leave every manifest-driven check (entry points, install
 * scripts, manifest mismatch) silently skipped instead of failing loudly.
 * Shared by {@link inspectTarball} and `scripts/smoke-package.mjs`'s
 * `checkTarballContents`, which both drive those checks off
 * {@link parsePackedManifest}.
 *
 * @param {readonly TarEntry[]} entries - Entries from {@link readTarEntries}.
 * @param {unknown} packedManifest - The result of {@link parsePackedManifest}
 * for the same `entries`.
 * @returns {PackageProblem[]} One problem when `package.json` is present but
 * unparsable, otherwise empty.
 */
export function findUnreadableManifest(entries, packedManifest) {
  if (
    packedManifest !== undefined ||
    !entries.some((entry) => entry.path === "package.json" && entry.type === "file")
  ) {
    return [];
  }
  return [
    {
      code: "ERR_PACKAGE_MANIFEST_UNREADABLE",
      path: "package.json",
      message:
        "The tarball's package.json entry could not be parsed as JSON.\n" +
        "Expected: a well-formed JSON manifest at the tarball root.\n" +
        "Actual: package.json is present but its contents do not parse.\n" +
        "Next: run `pnpm run build`, then check that `pnpm pack` produced a valid " +
        "package.json before packing again.",
    },
  ];
}

/**
 * Inspect a tarball on disk.
 *
 * @remarks
 * The declared-entry-point check ({@link requiredEntryPaths}, wired in through
 * {@link inspectPackageEntries}'s `manifest` option) is driven by the manifest
 * parsed out of the tarball itself, not by `repositoryManifest` — what a
 * consumer resolves against is whatever shipped, and after `publishConfig` is
 * folded in the two can legitimately differ.
 *
 * @param {string} tarballPath - Path to a `.tgz`.
 * @param {unknown} repositoryManifest - Parsed `package.json` at the
 * repository root, used to check the packed manifest against it.
 * @returns {PackageProblem[]} Every problem found.
 */
export function inspectTarball(tarballPath, repositoryManifest) {
  const entries = readTarEntries(readFileSync(tarballPath));
  const packedManifest = parsePackedManifest(entries);

  const problems = [
    ...inspectPackageEntries(entries, { manifest: packedManifest }),
    ...findMissingRequiredPaths(entries),
    ...findDanglingMapSources(entries),
  ];

  if (packedManifest !== undefined) {
    problems.push(...findInstallScripts(packedManifest));
    problems.push(...findManifestMismatch(packedManifest, repositoryManifest));
  } else {
    problems.push(...findUnreadableManifest(entries, packedManifest));
  }

  for (const leak of findAbsoluteMapSources(entries)) {
    problems.push({
      code: "ERR_PACKAGE_MAP_ABSOLUTE_PATH",
      path: leak.path,
      message:
        `${leak.path} references a source by absolute path.\n` +
        "Expected: paths relative to the map, so the build machine's layout stays private.\n" +
        `Actual: ${leak.source.replace(/^(\/|file:\/\/\/)[^\s]*?([^/]+\/[^/]+)$/, "$1…/$2")}\n` +
        "Next: confirm `rootDir` and `outDir` in tsconfig.build.json, then rebuild.",
    });
  }

  return problems;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const USAGE = `Usage: node scripts/check-package.mjs (--pack-dir <dir> | --tarball <file>)

Inspects a packed tarball against the allowlist, the forbidden-path list, the
size ceilings in PACKAGE_LIMITS, the files REQUIRED_PATHS demands, the entry
points package.json declares, the reachability of every source map source, and
the packed package.json itself: no install-time lifecycle script, and no field
that differs from the repository manifest once publishConfig is applied.

Exit codes:
  0  the tarball is publishable
  1  at least one problem was found
  2  the arguments were wrong`;

/**
 * Resolve the tarball to inspect from the command line.
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
    if (flag === "--pack-dir" || flag === "--tarball") {
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
      continue;
    }
    throw new Error(`Unknown argument: ${String(flag)}\n\n${USAGE}`);
  }

  if ((packDir === undefined) === (tarball === undefined)) {
    throw new Error(`Pass exactly one of --pack-dir or --tarball.\n\n${USAGE}`);
  }
  return tarball ?? findSingleTarball(/** @type {string} */ (packDir));
}

/**
 * Run the inspection as a command.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @param {string} [root] - Repository root whose package.json is compared
 * against the packed manifest; defaults to this checkout. Overridable so a
 * test can point the comparison at a fixture package instead of building and
 * packing this repository itself.
 * @returns {number} Process exit code.
 */
export function main(argv, root = REPO_ROOT) {
  /** @type {string} */
  let tarballPath;
  try {
    tarballPath = resolveTarballArgument(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const manifest = parseJson(readFileSync(path.join(root, "package.json"), "utf8"));

  /** @type {PackageProblem[]} */
  let problems;
  try {
    problems = inspectTarball(tarballPath, manifest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (problems.length === 0) {
    console.log(`check-package: ${path.basename(tarballPath)} is publishable.`);
    return 0;
  }

  console.error(
    `check-package: ${String(problems.length)} problem(s) in ${path.basename(tarballPath)}\n`,
  );
  for (const problem of problems) {
    console.error(`[${problem.code}] ${problem.message}\n`);
  }
  return 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
