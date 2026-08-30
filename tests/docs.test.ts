import {
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

import { describe, expect, it } from "vitest";

import { parseJson, readKey, readString } from "../scripts/lib/json.mjs";
import { resolveDependencyBin, runNode } from "../scripts/lib/node-tools.mjs";
import { normalizeIdentifier } from "../src/index.js";

// the `updating-docs` skill requires every documented code example to
// compile against the *current* public API. Nothing did: a substring
// assertion on README.md's own text catches a copy-paste typo, but not a
// renamed option or a tightened parameter type, and TypeDoc renders an
// `@example` block as prose without type-checking it. This file extracts
// every documented snippet and actually compiles it, against `src/index.ts`
// directly (via a `paths` mapping) rather than the published declarations —
// scripts/smoke-package.mjs's compileTypeScriptConsumer checks the built
// package for a real consumer; this checks the source's own contract, so it
// fails the moment a signature changes, in the same PR, before a release.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Read a required string field off a parsed JSON value, or fail loudly. */
function requireStringField(value: unknown, key: string): string {
  const field = readString(value, key);
  if (typeof field !== "string") {
    throw new Error(`expected "${key}" to be a string field`);
  }
  return field;
}

// Read from package.json rather than hardcoding the bootstrap-substituted name
// literally: a `const packageName = "<name>";` assignment is reformatted by
// Prettier onto two lines once the substituted name is long enough to push the
// line past printWidth, and the checked-in single-line form would then no
// longer match what `prettier --check` expects (see #113).
const packageManifest = parseJson(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const packageName = requireStringField(packageManifest, "name");

/** One documented, compilable snippet. */
interface Snippet {
  readonly label: string;
  readonly source: string;
}

const FENCED_TS_BLOCK = /```ts\n([\s\S]*?)```/g;

function readmeSnippets(): Snippet[] {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  return [...readme.matchAll(FENCED_TS_BLOCK)].map((match, index) => ({
    label: `README.md snippet ${String(index + 1)}`,
    source: match[1] ?? "",
  }));
}

function srcFiles(): string[] {
  // src/internal/** is never re-exported from index.ts (see AGENTS.md), so a
  // symbol documented there is not reachable as `import { x } from "hookassert"`.
  // Scanning it anyway would misreport a scope mistake as a docs-content bug.
  const internalPrefix = `internal${path.sep}`;
  return readdirSync(path.join(repoRoot, "src"), { recursive: true })
    .filter(
      (entry): entry is string =>
        typeof entry === "string" &&
        entry.endsWith(".ts") &&
        !entry.startsWith(internalPrefix),
    )
    .map((entry) => path.join("src", entry));
}

/**
 * An `@example` block never imports the symbol it demonstrates — the doc
 * comment sits right above the export, so the import is implicit to a
 * reader. Compiling it standalone needs that import synthesized, from the
 * exported name the comment is attached to.
 */
const JSDOC_THEN_EXPORT =
  /\/\*\*([\s\S]*?)\*\/\s*\nexport\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g;

/**
 * A fixture prepended to one specific documented example, for an identifier
 * the example deliberately leaves free (a reader is expected to supply it) —
 * never a change to the documented example itself.
 */
const SNIPPET_FIXTURES = new Map<string, string>([
  ["withTimeout", "declare const url: string;\n"],
]);

/** Strip a JSDoc comment's leading ` * ` from every line, left over from
 * `/\*\*...\*\/` capturing the comment body verbatim. */
function stripJsDocLinePrefix(comment: string): string {
  return comment.replace(/^[ \t]*\*[ \t]?/gm, "");
}

function exampleSnippets(): Snippet[] {
  const snippets: Snippet[] = [];
  for (const relativeFile of srcFiles()) {
    const text = readFileSync(path.join(repoRoot, relativeFile), "utf8");
    for (const match of text.matchAll(JSDOC_THEN_EXPORT)) {
      const comment = stripJsDocLinePrefix(match[1] ?? "");
      const exportedName = match[2] ?? "";
      if (!comment.includes("@example")) {
        continue;
      }
      const fence = FENCED_TS_BLOCK.exec(comment);
      FENCED_TS_BLOCK.lastIndex = 0;
      if (fence === null) {
        continue;
      }
      const fixture = SNIPPET_FIXTURES.get(exportedName) ?? "";
      snippets.push({
        label: `${relativeFile}'s @example for ${exportedName}`,
        source: `${fixture}import { ${exportedName} } from ${JSON.stringify(packageName)};\n${fence[1] ?? ""}`,
      });
    }
  }
  return snippets;
}

/** Write one snippet as its own compilable TypeScript project. */
function writeSnippetProject(dir: string, snippet: Snippet): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "snippet.ts"), snippet.source);
  // NodeNext resolves each file's module format from the nearest
  // package.json's "type" field; with none, tsc treats a bare .ts file as
  // CommonJS and rejects top-level await in a documented example that uses it.
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "docs-snippet", private: true, type: "module" }, null, 2)}\n`,
  );
  const indexPath = path.join(repoRoot, "src", "index.ts").split(path.sep).join("/");
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [
            path.join(repoRoot, "node_modules", "@types").split(path.sep).join("/"),
          ],
          paths: { [packageName]: [indexPath] },
        },
        include: ["snippet.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

function compiles(snippet: Snippet): { ok: boolean; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "docs-snippet-"));
  try {
    writeSnippetProject(dir, snippet);
    const tsc = resolveDependencyBin("typescript", "tsc");
    const result = runNode(tsc, ["-p", "tsconfig.json"], { cwd: dir });
    return { ok: result.status === 0, output: result.stdout || result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("documented examples compile against the public API", () => {
  const snippets = [...readmeSnippets(), ...exampleSnippets()];

  it("found at least one snippet to check", () => {
    expect(snippets.length).toBeGreaterThan(0);
  });

  it.each(snippets.map((snippet) => [snippet.label, snippet] as const))(
    "%s compiles",
    (_label, snippet) => {
      const result = compiles(snippet);
      if (!result.ok) {
        throw new Error(result.output);
      }
      expect(result.ok).toBe(true);
    },
  );
});

describe("README quick start", () => {
  it("matches runtime behavior", () => {
    const result = normalizeIdentifier("Hello World");
    expect(result).toBe("hello-world");
    // The "documented examples compile" suite above only type-checks this
    // snippet — a `// => "..."` comment is inert to tsc. Compare the
    // annotation against the real, current output here, so a stale or
    // typo'd claimed result still fails loudly.
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain(`// => ${JSON.stringify(result)}`);
  });
});

describe("README's Node.js floor", () => {
  it("matches package.json's engines.node", () => {
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const manifest = parseJson(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    const nodeRange = readString(readKey(manifest, "engines"), "node");
    expect(typeof nodeRange).toBe("string");
    const floor = /^>=(\d+)$/.exec(String(nodeRange))?.[1];
    if (floor === undefined) {
      throw new Error(
        `package.json's engines.node (${String(nodeRange)}) is not a bare >=N range`,
      );
    }
    expect(readme).toContain(`Requires Node.js ${floor} or newer`);
  });
});
