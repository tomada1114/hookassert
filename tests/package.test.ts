import { execFileSync } from "node:child_process";
import consoleModule from "node:console";
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
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ALLOWED_PATHS,
  FORBIDDEN_PATHS,
  PACKAGE_LIMITS,
  REQUIRED_PATHS,
  findAbsoluteMapSources,
  findDanglingMapSources,
  findInstallScripts,
  findManifestMismatch,
  findMissingRequiredPaths,
  inspectPackageEntries,
  inspectTarball,
  main as checkPackageMain,
  parsePackedManifest,
  readTarEntries,
  requiredEntryPaths,
  resolveTarballArgument as resolveCheckPackageTarballArgument,
  satisfiesRequiredPath,
} from "../scripts/check-package.mjs";
import { findSingleTarball } from "../scripts/lib/tarball.mjs";
import { checkTarballContents } from "../scripts/smoke-package.mjs";
import { resolveTarballArgument } from "../scripts/verify-package.mjs";

// --- tar writing helpers -----------------------------------------------------
//
// Synthetic archives cover the header variants a real `npm pack` never emits
// (GNU long names, symlink entries) and let a single field be corrupted on
// purpose. The real-tarball cases below use npm itself.

/** Build one 512-byte ustar header block with a valid checksum. */
function tarHeader(
  name: string,
  size: number,
  options: { typeflag?: string; prefix?: string } = {},
): Buffer {
  const block = Buffer.alloc(512);
  const octal = (value: number, width: number): string =>
    `${value.toString(8).padStart(width - 1, "0")}\0`;

  block.write(name, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  // The checksum is computed with this field read as eight spaces.
  block.write("        ", 148, 8, "ascii");
  block.write(options.typeflag ?? "0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(options.prefix ?? "", 345, 155, "utf8");

  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** Pad entry data out to the next 512-byte boundary. */
function tarBody(data: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return padded;
}

/** Header plus padded body for one regular file. */
function tarFile(
  name: string,
  contents: string,
  options: { typeflag?: string; prefix?: string } = {},
): Buffer[] {
  const data = Buffer.from(contents, "utf8");
  return [tarHeader(name, data.length, options), tarBody(data)];
}

/** Terminate and gzip an archive, as `npm pack` would. */
function tarball(blocks: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

// --- synthetic entry helpers -------------------------------------------------

interface Entry {
  path: string;
  size: number;
  type: "file" | "directory" | "symlink" | "other";
  data?: Buffer;
}

function entry(entryPath: string, size = 10, overrides: Partial<Entry> = {}): Entry {
  return { path: entryPath, size, type: "file", ...overrides };
}

/** A minimal manifest whose declared entries all exist in `entries`. */
const SATISFIED_MANIFEST = {
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
};

function codesOf(problems: { code: string }[]): string[] {
  return problems.map((problem) => problem.code);
}

// --- readTarEntries ----------------------------------------------------------

describe("readTarEntries", () => {
  it("parses a plain ustar archive and strips the leading package/ prefix", () => {
    const buffer = tarball([
      ...tarFile("package/package.json", '{"name":"x"}'),
      ...tarFile("package/dist/index.js", "export const a = 1;\n"),
    ]);

    const entries = readTarEntries(buffer);

    expect(entries.map((item) => item.path)).toEqual(["package.json", "dist/index.js"]);
    expect(entries[0]?.size).toBe(12);
    expect(entries.every((item) => item.type === "file")).toBe(true);
  });

  it("exposes entry data so contents can be inspected", () => {
    const buffer = tarball(tarFile("package/dist/index.js", "export const a = 1;\n"));

    const entries = readTarEntries(buffer);

    expect(entries[0]?.data?.toString("utf8")).toBe("export const a = 1;\n");
  });

  it("joins the ustar prefix field with the name field", () => {
    const deep = "a".repeat(60);
    const buffer = tarball(
      tarFile("index.js", "x", { prefix: `package/dist/${deep}` }),
    );

    expect(readTarEntries(buffer).map((item) => item.path)).toEqual([
      `dist/${deep}/index.js`,
    ]);
  });

  it("applies a GNU long name header to the entry that follows it", () => {
    const longPath = `package/dist/${"n".repeat(120)}.js`;
    const nameData = Buffer.from(`${longPath}\0`, "utf8");
    const buffer = tarball([
      tarHeader("././@LongLink", nameData.length, { typeflag: "L" }),
      tarBody(nameData),
      ...tarFile(longPath.slice(0, 100), "x"),
    ]);

    expect(readTarEntries(buffer).map((item) => item.path)).toEqual([
      longPath.slice("package/".length),
    ]);
  });

  it("applies a pax extended header path to the entry that follows it", () => {
    const longPath = `package/dist/${"p".repeat(120)}.js`;
    const record = `path=${longPath}\n`;
    const withLength = `${String(record.length + String(record.length).length + 1)} ${record}`;
    const recordData = Buffer.from(withLength, "utf8");
    const buffer = tarball([
      tarHeader("PaxHeader/long", recordData.length, { typeflag: "x" }),
      tarBody(recordData),
      ...tarFile("truncated-name.js", "x"),
    ]);

    expect(readTarEntries(buffer).map((item) => item.path)).toEqual([
      longPath.slice("package/".length),
    ]);
  });

  it("lets a pax global header set a default for later entries", () => {
    const record = "12 comment=x\n";
    const recordData = Buffer.from(record, "utf8");
    const buffer = tarball([
      tarHeader("PaxHeader/global", recordData.length, { typeflag: "g" }),
      tarBody(recordData),
      ...tarFile("package/dist/index.js", "x"),
    ]);

    expect(readTarEntries(buffer).map((item) => item.path)).toEqual(["dist/index.js"]);
  });

  it("reports directory and symlink entries with a distinct type", () => {
    const buffer = tarball([
      ...tarFile("package/dist/", "", { typeflag: "5" }),
      ...tarFile("package/dist/link.js", "", { typeflag: "2" }),
    ]);

    const entries = readTarEntries(buffer);

    expect(entries.map((item) => item.type)).toEqual(["directory", "symlink"]);
  });

  it("rejects a buffer that is not gzip data", () => {
    expect(() => readTarEntries(Buffer.from("not a tarball"))).toThrow(
      /ERR_TARBALL_UNREADABLE/,
    );
  });

  it("rejects a header whose checksum does not match", () => {
    const blocks = tarFile("package/package.json", "{}");
    const header = blocks[0];
    if (header === undefined) {
      throw new Error("test setup produced no header");
    }
    // Change the name after the checksum was computed over it.
    header.write("package/tampered.json", 0, 100, "utf8");

    expect(() => readTarEntries(tarball(blocks))).toThrow(/ERR_TARBALL_CORRUPT/);
  });
});

// --- inspectPackageEntries ---------------------------------------------------

describe("inspectPackageEntries", () => {
  it("accepts the files npm always includes plus dist output", () => {
    const problems = inspectPackageEntries(
      [
        entry("package.json"),
        entry("README.md"),
        entry("LICENSE"),
        entry("LICENCE.md"),
        entry("dist/index.js"),
        entry("dist/index.d.ts"),
        entry("dist/index.js.map"),
        entry("dist/index.d.ts.map"),
        entry("dist/internal/errors.js"),
      ],
      { manifest: SATISFIED_MANIFEST },
    );

    expect(problems).toEqual([]);
  });

  it("accepts a declared runtime dependency but refuses a bundled copy", () => {
    const manifest = {
      ...SATISFIED_MANIFEST,
      dependencies: { "runtime-helper": "^1.0.0" },
    };
    const packageFiles = [
      entry("package.json"),
      entry("dist/index.js"),
      entry("dist/index.d.ts"),
    ];

    expect(inspectPackageEntries(packageFiles, { manifest })).toEqual([]);
    expect(
      codesOf(
        inspectPackageEntries(
          [...packageFiles, entry("node_modules/runtime-helper/package.json")],
          { manifest },
        ),
      ),
    ).toEqual(["ERR_PACKAGE_PATH_FORBIDDEN"]);
  });

  it("rejects a path that is not on the allowlist", () => {
    const problems = inspectPackageEntries([entry("dist/index.css")], {});

    expect(codesOf(problems)).toContain("ERR_PACKAGE_PATH_NOT_ALLOWED");
    expect(problems[0]?.path).toBe("dist/index.css");
  });

  it("rejects a dist file whose extension is not published output", () => {
    const problems = inspectPackageEntries([entry("dist/index.ts")], {});

    expect(codesOf(problems)).toContain("ERR_PACKAGE_PATH_NOT_ALLOWED");
  });

  it("accepts a JSON metadata file under dist/", () => {
    expect(inspectPackageEntries([entry("dist/spec/claude-code.json")], {})).toEqual(
      [],
    );
  });

  it("rejects an .npmrc under dist/ as forbidden credential material", () => {
    expect(codesOf(inspectPackageEntries([entry("dist/.npmrc")], {}))).toContain(
      "ERR_PACKAGE_PATH_FORBIDDEN",
    );
  });

  it("rejects JSON files outside dist/, schema/ and spec/", () => {
    expect(codesOf(inspectPackageEntries([entry("other/x.json")], {}))).toContain(
      "ERR_PACKAGE_PATH_NOT_ALLOWED",
    );
  });

  it("accepts a JSON file directly under schema/ or spec/", () => {
    expect(inspectPackageEntries([entry("schema/spec.schema.json")], {})).toEqual([]);
    expect(
      inspectPackageEntries([entry("spec/claude-code-2.1.251-2.2.0.json")], {}),
    ).toEqual([]);
  });

  it("rejects a non-JSON file under schema/ or spec/", () => {
    expect(
      codesOf(inspectPackageEntries([entry("schema/spec.schema.txt")], {})),
    ).toContain("ERR_PACKAGE_PATH_NOT_ALLOWED");
    expect(codesOf(inspectPackageEntries([entry("spec/readme.md")], {}))).toContain(
      "ERR_PACKAGE_PATH_NOT_ALLOWED",
    );
  });

  it("rejects a nested subdirectory under schema/ or spec/", () => {
    expect(
      codesOf(inspectPackageEntries([entry("schema/nested/spec.schema.json")], {})),
    ).toContain("ERR_PACKAGE_PATH_NOT_ALLOWED");
    expect(
      codesOf(inspectPackageEntries([entry("spec/nested/claude-code.json")], {})),
    ).toContain("ERR_PACKAGE_PATH_NOT_ALLOWED");
  });

  it.each([
    ["dist/date.utils.js"],
    ["dist/date.utils.d.ts"],
    ["dist/my.module.d.ts.map"],
    ["dist/internal/deep/nested.js.map"],
  ])("accepts %s, which tsc emits for a source name containing a dot", (allowed) => {
    expect(inspectPackageEntries([entry(allowed)], {})).toEqual([]);
  });

  it.each([["dist/.hidden.js"], ["dist/.DS_Store"]])(
    "still rejects the dotfile %s under dist/",
    (dotfile) => {
      expect(codesOf(inspectPackageEntries([entry(dotfile)], {}))).not.toEqual([]);
    },
  );

  it.each([["dist/tests/helper.js"], ["dist/coverage/report.js"], ["dist/test/x.js"]])(
    "flags %s even though the allowlist alone would accept it",
    (nested) => {
      expect(codesOf(inspectPackageEntries([entry(nested)], {}))).toContain(
        "ERR_PACKAGE_PATH_FORBIDDEN",
      );
    },
  );

  it("names the actual danger for a forbidden path, not just the allowlist", () => {
    const problems = inspectPackageEntries([entry("src/index.ts")], {});
    const forbidden = problems.filter(
      (problem) => problem.code === "ERR_PACKAGE_PATH_FORBIDDEN",
    );

    expect(forbidden).toHaveLength(1);
    expect(forbidden[0]?.message).toMatch(/source/i);
  });

  it.each([
    [".env"],
    [".env.local"],
    [".envrc"],
    ["secrets/token.txt"],
    [".npmrc"],
    ["dist/server.pem"],
    ["dist/server.key"],
    ["dist/cert.p12"],
    ["dist/cert.pfx"],
    ["id_rsa"],
    ["src/index.ts"],
    ["test/index.test.js"],
    ["tests/index.test.js"],
    ["dist/index.test.js"],
    ["fixtures/sample.json"],
    ["fixture/sample.json"],
    ["coverage/lcov.info"],
    ["node_modules/left-pad/index.js"],
    ["dist/tsconfig.tsbuildinfo"],
    [".gitignore"],
    [".github/workflows/ci.yml"],
    [".claude/settings.json"],
    ["scripts/clean.mjs"],
    ["etc/tooling-notes.md"],
    ["docs/api/index.html"],
  ])("flags %s as forbidden", (forbiddenPath) => {
    const problems = inspectPackageEntries([entry(forbiddenPath)], {});

    expect(codesOf(problems)).toContain("ERR_PACKAGE_PATH_FORBIDDEN");
  });

  it("rejects path traversal and absolute paths", () => {
    const problems = inspectPackageEntries(
      [entry("../outside.js"), entry("/etc/passwd")],
      {},
    );

    expect(
      problems.filter((problem) => problem.code === "ERR_PACKAGE_PATH_UNSAFE"),
    ).toHaveLength(2);
  });

  it("rejects an entry that is not a regular file", () => {
    const problems = inspectPackageEntries(
      [entry("dist/index.js", 0, { type: "symlink" })],
      {},
    );

    expect(codesOf(problems)).toContain("ERR_PACKAGE_ENTRY_TYPE");
  });

  describe("limits", () => {
    const limits = { maxUnpackedBytes: 100, maxFileCount: 2, maxSingleFileBytes: 60 };

    it("accepts a single file of exactly the maximum size", () => {
      const problems = inspectPackageEntries([entry("dist/index.js", 60)], { limits });

      expect(problems).toEqual([]);
    });

    it("rejects a single file one byte over the maximum", () => {
      const problems = inspectPackageEntries([entry("dist/index.js", 61)], { limits });

      expect(codesOf(problems)).toEqual(["ERR_PACKAGE_FILE_TOO_LARGE"]);
      expect(problems[0]?.message).toContain("61");
      expect(problems[0]?.message).toContain("60");
    });

    it("accepts exactly the maximum file count", () => {
      const problems = inspectPackageEntries(
        [entry("dist/index.js", 1), entry("dist/cli.js", 1)],
        { limits },
      );

      expect(problems).toEqual([]);
    });

    it("rejects one file over the maximum count", () => {
      const problems = inspectPackageEntries(
        [entry("dist/index.js", 1), entry("dist/cli.js", 1), entry("dist/bin.js", 1)],
        { limits },
      );

      expect(codesOf(problems)).toEqual(["ERR_PACKAGE_TOO_MANY_FILES"]);
    });

    it("accepts an unpacked size of exactly the maximum", () => {
      const problems = inspectPackageEntries(
        [entry("dist/index.js", 50), entry("dist/cli.js", 50)],
        { limits },
      );

      expect(problems).toEqual([]);
    });

    it("rejects an unpacked size one byte over the maximum", () => {
      const problems = inspectPackageEntries(
        [entry("dist/index.js", 50), entry("dist/cli.js", 51)],
        { limits },
      );

      expect(codesOf(problems)).toEqual(["ERR_PACKAGE_TOO_LARGE"]);
      // Spec 02 §7.3: point at the files responsible, not just the total.
      expect(problems[0]?.message).toContain("dist/cli.js");
    });

    it("counts directory entries neither toward size nor toward the file count", () => {
      const problems = inspectPackageEntries(
        [
          entry("dist/index.js", 50),
          entry("dist/cli.js", 50),
          entry("dist/", 0, { type: "directory" }),
        ],
        { limits },
      );

      expect(problems).toEqual([]);
    });
  });

  it("reports a declared entry point that the tarball does not contain", () => {
    const problems = inspectPackageEntries([entry("dist/index.js")], {
      manifest: {
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      },
    });

    expect(codesOf(problems)).toEqual(["ERR_PACKAGE_ENTRY_MISSING"]);
    expect(problems[0]?.path).toBe("dist/index.d.ts");
  });

  it("treats a wildcard exports pattern as satisfied by any matching entry", () => {
    const manifest = { exports: { "./schema/*.json": "./schema/*.json" } };

    expect(
      inspectPackageEntries([entry("schema/spec.schema.json")], { manifest }),
    ).toEqual([]);
  });

  it("reports a wildcard exports pattern with no matching entry as missing", () => {
    const problems = inspectPackageEntries([entry("dist/index.js")], {
      manifest: { exports: { "./schema/*.json": "./schema/*.json" } },
    });

    expect(codesOf(problems)).toContain("ERR_PACKAGE_ENTRY_MISSING");
    expect(problems.find((p) => p.code === "ERR_PACKAGE_ENTRY_MISSING")?.path).toBe(
      "schema/*.json",
    );
  });

  it("exposes the deliberately reviewable package limits", () => {
    expect(PACKAGE_LIMITS).toEqual({
      maxUnpackedBytes: 1024 * 1024,
      maxFileCount: 200,
      maxSingleFileBytes: 128 * 1024,
    });
  });

  it("keeps both path lists non-empty", () => {
    expect(ALLOWED_PATHS.length).toBeGreaterThan(0);
    expect(FORBIDDEN_PATHS.length).toBeGreaterThan(0);
  });
});

// --- requiredEntryPaths ------------------------------------------------------

describe("requiredEntryPaths", () => {
  it("collects string leaves from nested exports conditions", () => {
    expect(
      requiredEntryPaths({
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
          },
          "./sub": {
            import: { types: "./dist/sub.d.ts", default: "./dist/sub.js" },
          },
        },
      }),
    ).toEqual(["dist/index.d.ts", "dist/index.js", "dist/sub.d.ts", "dist/sub.js"]);
  });

  it("reads bin in both its string and object forms", () => {
    expect(requiredEntryPaths({ bin: "./dist/bin.js" })).toEqual(["dist/bin.js"]);
    expect(requiredEntryPaths({ bin: { a: "./dist/a.js", b: "dist/b.js" } })).toEqual([
      "dist/a.js",
      "dist/b.js",
    ]);
  });

  it("reads types, main and module", () => {
    expect(
      requiredEntryPaths({
        types: "./dist/index.d.ts",
        main: "./dist/index.cjs",
        module: "./dist/index.js",
      }),
    ).toEqual(["dist/index.cjs", "dist/index.d.ts", "dist/index.js"]);
  });

  it("strips a leading ./ and de-duplicates", () => {
    expect(
      requiredEntryPaths({ types: "./dist/index.d.ts", exports: "dist/index.d.ts" }),
    ).toEqual(["dist/index.d.ts"]);
  });

  it("ignores fallback arrays' non-paths, null targets and bare specifiers", () => {
    expect(
      requiredEntryPaths({
        exports: {
          ".": ["./dist/index.js"],
          "./blocked": null,
          "./external": "some-other-package",
          "./absolute": "/etc/passwd",
        },
      }),
    ).toEqual(["dist/index.js"]);
  });

  it("returns nothing for a manifest that declares no entry points", () => {
    expect(requiredEntryPaths({})).toEqual([]);
  });

  it("matches the entry points this repository actually declares", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const hasBin =
      typeof manifest === "object" &&
      manifest !== null &&
      "bin" in manifest &&
      manifest.bin !== undefined;

    // The point of deriving this from the manifest is that adding an export
    // without building its file is caught. Hard-coding the list here would
    // reintroduce exactly the duplication spec 01 §1.3 forbids.
    expect(requiredEntryPaths(manifest)).toEqual([
      ...(hasBin ? ["dist/cli.js"] : []),
      "dist/index.d.ts",
      "dist/index.js",
      // The conventional `"./package.json": "./package.json"` subpath, which
      // tooling reads and which therefore has to be in the tarball too.
      "package.json",
      // Wildcard subpath exports for the versioned hooks spec's schema and
      // its spec/ JSON files, collected as the raw pattern rather than a
      // literal path — see satisfiesRequiredPath for how a wildcard leaf is
      // checked against the tarball's actual entries.
      "schema/*.json",
      "spec/*.json",
    ]);
  });
});

// --- satisfiesRequiredPath ---------------------------------------------------

describe("satisfiesRequiredPath", () => {
  it("compares a literal requirement for exact equality", () => {
    expect(satisfiesRequiredPath("dist/index.js", "dist/index.js")).toBe(true);
    expect(satisfiesRequiredPath("dist/index.d.ts", "dist/index.js")).toBe(false);
  });

  it("matches a wildcard requirement against a satisfying entry", () => {
    expect(satisfiesRequiredPath("schema/spec.schema.json", "schema/*.json")).toBe(
      true,
    );
    expect(
      satisfiesRequiredPath("spec/claude-code-2.1.251-2.2.0.json", "spec/*.json"),
    ).toBe(true);
  });

  it("rejects an entry outside the wildcard's own directory or extension", () => {
    expect(satisfiesRequiredPath("schema/spec.schema.txt", "schema/*.json")).toBe(
      false,
    );
    expect(satisfiesRequiredPath("other/spec.schema.json", "schema/*.json")).toBe(
      false,
    );
  });
});

// --- findAbsoluteMapSources --------------------------------------------------

describe("findAbsoluteMapSources", () => {
  function mapEntry(mapPath: string, map: unknown): Entry {
    return entry(mapPath, 0, { data: Buffer.from(JSON.stringify(map), "utf8") });
  }

  it("accepts relative sources", () => {
    expect(
      findAbsoluteMapSources([
        mapEntry("dist/index.js.map", { sources: ["../src/index.ts"] }),
      ]),
    ).toEqual([]);
  });

  it.each([
    ["/Users/someone/repo/src/index.ts"],
    ["C:\\Users\\someone\\repo\\src\\index.ts"],
    ["file:///Users/someone/repo/src/index.ts"],
  ])("flags the absolute source %s", (source) => {
    const found = findAbsoluteMapSources([
      mapEntry("dist/index.js.map", { sources: [source] }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("dist/index.js.map");
  });

  it("flags an absolute sourceRoot", () => {
    expect(
      findAbsoluteMapSources([
        mapEntry("dist/index.d.ts.map", {
          sourceRoot: "/Users/someone/repo",
          sources: ["index.ts"],
        }),
      ]),
    ).toHaveLength(1);
  });

  it("ignores entries that are not maps and maps without data", () => {
    expect(
      findAbsoluteMapSources([
        mapEntry("dist/index.js", { sources: ["/absolute.ts"] }),
        entry("dist/index.js.map"),
      ]),
    ).toEqual([]);
  });
});

// --- findMissingRequiredPaths ------------------------------------------------

describe("parsePackedManifest", () => {
  it("returns undefined when the tarball has no package.json entry at all", () => {
    expect(parsePackedManifest([])).toBeUndefined();
  });
});

describe("findMissingRequiredPaths", () => {
  it("accepts a tarball carrying the manifest, a readme and a license", () => {
    expect(
      findMissingRequiredPaths([
        entry("package.json"),
        entry("README.md"),
        entry("LICENSE"),
        entry("dist/index.js"),
      ]),
    ).toEqual([]);
  });

  it.each([["LICENCE"], ["LICENSE.txt"], ["license.md"]])(
    "accepts the license spelling %s",
    (license) => {
      expect(
        findMissingRequiredPaths([
          entry("package.json"),
          entry("README"),
          entry(license),
        ]),
      ).toEqual([]);
    },
  );

  it("reports the license a tarball forgot", () => {
    const problems = findMissingRequiredPaths([
      entry("package.json"),
      entry("README.md"),
      entry("dist/index.js"),
    ]);

    expect(codesOf(problems)).toEqual(["ERR_PACKAGE_REQUIRED_MISSING"]);
    expect(problems[0]?.path).toBe("LICENSE");
    expect(problems[0]?.message).toMatch(/repository root/);
  });

  it("reports the readme a tarball forgot", () => {
    const problems = findMissingRequiredPaths([
      entry("package.json"),
      entry("LICENSE"),
    ]);

    expect(codesOf(problems)).toEqual(["ERR_PACKAGE_REQUIRED_MISSING"]);
    expect(problems[0]?.path).toBe("README");
  });

  it("reports every requirement of an empty tarball", () => {
    expect(findMissingRequiredPaths([])).toHaveLength(REQUIRED_PATHS.length);
  });

  it("does not count a directory entry as the file it is named after", () => {
    const problems = findMissingRequiredPaths([
      entry("package.json"),
      entry("README.md"),
      entry("LICENSE", 0, { type: "directory" }),
    ]);

    expect(codesOf(problems)).toEqual(["ERR_PACKAGE_REQUIRED_MISSING"]);
  });

  it("requires only files the allowlist also permits", () => {
    // The two lists share their regexes, so a required file can never be a
    // file the tarball is forbidden to carry.
    for (const rule of REQUIRED_PATHS) {
      expect(inspectPackageEntries([entry(rule.sample)], {})).toEqual([]);
    }
  });
});

// --- findDanglingMapSources --------------------------------------------------

describe("findDanglingMapSources", () => {
  function mapEntry(mapPath: string, map: unknown): Entry {
    return entry(mapPath, 0, { data: Buffer.from(JSON.stringify(map), "utf8") });
  }

  it("accepts a map that embeds the contents of every source", () => {
    expect(
      findDanglingMapSources([
        entry("dist/index.js"),
        mapEntry("dist/index.js.map", {
          version: 3,
          sources: ["../src/index.ts"],
          sourcesContent: ["export const a = 1;\n"],
        }),
      ]),
    ).toEqual([]);
  });

  it("accepts a map whose source is itself published", () => {
    expect(
      findDanglingMapSources([
        entry("dist/index.js"),
        mapEntry("dist/index.js.map", { version: 3, sources: ["./index.js"] }),
      ]),
    ).toEqual([]);
  });

  it("flags a source that is neither embedded nor published", () => {
    const problems = findDanglingMapSources([
      entry("dist/index.js"),
      mapEntry("dist/index.js.map", { version: 3, sources: ["../src/index.ts"] }),
    ]);

    expect(codesOf(problems)).toEqual(["ERR_PACKAGE_MAP_DANGLING_SOURCE"]);
    expect(problems[0]?.path).toBe("dist/index.js.map");
    // The resolved path is what a debugger would look for, so it is what the
    // message has to name.
    expect(problems[0]?.message).toContain("src/index.ts");
  });

  it("flags a declaration map, which tsc emits without sourcesContent", () => {
    expect(
      codesOf(
        findDanglingMapSources([
          mapEntry("dist/index.d.ts.map", { version: 3, sources: ["../src/index.ts"] }),
        ]),
      ),
    ).toEqual(["ERR_PACKAGE_MAP_DANGLING_SOURCE"]);
  });

  it("flags a source whose sourcesContent slot is null", () => {
    expect(
      codesOf(
        findDanglingMapSources([
          mapEntry("dist/index.js.map", {
            version: 3,
            sources: ["../src/a.ts", "../src/b.ts"],
            sourcesContent: ["export const a = 1;\n", null],
          }),
        ]),
      ),
    ).toEqual(["ERR_PACKAGE_MAP_DANGLING_SOURCE"]);
  });

  it("resolves a relative sourceRoot before deciding", () => {
    expect(
      findDanglingMapSources([
        entry("src/index.ts"),
        mapEntry("dist/index.js.map", {
          version: 3,
          sourceRoot: "../src",
          sources: ["index.ts"],
        }),
      ]),
    ).toEqual([]);
  });

  it("leaves an absolute source to findAbsoluteMapSources", () => {
    const entries = [
      mapEntry("dist/index.js.map", {
        version: 3,
        sources: ["/Users/someone/repo/src/index.ts"],
      }),
    ];

    expect(findDanglingMapSources(entries)).toEqual([]);
    expect(findAbsoluteMapSources(entries)).toHaveLength(1);
  });

  it("ignores entries that are not maps and maps without data", () => {
    expect(
      findDanglingMapSources([
        mapEntry("dist/index.js", { sources: ["../src/index.ts"] }),
        entry("dist/index.js.map"),
      ]),
    ).toEqual([]);
  });

  it("ignores a map whose contents do not parse as JSON", () => {
    // findAbsoluteMapSources is what reports an unparsable map as a leak;
    // nothing further can be said about it here.
    expect(
      findDanglingMapSources([
        entry("dist/index.js.map", 0, { data: Buffer.from("not json", "utf8") }),
      ]),
    ).toEqual([]);
  });

  it("ignores a map whose sources field is not an array", () => {
    expect(
      findDanglingMapSources([
        mapEntry("dist/index.js.map", { version: 3, sources: "not-an-array" }),
      ]),
    ).toEqual([]);
  });
});

// --- findInstallScripts -------------------------------------------------

describe("findInstallScripts", () => {
  it.each(["preinstall", "install", "postinstall", "prepare"])(
    "flags a packed manifest declaring %s",
    (name) => {
      const problems = findInstallScripts({ scripts: { [name]: "node evil.js" } });

      expect(codesOf(problems)).toEqual(["ERR_PACKAGE_INSTALL_SCRIPT"]);
      expect(problems[0]?.message).toContain(name);
      expect(problems[0]?.message).toContain("node evil.js");
    },
  );

  it("reports every lifecycle script present, not only the first", () => {
    const problems = findInstallScripts({
      scripts: { postinstall: "a", prepare: "b", build: "c" },
    });

    expect(codesOf(problems)).toEqual([
      "ERR_PACKAGE_INSTALL_SCRIPT",
      "ERR_PACKAGE_INSTALL_SCRIPT",
    ]);
  });

  it("accepts a manifest with no scripts field", () => {
    expect(findInstallScripts({})).toEqual([]);
  });

  it("accepts ordinary, non-lifecycle scripts", () => {
    expect(findInstallScripts({ scripts: { build: "tsc", test: "vitest" } })).toEqual(
      [],
    );
  });

  it("accepts a manifest that is not an object", () => {
    expect(findInstallScripts(undefined)).toEqual([]);
    expect(findInstallScripts(null)).toEqual([]);
  });
});

// --- findManifestMismatch -------------------------------------------------

describe("findManifestMismatch", () => {
  const repositoryManifest = {
    name: "fixture-package",
    version: "1.0.0",
    files: ["dist"],
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  };

  it("accepts a packed manifest identical to the repository manifest", () => {
    expect(findManifestMismatch(repositoryManifest, repositoryManifest)).toEqual([]);
  });

  it("flags an exports field the tarball does not share with the repository manifest", () => {
    const packedManifest = {
      ...repositoryManifest,
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/evil.js" } },
    };

    const problems = findManifestMismatch(packedManifest, repositoryManifest);

    expect(codesOf(problems)).toEqual(["ERR_PACKAGE_MANIFEST_MISMATCH"]);
    expect(problems[0]?.message).toContain("exports");
    expect(problems[0]?.message).toContain("dist/evil.js");
  });

  it.each(["name", "version", "files"] as const)("flags a mismatched %s", (field) => {
    const packedManifest = { ...repositoryManifest, [field]: "something-else" };

    expect(codesOf(findManifestMismatch(packedManifest, repositoryManifest))).toEqual([
      "ERR_PACKAGE_MANIFEST_MISMATCH",
    ]);
  });

  it("flags a bin the repository manifest never declared", () => {
    const packedManifest = { ...repositoryManifest, bin: { evil: "./dist/evil.js" } };

    expect(codesOf(findManifestMismatch(packedManifest, repositoryManifest))).toEqual([
      "ERR_PACKAGE_MANIFEST_MISMATCH",
    ]);
  });

  it("flags an imports map the repository manifest never declared", () => {
    // `imports` redirects the package's own internal `#specifier` resolution
    // the same way `exports`/`bin` redirect a consumer's — an override here
    // must be caught exactly like an `exports` override is.
    const packedManifest = {
      ...repositoryManifest,
      imports: { "#internal": "./dist/evil.js" },
    };

    expect(codesOf(findManifestMismatch(packedManifest, repositoryManifest))).toEqual([
      "ERR_PACKAGE_MANIFEST_MISMATCH",
    ]);
  });

  it("reports one problem per differing field, not only the first", () => {
    const packedManifest = {
      ...repositoryManifest,
      name: "different-name",
      version: "9.9.9",
    };

    expect(codesOf(findManifestMismatch(packedManifest, repositoryManifest))).toEqual([
      "ERR_PACKAGE_MANIFEST_MISMATCH",
      "ERR_PACKAGE_MANIFEST_MISMATCH",
    ]);
  });

  it("folds publishConfig onto the repository manifest before comparing", () => {
    // publishConfig.access/provenance/registry (this repository's own shape)
    // must never be treated as a mismatch on their own — only the fields in
    // MANIFEST_COMPARISON_FIELDS are compared, and folding is required so a
    // deliberate exports/bin override is not flagged as tampering.
    const withPublishConfig = {
      ...repositoryManifest,
      publishConfig: {
        access: "public",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/prod.js" } },
      },
    };
    const packedManifest = {
      ...repositoryManifest,
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/prod.js" } },
    };

    expect(findManifestMismatch(packedManifest, withPublishConfig)).toEqual([]);
  });

  it("still flags a packed manifest that diverges from publishConfig's own promise", () => {
    const withPublishConfig = {
      ...repositoryManifest,
      publishConfig: {
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/prod.js" } },
      },
    };
    const packedManifest = {
      ...repositoryManifest,
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/something-else.js" },
      },
    };

    expect(codesOf(findManifestMismatch(packedManifest, withPublishConfig))).toEqual([
      "ERR_PACKAGE_MANIFEST_MISMATCH",
    ]);
  });
});

// --- inspectTarball: the packed manifest, not the repository's --------------

describe("inspectTarball verifies the manifest actually packed", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "package-manifest-fixture-"));
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const repositoryManifest = {
    name: "fixture-package",
    version: "1.0.0",
    files: ["dist"],
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  };

  /** Write a synthetic tarball whose package.json is `packedManifest`. */
  function writeFixtureTarball(name: string, packedManifest: unknown): string {
    const file = path.join(workspace, name);
    writeFileSync(
      file,
      tarball([
        ...tarFile("package/package.json", JSON.stringify(packedManifest)),
        ...tarFile("package/README.md", "# fixture\n"),
        ...tarFile("package/LICENSE", "MIT\n"),
        ...tarFile("package/dist/index.js", "export const a = 1;\n"),
        ...tarFile("package/dist/index.d.ts", "export declare const a: 1;\n"),
      ]),
    );
    return file;
  }

  it("fails with ERR_PACKAGE_INSTALL_SCRIPT when the packed manifest declares postinstall", () => {
    const tarballPath = writeFixtureTarball("postinstall.tgz", {
      ...repositoryManifest,
      scripts: { postinstall: "node ./evil.js" },
    });

    const problems = inspectTarball(tarballPath, repositoryManifest);

    expect(codesOf(problems)).toContain("ERR_PACKAGE_INSTALL_SCRIPT");
  });

  it("fails with ERR_PACKAGE_MANIFEST_MISMATCH when the packed exports were rewritten", () => {
    const tarballPath = writeFixtureTarball("mismatch.tgz", {
      ...repositoryManifest,
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/evil.js" } },
    });

    const problems = inspectTarball(tarballPath, repositoryManifest);

    expect(codesOf(problems)).toContain("ERR_PACKAGE_MANIFEST_MISMATCH");
  });

  it("passes with no problems when the packed manifest matches the repository manifest", () => {
    const tarballPath = writeFixtureTarball("honest.tgz", repositoryManifest);

    expect(inspectTarball(tarballPath, repositoryManifest)).toEqual([]);
  });

  it("derives required entry points from the packed manifest, not the repository one", () => {
    // The repository manifest promises dist/index.js; the packed manifest
    // (as publishConfig would fold it) promises dist/prod.js instead, which
    // this tarball does not contain. Only the packed manifest's promise
    // should be enforced.
    const tarballPath = writeFixtureTarball("required-entry.tgz", {
      ...repositoryManifest,
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/prod.js" } },
    });

    const problems = inspectTarball(tarballPath, {
      ...repositoryManifest,
      publishConfig: {
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/prod.js" } },
      },
    });

    expect(codesOf(problems)).toContain("ERR_PACKAGE_ENTRY_MISSING");
    expect(codesOf(problems)).not.toContain("ERR_PACKAGE_MANIFEST_MISMATCH");
  });

  it("fails with ERR_PACKAGE_MAP_ABSOLUTE_PATH when a source map leaks a build machine's path", () => {
    const file = path.join(workspace, "absolute-map-source.tgz");
    writeFileSync(
      file,
      tarball([
        ...tarFile("package/package.json", JSON.stringify(repositoryManifest)),
        ...tarFile("package/README.md", "# fixture\n"),
        ...tarFile("package/LICENSE", "MIT\n"),
        ...tarFile("package/dist/index.js", "export const a = 1;\n"),
        ...tarFile("package/dist/index.d.ts", "export declare const a: 1;\n"),
        ...tarFile(
          "package/dist/index.js.map",
          JSON.stringify({
            version: 3,
            sourceRoot: "/Users/whoever/hookassert/src",
            sources: ["index.ts"],
            mappings: "",
          }),
        ),
      ]),
    );

    const problems = inspectTarball(file, repositoryManifest);

    expect(codesOf(problems)).toContain("ERR_PACKAGE_MAP_ABSOLUTE_PATH");
  });

  it("validates the LAST package.json entry when a tarball declares the path twice", () => {
    // A sequential extractor (what `npm install` uses) writes each entry to
    // disk in archive order, so a second "package.json" header overwrites the
    // first on disk — the first is never what a consumer actually runs. If
    // this check read the first match instead, an honest decoy manifest could
    // shield a tampered one that ships right behind it in the same archive.
    const file = path.join(workspace, "duplicate-manifest.tgz");
    writeFileSync(
      file,
      tarball([
        ...tarFile("package/package.json", JSON.stringify(repositoryManifest)),
        ...tarFile(
          "package/package.json",
          JSON.stringify({ ...repositoryManifest, scripts: { postinstall: "evil" } }),
        ),
        ...tarFile("package/README.md", "# fixture\n"),
        ...tarFile("package/LICENSE", "MIT\n"),
        ...tarFile("package/dist/index.js", "export const a = 1;\n"),
        ...tarFile("package/dist/index.d.ts", "export declare const a: 1;\n"),
      ]),
    );

    const problems = inspectTarball(file, repositoryManifest);

    expect(codesOf(problems)).toContain("ERR_PACKAGE_INSTALL_SCRIPT");
  });

  it("fails with ERR_PACKAGE_MANIFEST_UNREADABLE when package.json does not parse as JSON", () => {
    // findMissingRequiredPaths only checks that a package.json entry exists,
    // never that it parses; without a dedicated check here, a corrupt
    // manifest would silently skip the entry-point, install-script and
    // manifest-mismatch checks instead of failing loudly.
    const file = path.join(workspace, "corrupt-manifest.tgz");
    writeFileSync(
      file,
      tarball([
        ...tarFile("package/package.json", "{ not valid json"),
        ...tarFile("package/README.md", "# fixture\n"),
        ...tarFile("package/LICENSE", "MIT\n"),
      ]),
    );

    const problems = inspectTarball(file, repositoryManifest);

    expect(codesOf(problems)).toContain("ERR_PACKAGE_MANIFEST_UNREADABLE");
  });
});

// --- checkTarballContents: the packed manifest, not the repository's -------
//
// Mirrors the "inspectTarball verifies the manifest actually packed" fixtures
// above (issue #30 / PR #82): scripts/smoke-package.mjs's checkTarballContents
// had the same defect — it checked the tarball's declared entry points
// against the *repository's* package.json instead of the manifest actually
// packed, so a publishConfig-redirected `exports` (or an added `bin`) would
// never have its real target verified against the tarball's contents. See
// issue #83.

describe("checkTarballContents reads the packed manifest, not the repository's", () => {
  it("catches a publishConfig-redirected exports target that the tarball never built", () => {
    // Simulates what `pnpm pack` folds in from publishConfig: the manifest
    // actually shipped inside the tarball promises "./dist/evil.js", a path
    // this tarball never built. checkTarballContents must derive its
    // required-entry check from this packed manifest, not from a hard-coded
    // repository manifest that could still promise the honest "./dist/index.js".
    const packedManifest = {
      name: "fixture-package",
      version: "1.0.0",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/evil.js" } },
    };
    const entries = [
      entry("package.json", 10, {
        data: Buffer.from(JSON.stringify(packedManifest), "utf8"),
      }),
      entry("README.md"),
      entry("LICENSE"),
      entry("dist/index.js"),
      entry("dist/index.d.ts"),
    ];

    expect(() => checkTarballContents(entries, "fixture.tgz")).toThrow(
      /ERR_SMOKE_TARBALL_CONTENTS[\s\S]*ERR_PACKAGE_ENTRY_MISSING/,
    );
  });

  it("catches a publishConfig-added bin that the tarball never built", () => {
    const packedManifest = {
      name: "fixture-package",
      version: "1.0.0",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      bin: { "fixture-cli": "./dist/cli.js" },
    };
    const entries = [
      entry("package.json", 10, {
        data: Buffer.from(JSON.stringify(packedManifest), "utf8"),
      }),
      entry("README.md"),
      entry("LICENSE"),
      entry("dist/index.js"),
      entry("dist/index.d.ts"),
    ];

    expect(() => checkTarballContents(entries, "fixture.tgz")).toThrow(
      /ERR_SMOKE_TARBALL_CONTENTS[\s\S]*ERR_PACKAGE_ENTRY_MISSING/,
    );
  });

  it("passes when every entry the packed manifest promises is actually in the tarball", () => {
    const packedManifest = {
      name: "fixture-package",
      version: "1.0.0",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    };
    const entries = [
      entry("package.json", 10, {
        data: Buffer.from(JSON.stringify(packedManifest), "utf8"),
      }),
      entry("README.md"),
      entry("LICENSE"),
      entry("dist/index.js"),
      entry("dist/index.d.ts"),
    ];

    expect(() => checkTarballContents(entries, "fixture.tgz")).not.toThrow();
  });

  it("fails loudly instead of skipping the entry-point check when package.json does not parse", () => {
    const entries = [
      entry("package.json", 10, { data: Buffer.from("{not valid json", "utf8") }),
      entry("README.md"),
      entry("LICENSE"),
      entry("dist/index.js"),
      entry("dist/index.d.ts"),
    ];

    expect(() => checkTarballContents(entries, "fixture.tgz")).toThrow(
      /ERR_SMOKE_TARBALL_CONTENTS[\s\S]*ERR_PACKAGE_MANIFEST_UNREADABLE/,
    );
  });
});

describe("verify-package artifact selection", () => {
  it("accepts one explicit release tarball", () => {
    expect(resolveTarballArgument(["--", "--tarball", "dist/package.tgz"])).toBe(
      path.resolve("dist/package.tgz"),
    );
  });

  it("resolves the single tarball in a pack directory", () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "verify-package-pack-"));
    try {
      writeFileSync(path.join(packDir, "fixture-2.0.0.tgz"), "");

      expect(resolveTarballArgument(["--pack-dir", packDir])).toBe(
        path.resolve(path.join(packDir, "fixture-2.0.0.tgz")),
      );
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it.each([
    { args: [] },
    { args: ["--tarball"] },
    { args: ["--tarball", "--pack-dir"] },
    { args: ["--tarball", "one.tgz", "--pack-dir", "pack"] },
    { args: ["--unknown", "one.tgz"] },
  ])("rejects ambiguous or incomplete arguments: $args", ({ args }) => {
    expect(() => resolveTarballArgument(args)).toThrow();
  });
});

// --- the publish contract ----------------------------------------------------

interface PublishConfig {
  access?: unknown;
  provenance?: unknown;
  registry?: unknown;
}

describe("publishConfig in package.json", () => {
  const { publishConfig } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { publishConfig?: PublishConfig };

  it("states the whole publish contract, so no caller has to repeat it", () => {
    // Every publish path — the release workflow, `pnpm publish:rehearsal`, a
    // human running `npm publish` by hand — reads this object. A flag passed
    // at one call site instead would apply to that call site only, which is
    // how a rehearsal ends up proving something the real publish never does.
    expect(publishConfig?.access).toBe("public");
    expect(publishConfig?.provenance).toBe(true);
  });

  it("pins the registry, so an ambient .npmrc cannot redirect a publish", () => {
    // Without this, `registry=` in a user-level or CI .npmrc silently decides
    // where the package goes, and the first sign is a package that is not on
    // npm.
    expect(publishConfig?.registry).toBe("https://registry.npmjs.org/");
  });
});

// --- a real npm-produced tarball --------------------------------------------

/**
 * Locate the npm CLI that ships with the running Node.
 *
 * @remarks
 * Invoked as a script through `process.execPath` rather than as `npm`, so the
 * test does not depend on PATH or on a shell, and works the same on Windows
 * where `npm` is a `.cmd` shim. The two candidate layouts are the POSIX and
 * Windows installation trees.
 */
function npmCliPath(): string {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `Could not find the npm CLI next to ${process.execPath}. Looked in: ${candidates.join(", ")}`,
    );
  }
  return found;
}

describe("a tarball produced by npm pack", () => {
  // `npm pack` is used rather than `pnpm pack` because pnpm's own path is not
  // available to a child process here, and because this fixture must not depend
  // on the repository having been built: `pnpm check` runs tests before build.
  let workspace: string;
  let root: string;
  let tarballPath: string;
  const longName = `${"long-file-name".repeat(9)}.js`;
  const manifest = {
    name: "fixture-package",
    version: "1.2.3",
    type: "module",
    private: false,
    license: "MIT",
    files: ["dist"],
    bin: { fixture: "./dist/bin.js" },
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    },
  };

  beforeAll(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "package-fixture-"));
    root = path.join(workspace, "fixture-package");
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(path.join(root, "README.md"), "# fixture\n");
    writeFileSync(path.join(root, "LICENSE"), "MIT\n");
    writeFileSync(path.join(root, "dist", "index.js"), "export const a = 1;\n");
    writeFileSync(
      path.join(root, "dist", "index.d.ts"),
      "export declare const a: 1;\n",
    );
    writeFileSync(
      path.join(root, "dist", "index.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../src/index.ts"],
        // Embedded so this fixture is a genuinely problem-free tarball: without
        // it, findDanglingMapSources would flag the map even though nothing
        // about the manifest verification this file tests is at fault.
        sourcesContent: ["export const a = 1;\n"],
        mappings: "",
      }),
    );
    writeFileSync(path.join(root, "dist", "bin.js"), "#!/usr/bin/env node\n");
    // A basename over 100 bytes cannot be split across the ustar prefix and
    // name fields, so npm's packer must emit a pax extended header for it.
    writeFileSync(path.join(root, "dist", longName), "export const b = 2;\n");

    const packDir = path.join(workspace, "pack");
    mkdirSync(packDir);
    execFileSync(
      process.execPath,
      [npmCliPath(), "pack", "--ignore-scripts", "--pack-destination", packDir],
      {
        cwd: root,
        stdio: "pipe",
        env: {
          ...process.env,
          npm_config_cache: path.join(workspace, "npm-cache"),
        },
      },
    );
    tarballPath = findSingleTarball(packDir);
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("parses every entry, including a pax long name", () => {
    const entries = readTarEntries(readFileSync(tarballPath));
    const paths = entries.map((item) => item.path).sort();

    expect(paths).toEqual(
      [
        "LICENSE",
        "README.md",
        "dist/bin.js",
        "dist/index.d.ts",
        "dist/index.js",
        "dist/index.js.map",
        `dist/${longName}`,
        "package.json",
      ].sort(),
    );
    expect(entries.every((item) => item.type === "file")).toBe(true);
    expect(entries.every((item) => item.size > 0)).toBe(true);
  });

  it("reports no problems", () => {
    const entries = readTarEntries(readFileSync(tarballPath));

    expect(inspectPackageEntries(entries, { manifest })).toEqual([]);
  });

  it("has no absolute paths in its source maps", () => {
    const entries = readTarEntries(readFileSync(tarballPath));

    expect(findAbsoluteMapSources(entries)).toEqual([]);
  });

  it("passes inspectTarball with no problems, including the manifest checks", () => {
    // The regression this issue closes: an honestly packed tarball whose
    // manifest carries no install script and matches the repository manifest
    // must still be publishable end to end.
    expect(inspectTarball(tarballPath, manifest)).toEqual([]);
  });

  describe("main", () => {
    it("returns 0 and logs that the tarball is publishable when root points at the fixture package", () => {
      const logSpy = vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);

      expect(checkPackageMain(["--tarball", tarballPath], root)).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/is publishable/));
    });

    it("returns 1 and reports the mismatch when root defaults to this repository", () => {
      // Without the fixture root override, main compares the fixture's packed
      // manifest against this repository's own package.json, whose name and
      // version disagree with the fixture — the rejection path an in-process
      // test can otherwise only reach by building and packing this repository.
      const errorSpy = vi
        .spyOn(consoleModule, "error")
        .mockImplementation(() => undefined);

      expect(checkPackageMain(["--tarball", tarballPath])).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/problem\(s\) in/));
    });

    it("returns 2 and reports unusable arguments", () => {
      const errorSpy = vi
        .spyOn(consoleModule, "error")
        .mockImplementation(() => undefined);

      expect(checkPackageMain(["--bogus"])).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Unknown argument/));
    });

    it("returns 1 when the tarball itself cannot be read", () => {
      const errorSpy = vi
        .spyOn(consoleModule, "error")
        .mockImplementation(() => undefined);
      const missingPath = path.join(workspace, "does-not-exist.tgz");

      expect(checkPackageMain(["--tarball", missingPath], root)).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});

describe("check-package artifact selection", () => {
  it("returns an explicit tarball without consulting the pack directory", () => {
    expect(resolveCheckPackageTarballArgument(["--tarball", "dist/package.tgz"])).toBe(
      "dist/package.tgz",
    );
  });

  it("resolves the single tarball in a pack directory", () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "check-package-pack-"));
    try {
      const tarballPath = path.join(packDir, "fixture-1.0.0.tgz");
      writeFileSync(tarballPath, "");

      expect(resolveCheckPackageTarballArgument(["--pack-dir", packDir])).toBe(
        tarballPath,
      );
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it.each([
    { args: [], reason: "neither flag given" },
    {
      args: ["--tarball", "one.tgz", "--pack-dir", "pack"],
      reason: "both flags given",
    },
  ])("rejects when $reason", ({ args }) => {
    expect(() => resolveCheckPackageTarballArgument(args)).toThrow(
      /Pass exactly one of --pack-dir or --tarball/,
    );
  });

  it.each([
    { args: ["--tarball"], flag: "--tarball" },
    { args: ["--pack-dir"], flag: "--pack-dir" },
    { args: ["--tarball", "--pack-dir"], flag: "--tarball" },
  ])("rejects $flag with a missing or flag-shaped value", ({ args }) => {
    expect(() => resolveCheckPackageTarballArgument(args)).toThrow(/requires a value/);
  });

  it("rejects an argument that is neither --pack-dir nor --tarball", () => {
    expect(() => resolveCheckPackageTarballArgument(["--help"])).toThrow(
      /Unknown argument: --help/,
    );
  });
});
