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

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { runCli } from "../src/cli.js";
import { RecordNoCapturesError } from "../src/internal/errors.js";
import {
  generateFixtureFile,
  loadFixtures,
  readCapturedEnvelopes,
  YAML_SCHEMA_COMMENT,
} from "../src/internal/fixture/index.js";
import { emitFixtures } from "../src/internal/record/index.js";
import { loadSpecFile } from "../src/internal/spec/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC = loadSpecFile(
  path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json"),
);

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hookassert-emit-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write one captured payload envelope of the shape `record`'s own capture
 * script produces (see `src/internal/record/capture.ts`), so these tests
 * exercise the real envelope contract rather than a shape invented here.
 */
function writeEnvelope(
  captureDir: string,
  fileName: string,
  overrides: Record<string, unknown> = {},
): string {
  mkdirSync(captureDir, { recursive: true });
  const envelopePath = path.join(captureDir, fileName);
  const envelope = {
    capturedAt: "2026-09-01T12:00:00.000Z",
    event: "PreToolUse",
    claudeVersion: "2.1.251",
    sourceFile: path.join(captureDir, fileName),
    payload: {
      session_id: "abc123",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    },
    ...overrides,
  };
  writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return envelopePath;
}

describe("readCapturedEnvelopes", () => {
  it("reads every envelope in the capture directory, in capture order", () => {
    const captureDir = makeTempDir();
    writeEnvelope(captureDir, "capture-2026-09-01T12-00-00-000Z-bbb.json");
    writeEnvelope(captureDir, "capture-2026-09-01T11-00-00-000Z-aaa.json");

    const envelopes = readCapturedEnvelopes(captureDir);

    expect(envelopes).toHaveLength(2);
    // capture.ts names files by ISO timestamp, so filename order is capture order.
    expect(path.basename(envelopes[0]?.envelopePath ?? "")).toContain("11-00-00");
    expect(path.basename(envelopes[1]?.envelopePath ?? "")).toContain("12-00-00");
  });

  it("reads a capture directory that does not exist as nothing captured yet", () => {
    const root = makeTempDir();

    expect(readCapturedEnvelopes(path.join(root, "never-recorded"))).toEqual([]);
  });

  it("skips a file that is not valid JSON rather than failing the whole read", () => {
    const captureDir = makeTempDir();
    writeEnvelope(captureDir, "capture-good.json");
    writeFileSync(path.join(captureDir, "capture-broken.json"), "{ not json", "utf8");

    expect(readCapturedEnvelopes(captureDir)).toHaveLength(1);
  });

  it.each([
    ["no event", { event: undefined }],
    ["an empty event", { event: "" }],
  ])("skips an envelope with %s", (_label, overrides) => {
    const captureDir = makeTempDir();
    const envelope = {
      capturedAt: "2026-09-01T12:00:00.000Z",
      payload: {},
      ...overrides,
    };
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(
      path.join(captureDir, "capture-odd.json"),
      JSON.stringify(envelope),
      "utf8",
    );

    expect(readCapturedEnvelopes(captureDir)).toEqual([]);
  });
});

describe("generateFixtureFile", () => {
  it("emits one fixture case per captured envelope with origin.recorded pointing at that envelope", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    const outputDir = path.join(root, "fixtures");
    const envelopePath = writeEnvelope(captureDir, "capture-one.json");

    const [envelope] = readCapturedEnvelopes(captureDir);
    if (envelope === undefined) {
      throw new Error("expected one envelope");
    }
    const generated = generateFixtureFile(envelope, outputDir);

    // One case, and its origin resolves back to the envelope it came from.
    expect(generated.text).toContain("cases:");
    expect(generated.text).toContain("event: PreToolUse");
    const recorded = /recorded: (?<value>\S+)/u.exec(generated.text)?.groups?.["value"];
    expect(recorded).toBeDefined();
    expect(path.resolve(outputDir, recorded ?? "")).toBe(envelopePath);
  });

  it("the emitted expect is exactly { fires: true } — no invented decision, exitCode, or output expectations", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    // An envelope carrying an outcome a "smarter" generator might be tempted to
    // assert from. Nothing here may reach `expect`.
    writeEnvelope(captureDir, "capture-tempting.json", {
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        permission_decision: "deny",
        exit_code: 2,
        stdout: "blocked by policy",
      },
    });

    const [envelope] = readCapturedEnvelopes(captureDir);
    if (envelope === undefined) {
      throw new Error("expected one envelope");
    }
    const { text } = generateFixtureFile(envelope, path.join(root, "fixtures"));

    // Asserted on the parsed `expect` block, not by substring over the whole
    // file: the captured payload is echoed back verbatim as `input`, so a
    // payload key like `permission_decision` legitimately puts "decision:" in
    // the text without any expectation having been invented.
    const parsed = parseYaml(text) as { cases: { expect: unknown }[] };
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0]?.expect).toEqual({ fires: true });
  });

  it("the emitted YAML file's first line is the yaml-language-server $schema line", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    writeEnvelope(captureDir, "capture-one.json");

    const [envelope] = readCapturedEnvelopes(captureDir);
    if (envelope === undefined) {
      throw new Error("expected one envelope");
    }
    const { text } = generateFixtureFile(envelope, path.join(root, "fixtures"));

    expect(text.split("\n")[0]).toBe(YAML_SCHEMA_COMMENT);
  });

  it("carries the payload's tool_name onto the case, and omits tool when the payload names none", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    writeEnvelope(captureDir, "capture-a-tool.json");
    writeEnvelope(captureDir, "capture-b-none.json", {
      event: "SessionStart",
      payload: { hook_event_name: "SessionStart" },
    });

    const envelopes = readCapturedEnvelopes(captureDir);
    const outputDir = path.join(root, "fixtures");
    const withTool = envelopes[0];
    const withoutTool = envelopes[1];
    if (withTool === undefined || withoutTool === undefined) {
      throw new Error("expected two envelopes");
    }

    expect(generateFixtureFile(withTool, outputDir).text).toContain("tool: Bash");
    expect(generateFixtureFile(withoutTool, outputDir).text).not.toContain("tool:");
  });
});

describe("emitFixtures", () => {
  it("writes one fixture file per envelope into the output directory", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    const outputDir = path.join(root, "fixtures");
    writeEnvelope(captureDir, "capture-one.json");
    writeEnvelope(captureDir, "capture-two.json");

    const result = emitFixtures({ captureDir, outputDir });

    expect(result.files).toHaveLength(2);
    expect(readdirSync(outputDir).sort()).toEqual([
      "capture-one.fixture.yaml",
      "capture-two.fixture.yaml",
    ]);
  });

  it("creates an output directory that does not exist yet", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    writeEnvelope(captureDir, "capture-one.json");

    const outputDir = path.join(root, "deep", "nested", "fixtures");
    emitFixtures({ captureDir, outputDir });

    expect(readdirSync(outputDir)).toEqual(["capture-one.fixture.yaml"]);
  });

  it("emitting into a directory that already has fixture files does not overwrite or corrupt them", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    const outputDir = path.join(root, "fixtures");
    writeEnvelope(captureDir, "capture-one.json");

    // A hand-authored fixture that happens to live in the output directory.
    mkdirSync(outputDir, { recursive: true });
    const handAuthored = path.join(outputDir, "my-own.fixture.yaml");
    const handAuthoredText =
      "cases:\n  - event: SessionStart\n    expect:\n      fires: false\n";
    writeFileSync(handAuthored, handAuthoredText, "utf8");

    emitFixtures({ captureDir, outputDir });

    // The collision policy is a distinct filename per envelope, derived from
    // the envelope's own already-unique name — so nothing else is touched.
    expect(readFileSync(handAuthored, "utf8")).toBe(handAuthoredText);
    expect(readdirSync(outputDir).sort()).toEqual([
      "capture-one.fixture.yaml",
      "my-own.fixture.yaml",
    ]);
  });

  it("regenerates the same file rather than accumulating duplicates on a second run", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    const outputDir = path.join(root, "fixtures");
    writeEnvelope(captureDir, "capture-one.json");

    emitFixtures({ captureDir, outputDir });
    const first = readFileSync(
      path.join(outputDir, "capture-one.fixture.yaml"),
      "utf8",
    );
    emitFixtures({ captureDir, outputDir });

    expect(readdirSync(outputDir)).toEqual(["capture-one.fixture.yaml"]);
    expect(readFileSync(path.join(outputDir, "capture-one.fixture.yaml"), "utf8")).toBe(
      first,
    );
  });

  it("rejects a capture directory holding no readable envelopes", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    mkdirSync(captureDir, { recursive: true });

    try {
      emitFixtures({ captureDir, outputDir: path.join(root, "fixtures") });
      expect.unreachable("emitFixtures should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordNoCapturesError);
      expect((error as RecordNoCapturesError).code).toBe("ERR_RECORD_NO_CAPTURES");
      expect((error as RecordNoCapturesError).exitCode).toBe(5);
    }
  });

  it("a fixture generated from captured payloads loads through loadFixtures unchanged", () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    const outputDir = path.join(root, "fixtures");
    writeEnvelope(captureDir, "capture-one.json");

    const result = emitFixtures({ captureDir, outputDir });
    const loaded = loadFixtures(result.files, REAL_SPEC);

    expect(loaded.files).toHaveLength(1);
    const file = loaded.files[0];
    expect(file?.file.cases).toHaveLength(1);
    const testCase = file?.file.cases[0];
    expect(testCase?.event).toBe("PreToolUse");
    expect(testCase?.tool).toBe("Bash");
    expect(testCase?.expect).toEqual({ fires: true });
    // origin.recorded resolved back to the envelope, so the loader read it.
    expect(testCase?.origin.kind).toBe("recorded");
  });
});

describe("explain --emit-fixtures", () => {
  it("writes fixtures and reports what it wrote", async () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    writeEnvelope(captureDir, "capture-one.json");

    const result = await runCli(
      ["explain", "--emit-fixtures", "fixtures", "--capture-dir", captureDir],
      "hookassert",
      { cwd: root },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("capture-one.fixture.yaml");
    expect(readdirSync(path.join(root, "fixtures"))).toEqual([
      "capture-one.fixture.yaml",
    ]);
  });

  it.each([
    ["a positional event", ["explain", "--emit-fixtures", "out", "PreToolUse"]],
    ["--format", ["explain", "--emit-fixtures", "out", "--format", "json"]],
    ["--settings", ["explain", "--emit-fixtures", "out", "--settings", "s.json"]],
    [
      "--claude-version",
      ["explain", "--emit-fixtures", "out", "--claude-version", "2.1.251"],
    ],
  ])("rejects %s alongside --emit-fixtures", async (_label, argv) => {
    const root = makeTempDir();

    const result = await runCli(argv, "hookassert", { cwd: root });

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("--emit-fixtures");
  });

  it("reports the no-captures failure through the CLI rather than throwing", async () => {
    const root = makeTempDir();
    const captureDir = path.join(root, "captures");
    mkdirSync(captureDir, { recursive: true });

    const result = await runCli(
      ["explain", "--emit-fixtures", "fixtures", "--capture-dir", captureDir],
      "hookassert",
      { cwd: root },
    );

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("ERR_RECORD_NO_CAPTURES");
  });
});
