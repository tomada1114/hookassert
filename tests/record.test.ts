import { spawnSync } from "node:child_process";
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
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  RecordNoSessionError,
  RecordRestoreError,
  SettingsParseError,
  UsageError,
} from "../src/internal/errors.js";
import {
  hooksForEvent,
  loadSourceHooks,
  mergeSources,
} from "../src/internal/settings/index.js";
import { insertCaptureHook, removeCaptureHook } from "../src/internal/settings/edit.js";
import type { CapturePlan } from "../src/internal/settings/edit.js";
import { matchHooks } from "../src/internal/matcher/index.js";
import { loadSpecFile } from "../src/internal/spec/index.js";
import { buildCaptureScript } from "../src/internal/record/capture.js";
import {
  defaultCaptureDir,
  hookassertDir,
  isRecordSessionActive,
  lastRecordedClaudeVersionPath,
  readLastRecordedClaudeVersion,
  sessionFilePath,
  startRecordSession,
  stopRecordSession,
} from "../src/internal/record/session.js";
import type { SettingsSource } from "../src/internal/settings/types.js";

// Reaching src/internal/settings/, src/internal/record/, src/internal/matcher/
// and src/internal/spec/ directly (rather than through src/index.ts's
// exports, per the writing-tests skill) is a deliberate, narrowly scoped
// exception: none of this issue's own plumbing (CapturePlan, CaptureAnchors,
// the record session bookkeeping) has a public surface, or ever will — see
// eslint.config.mjs's "tests/static-layer-unit-tests" block for the full
// reasoning. This file does real filesystem work under mkdtemp and spawns
// the generated capture script as a real process, which is why it joins
// vitest.config.ts's automationTests list rather than the default unit
// project.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const REAL_SPEC = loadSpecFile(REAL_SPEC_PATH);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A realistic pre-existing project settings file, with an unrelated hook already declared. */
const EXISTING_SETTINGS_TEXT = `{
  "permissions": {
    "allow": ["Bash(echo:*)"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "command": "./scripts/guard.sh"
          }
        ]
      }
    ]
  }
}
`;

function matcherForEvent(event: string): string | undefined {
  const spec = REAL_SPEC.events[event];
  return spec?.matcherTargets.kind === "none" ? undefined : "*";
}

/** The `CapturePlan.file` used by every hand-built plan in this file's `insertCaptureHook` tests. */
const SETTINGS_FILE = "/abs/.claude/settings.local.json";

describe("insertCaptureHook", () => {
  const plan: CapturePlan = {
    file: SETTINGS_FILE,
    command: "/abs/.hookassert/capture-hook.cjs",
    entries: [{ event: "PreToolUse", matcher: "*" }],
  };

  it("is a pure function: same text + plan in, same edited text out", () => {
    const first = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);
    const second = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);
    expect(second).toEqual(first);
  });

  it("preserves comments and unrelated formatting in the settings file", () => {
    const withComment = `{
  // keep me
  "permissions": {
    "allow": []
  }
}
`;
    const result = insertCaptureHook(withComment, plan);
    expect(result.text).toContain("// keep me");
    expect(result.text).toContain('"allow": []');
  });

  it("appends a matcher group without a matcher key when the event takes none", () => {
    const stopPlan: CapturePlan = {
      file: SETTINGS_FILE,
      command: plan.command,
      entries: [{ event: "Stop", matcher: undefined }],
    };
    const result = insertCaptureHook("{}", stopPlan);
    expect(result.text).toContain('"hooks": [');
    expect(result.text).not.toContain('"matcher"');
  });

  it("single-quotes the command so a project path with a space survives /bin/sh -c", () => {
    const result = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);
    const parsed = JSON.parse(result.text) as {
      hooks: { PreToolUse: { matcher?: string; hooks: { command: string }[] }[] };
    };
    expect(parsed.hooks.PreToolUse).toContainEqual({
      matcher: "*",
      hooks: [{ command: `'${plan.command}'` }],
    });
  });

  it.each([
    ["a syntax error", "{"],
    ['"hooks" as an array instead of an object', '{"hooks": []}'],
    ['"hooks" as null instead of an object', '{"hooks": null}'],
    [
      '"hooks.PreToolUse" as an object instead of an array',
      '{"hooks": {"PreToolUse": {}}}',
    ],
  ])(
    "throws SettingsParseError (ERR_SETTINGS_PARSE) rather than crashing for %s",
    (_label, malformedText) => {
      let caught: unknown;
      try {
        insertCaptureHook(malformedText, plan);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SettingsParseError);
      expect((caught as SettingsParseError).code).toBe("ERR_SETTINGS_PARSE");
      expect((caught as SettingsParseError).file).toBe(SETTINGS_FILE);
    },
  );
});

describe("insertCaptureHook + removeCaptureHook round trip", () => {
  const plan: CapturePlan = {
    file: SETTINGS_FILE,
    command: "/abs/.hookassert/capture-hook.cjs",
    entries: [
      { event: "PreToolUse", matcher: "*" },
      { event: "Stop", matcher: undefined },
      { event: "SessionStart", matcher: "*" },
    ],
  };

  it.each([
    ["a settings file with existing content", EXISTING_SETTINGS_TEXT],
    ["a bare empty object", "{}"],
    ["a bare empty object with a trailing newline", "{}\n"],
  ])("restores byte-identical text to the original for %s", (_label, original) => {
    const inserted = insertCaptureHook(original, plan);
    const restored = removeCaptureHook(inserted.text, inserted.anchors);
    expect(restored).toBe(original);
  });

  it("the capture hook's presence changes no existing hook's firing set", () => {
    // loadSourceHooks reads from disk; write the fixture to a real temp file
    // so both the "before" and "after" reads go through the real loader
    // rather than a hand-built ResolvedHook, which is what actually proves
    // the acceptance criterion (matchHooks/hooksForEvent on loader output).
    const dir = makeTempDir("hookassert-record-firing-set-");
    const settingsFile = path.join(dir, "settings.json");
    writeFileSync(settingsFile, EXISTING_SETTINGS_TEXT, "utf8");
    const realSource: SettingsSource = { path: settingsFile, layer: "project" };

    const beforeHooks = loadSourceHooks(realSource);
    const beforeResolved = mergeSources([{ source: realSource, hooks: beforeHooks }]);
    const beforeFiring = hooksForEvent(beforeResolved, "PreToolUse");
    const beforeMatch = matchHooks(
      REAL_SPEC,
      { kind: "undetermined" },
      { event: "PreToolUse", hooks: beforeFiring, target: "Bash" },
    );

    const inserted = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);
    writeFileSync(settingsFile, inserted.text, "utf8");

    const afterHooks = loadSourceHooks(realSource);
    const afterResolved = mergeSources([{ source: realSource, hooks: afterHooks }]);
    const afterFiring = hooksForEvent(afterResolved, "PreToolUse");
    const afterMatch = matchHooks(
      REAL_SPEC,
      { kind: "undetermined" },
      { event: "PreToolUse", hooks: afterFiring, target: "Bash" },
    );

    const originalCommand = "./scripts/guard.sh";
    expect(afterMatch.firing.some((h) => h.command === originalCommand)).toBe(
      beforeMatch.firing.some((h) => h.command === originalCommand),
    );
    expect(afterMatch.rejected.some((o) => o.hook.command === originalCommand)).toBe(
      beforeMatch.rejected.some((o) => o.hook.command === originalCommand),
    );
  });

  it("insertCaptureHook rejects an empty settings text as a syntax error rather than guessing", () => {
    expect(() => insertCaptureHook("", plan)).toThrow(SettingsParseError);
  });

  it("removeCaptureHook leaves an event alone when its whole array was deleted by hand", () => {
    const inserted = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);

    // Simulate the user deleting the entire "Stop" array by hand while
    // recording was active — re-serialized rather than surgically edited,
    // since only the resulting JSON shape matters for this test, not its
    // formatting.
    const parsed = JSON.parse(inserted.text) as {
      hooks: Record<string, unknown>;
    };
    delete parsed.hooks["Stop"];
    const withoutStopArray = JSON.stringify(parsed);
    expect(withoutStopArray).not.toContain('"Stop"');

    const restored = removeCaptureHook(withoutStopArray, inserted.anchors);
    // No crash, and every other event's capture hook is still removed.
    expect(restored).not.toContain(plan.command);
    expect(restored).not.toContain('"Stop"');
  });

  it("removes only its own entry, keeping the group, when the user added a sibling command to it", () => {
    const inserted = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);

    // Simulate the user adding a second command into our own capture-hook's
    // matcher group while recording was active.
    const parsed = JSON.parse(inserted.text) as {
      hooks: { PreToolUse: { matcher?: string; hooks: { command: string }[] }[] };
    };
    const ourGroup = parsed.hooks.PreToolUse.find((group) =>
      group.hooks.some((h) => h.command.includes(plan.command)),
    );
    if (ourGroup === undefined) {
      throw new Error("expected to find our own capture-hook group");
    }
    ourGroup.hooks.push({ command: "./other.sh" });
    const withSibling = JSON.stringify(parsed);

    const restored = removeCaptureHook(withSibling, inserted.anchors);
    expect(restored).not.toContain(plan.command);
    // The user's own sibling entry survives: only our command was removed
    // from the shared group, not the whole group.
    expect(restored).toContain("./other.sh");
  });

  it("skips a sibling matcher group with no valid hooks array while still removing its own", () => {
    const inserted = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);

    // A malformed group for the same event, with no "hooks" array at all —
    // removeCaptureHook must skip over it rather than crash.
    const parsed = JSON.parse(inserted.text) as {
      hooks: { PreToolUse: unknown[] };
    };
    parsed.hooks.PreToolUse.unshift({ matcher: "Edit" });
    const withMalformedGroup = JSON.stringify(parsed);

    const restored = removeCaptureHook(withMalformedGroup, inserted.anchors);
    expect(restored).not.toContain(plan.command);
    expect(restored).toContain('"matcher": "Edit"');
  });

  it('leaves "hooks" in place when the user added an unrelated event to it while recording', () => {
    // Insert against a bare object, so "hooks" itself did not preexist.
    const inserted = insertCaptureHook("{}", plan);

    // The user adds a hook for an event this session never recorded, while
    // recording was active — "hooks" must survive even though every event
    // this session's own anchors know about ends up empty and gets pruned.
    const parsed = JSON.parse(inserted.text) as { hooks: Record<string, unknown> };
    parsed.hooks["Notification"] = [{ hooks: [{ command: "./unrelated.sh" }] }];
    const withUnrelatedEvent = JSON.stringify(parsed);

    const restored = removeCaptureHook(withUnrelatedEvent, inserted.anchors);
    expect(restored).not.toContain(plan.command);
    expect(restored).toContain("./unrelated.sh");
    expect(restored).toContain('"hooks"');
  });

  it('removeCaptureHook is a safe no-op against a document that never had a "hooks" key at all', () => {
    // A real anchors object (so its preexisting-flags are meaningful), but
    // the text handed back to removeCaptureHook is a settings file that was
    // reset to empty entirely while recording was active — not merely
    // missing our own event, but missing "hooks" itself.
    const inserted = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);
    const restored = removeCaptureHook("{}", inserted.anchors);
    expect(restored).toBe("{}");
  });

  it("removeCaptureHook tolerates text with no parseable root", () => {
    const inserted = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);
    const restored = removeCaptureHook("", inserted.anchors);
    expect(typeof restored).toBe("string");
  });

  it("removeCaptureHook falls back to treating an event as new when anchors omits it", () => {
    const inserted = insertCaptureHook(EXISTING_SETTINGS_TEXT, plan);
    // A hand-built anchors object missing an entry from
    // preexistingEventArray — the shape a slightly older session file could
    // carry — must still be handled rather than throwing.
    const incompleteAnchors = {
      ...inserted.anchors,
      preexistingEventArray: {},
    };

    const restored = removeCaptureHook(inserted.text, incompleteAnchors);
    expect(restored).not.toContain(plan.command);
  });
});

describe("buildCaptureScript", () => {
  function writeScript(
    dir: string,
    options: Parameters<typeof buildCaptureScript>[0],
  ): string {
    const scriptPath = path.join(dir, "capture-hook.cjs");
    writeFileSync(scriptPath, buildCaptureScript(options), { mode: 0o755 });
    return scriptPath;
  }

  /** Read back the one envelope file a single capture-script run wrote, asserting there is exactly one. */
  function readSoleEnvelope(captureDir: string): {
    readonly path: string;
    readonly envelope: Record<string, unknown>;
  } {
    const entries = readdirSync(captureDir);
    expect(entries).toHaveLength(1);
    const [name] = entries;
    if (name === undefined) {
      throw new Error("readdirSync returned an empty array after asserting length 1");
    }
    const filePath = path.join(captureDir, name);
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("expected the envelope file to contain a JSON object");
    }
    return { path: filePath, envelope: parsed as Record<string, unknown> };
  }

  it("always exits 0 and never writes to stdout", () => {
    const dir = makeTempDir("hookassert-record-script-");
    const captureDir = path.join(dir, "captures");
    const scriptPath = writeScript(dir, {
      captureDir,
      claudeVersionFlag: undefined,
      lastVersionFile: path.join(dir, "last-version.json"),
    });

    const result = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 and writes nothing to stdout even when stdin is not valid JSON", () => {
    const dir = makeTempDir("hookassert-record-script-invalid-");
    const captureDir = path.join(dir, "captures");
    const scriptPath = writeScript(dir, {
      captureDir,
      claudeVersionFlag: undefined,
      lastVersionFile: path.join(dir, "last-version.json"),
    });

    const result = spawnSync(process.execPath, [scriptPath], {
      input: "not json at all",
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("saves a captured payload with a capturedAt/event/claudeVersion/sourceFile envelope, shaped correctly", () => {
    const dir = makeTempDir("hookassert-record-script-envelope2-");
    const captureDir = path.join(dir, "captures");
    const scriptPath = writeScript(dir, {
      captureDir,
      claudeVersionFlag: "2.1.300",
      lastVersionFile: path.join(dir, "last-version.json"),
    });

    const result = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write" }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const { path: envelopePath, envelope } = readSoleEnvelope(captureDir);
    expect(envelope).toMatchObject({
      event: "PostToolUse",
      claudeVersion: "2.1.300",
      sourceFile: envelopePath,
      payload: { hook_event_name: "PostToolUse", tool_name: "Write" },
    });
    expect(
      typeof envelope["capturedAt"] === "string" &&
        !Number.isNaN(Date.parse(envelope["capturedAt"])),
    ).toBe(true);
  });

  it("falls back to the baked-in --claude-version flag, then undetermined, when the payload and env carry none", () => {
    const dir = makeTempDir("hookassert-record-script-fallback-");
    const captureDir = path.join(dir, "captures");
    const scriptPath = writeScript(dir, {
      captureDir,
      claudeVersionFlag: undefined,
      lastVersionFile: path.join(dir, "last-version.json"),
    });

    const result = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({ hook_event_name: "Stop" }),
      encoding: "utf8",
      env: { ...process.env, HOOKASSERT_CLAUDE_VERSION: undefined },
    });
    expect(result.status).toBe(0);

    const { envelope } = readSoleEnvelope(captureDir);
    expect(envelope).toMatchObject({ claudeVersion: "undetermined" });
  });

  it("does not write the last-recorded-version file when the version stays undetermined", () => {
    const dir = makeTempDir("hookassert-record-script-noversion-");
    const captureDir = path.join(dir, "captures");
    const lastVersionFile = path.join(dir, "last-version.json");
    const scriptPath = writeScript(dir, {
      captureDir,
      claudeVersionFlag: undefined,
      lastVersionFile,
    });

    spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({ hook_event_name: "Stop" }),
      encoding: "utf8",
    });

    expect(existsSync(lastVersionFile)).toBe(false);
  });

  it("writes the last-recorded-version file when a known version was captured", () => {
    const dir = makeTempDir("hookassert-record-script-version-");
    const captureDir = path.join(dir, "captures");
    const lastVersionFile = path.join(dir, "last-version.json");
    const scriptPath = writeScript(dir, {
      captureDir,
      claudeVersionFlag: "2.1.300",
      lastVersionFile,
    });

    spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({ hook_event_name: "Stop" }),
      encoding: "utf8",
    });

    expect(existsSync(lastVersionFile)).toBe(true);
    const parsed: unknown = JSON.parse(readFileSync(lastVersionFile, "utf8"));
    expect(parsed).toMatchObject({ claudeVersion: "2.1.300" });
  });
});

describe("startRecordSession / stopRecordSession", () => {
  function project(): string {
    return makeTempDir("hookassert-record-session-");
  }

  it("creates .claude/settings.local.json with a notice when it does not already exist", () => {
    const cwd = project();
    const info = startRecordSession({
      cwd,
      events: ["PreToolUse"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });

    expect(info.createdFresh).toBe(true);
    expect(existsSync(info.settingsFile)).toBe(true);
    const text = readFileSync(info.settingsFile, "utf8");
    expect(text).toContain("Created by `hookassert record`");
    expect(text).toContain("PreToolUse");
  });

  it("writes the capture script and inserts hooks for every requested event", () => {
    const cwd = project();
    const info = startRecordSession({
      cwd,
      events: ["PreToolUse", "Stop"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });

    expect(existsSync(info.captureScript)).toBe(true);
    expect(info.captureDir).toBe(defaultCaptureDir(cwd));
    expect(existsSync(sessionFilePath(cwd))).toBe(true);

    const settingsText = readFileSync(info.settingsFile, "utf8");
    const parsed: unknown = JSON.parse(settingsText);
    expect(parsed).toMatchObject({
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ command: `'${info.captureScript}'` }] }],
        Stop: [{ hooks: [{ command: `'${info.captureScript}'` }] }],
      },
    });
  });

  it("honors a --capture-dir override", () => {
    const cwd = project();
    const customDir = path.join(cwd, "elsewhere");
    const info = startRecordSession({
      cwd,
      events: ["PreToolUse"],
      matcherForEvent,
      captureDir: "elsewhere",
      claudeVersionFlag: undefined,
    });

    expect(info.captureDir).toBe(customDir);
    expect(existsSync(customDir)).toBe(true);
  });

  it("insert then stop restores byte-identical text to the original, for a pre-existing settings file", () => {
    const cwd = project();
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const settingsFile = path.join(cwd, ".claude", "settings.local.json");
    writeFileSync(settingsFile, EXISTING_SETTINGS_TEXT, "utf8");

    startRecordSession({
      cwd,
      events: ["PreToolUse", "Stop"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });

    // Something changed the file while recording, proving the capture hook
    // really was inserted, before it gets removed again below.
    expect(readFileSync(settingsFile, "utf8")).not.toBe(EXISTING_SETTINGS_TEXT);

    const result = stopRecordSession(cwd);
    expect(result.settingsFile).toBe(settingsFile);
    expect(readFileSync(settingsFile, "utf8")).toBe(EXISTING_SETTINGS_TEXT);
    expect(existsSync(sessionFilePath(cwd))).toBe(false);
  });

  it.each([
    [
      "an inline single-line hook group",
      '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"./guard.sh"}]}]}}\n',
    ],
    [
      "tab indentation",
      '{\n\t"permissions": {\n\t\t"allow": [\n\t\t\t"Bash(echo:*)"\n\t\t]\n\t}\n}\n',
    ],
    ["compact JSON", '{"permissions":{"allow":["Bash(echo:*)"]}}'],
    ["a bare object with just a newline inside it", "{\n}\n"],
  ])(
    "insert then stop restores byte-identical text even for %s, a non-canonical format " +
      "jsonc-parser's own insert reformats",
    (_label, original) => {
      const cwd = project();
      mkdirSync(path.join(cwd, ".claude"), { recursive: true });
      const settingsFile = path.join(cwd, ".claude", "settings.local.json");
      writeFileSync(settingsFile, original, "utf8");

      startRecordSession({
        cwd,
        events: ["PreToolUse"],
        matcherForEvent,
        captureDir: undefined,
        claudeVersionFlag: undefined,
      });

      // Something changed the file while recording, proving the capture hook
      // really was inserted, before it gets removed again below.
      expect(readFileSync(settingsFile, "utf8")).not.toBe(original);

      const result = stopRecordSession(cwd);
      expect(result.settingsFile).toBe(settingsFile);
      expect(readFileSync(settingsFile, "utf8")).toBe(original);
      expect(existsSync(sessionFilePath(cwd))).toBe(false);
    },
  );

  it("single-quotes the capture command so a project path with a space round-trips through record --stop", () => {
    const parent = makeTempDir("hookassert-record-space-");
    const cwd = path.join(parent, "My Project");
    mkdirSync(cwd, { recursive: true });
    expect(cwd).toContain(" ");

    const info = startRecordSession({
      cwd,
      events: ["PreToolUse"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });

    const settingsText = readFileSync(info.settingsFile, "utf8");
    const parsed = JSON.parse(settingsText) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    const command = parsed.hooks.PreToolUse[0]?.hooks[0]?.command;
    // Single-quoted, so /bin/sh -c sees it as one word rather than
    // word-splitting on the space in the project path.
    expect(command).toBe(`'${info.captureScript}'`);

    const result = stopRecordSession(cwd);
    expect(result.settingsFile).toBe(info.settingsFile);
    expect(existsSync(sessionFilePath(cwd))).toBe(false);
  });

  it("record --stop still restores cleanly when a hand edit only touched the capture hook's own matcher group", () => {
    const cwd = project();
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const settingsFile = path.join(cwd, ".claude", "settings.local.json");
    writeFileSync(settingsFile, EXISTING_SETTINGS_TEXT, "utf8");

    startRecordSession({
      cwd,
      events: ["PreToolUse"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });

    const postImageText = readFileSync(settingsFile, "utf8");
    // Edit only the matcher inside the capture hook's own inserted group
    // while recording is active: `removeCaptureHook` searches each group by
    // its "command", not its matcher, and still deletes the whole group
    // wholesale once a single-hook group's command matches. So this diverges
    // from what `record` itself wrote (the fast, byte-verbatim restore path
    // cannot be taken) yet still nets out to the exact pre-image once that
    // group is stripped back out — the fallback inverse-edit path's own
    // success case, not a divergence to report.
    expect(postImageText).toContain('"matcher": "*"');
    const handEdited = postImageText.replace('"matcher": "*"', '"matcher": "Edit"');
    expect(handEdited).not.toBe(postImageText);
    writeFileSync(settingsFile, handEdited, "utf8");

    const result = stopRecordSession(cwd);
    expect(result.settingsFile).toBe(settingsFile);
    expect(readFileSync(settingsFile, "utf8")).toBe(EXISTING_SETTINGS_TEXT);
    expect(existsSync(sessionFilePath(cwd))).toBe(false);
  });

  it("record --stop with no active session throws ERR_RECORD_NO_SESSION (exit 5)", () => {
    const cwd = project();

    let caught: unknown;
    try {
      stopRecordSession(cwd);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecordNoSessionError);
    expect((caught as RecordNoSessionError).code).toBe("ERR_RECORD_NO_SESSION");
    expect((caught as RecordNoSessionError).exitCode).toBe(5);
  });

  it("record --stop throws ERR_RECORD_RESTORE when the session file is not valid JSON", () => {
    const cwd = project();
    mkdirSync(hookassertDir(cwd), { recursive: true });
    writeFileSync(sessionFilePath(cwd), "not json at all", "utf8");

    let caught: unknown;
    try {
      stopRecordSession(cwd);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecordRestoreError);
    expect((caught as RecordRestoreError).code).toBe("ERR_RECORD_RESTORE");
  });

  it.each([
    ["a bare JSON string", '"just a string"'],
    ["an object missing required fields", JSON.stringify({ settingsFile: "/x" })],
  ])(
    "record --stop throws ERR_RECORD_RESTORE when the session file is %s",
    (_label, sessionContent) => {
      const cwd = project();
      mkdirSync(hookassertDir(cwd), { recursive: true });
      writeFileSync(sessionFilePath(cwd), sessionContent, "utf8");

      let caught: unknown;
      try {
        stopRecordSession(cwd);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RecordRestoreError);
      expect((caught as RecordRestoreError).code).toBe("ERR_RECORD_RESTORE");
    },
  );

  it("record --stop reports the divergence when the settings file was deleted entirely while recording", () => {
    const cwd = project();
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const settingsFile = path.join(cwd, ".claude", "settings.local.json");
    writeFileSync(settingsFile, EXISTING_SETTINGS_TEXT, "utf8");

    startRecordSession({
      cwd,
      events: ["PreToolUse"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });

    // The user deletes the settings file entirely while recording is active.
    rmSync(settingsFile);

    let caught: unknown;
    try {
      stopRecordSession(cwd);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecordRestoreError);
    expect((caught as RecordRestoreError).code).toBe("ERR_RECORD_RESTORE");
  });

  it(
    "record --stop after the user manually edited the settings file applies only the " +
      "inverse edit and reports the divergence, without discarding the user's edit",
    () => {
      const cwd = project();
      mkdirSync(path.join(cwd, ".claude"), { recursive: true });
      const settingsFile = path.join(cwd, ".claude", "settings.local.json");
      writeFileSync(settingsFile, EXISTING_SETTINGS_TEXT, "utf8");

      const info = startRecordSession({
        cwd,
        events: ["PreToolUse"],
        matcherForEvent,
        captureDir: undefined,
        claudeVersionFlag: undefined,
      });

      // The user edits the file by hand while recording is active: they add
      // an unrelated permission entry.
      const duringRecording = readFileSync(settingsFile, "utf8");
      const userEdited = duringRecording.replace(
        '"allow": ["Bash(echo:*)"]',
        '"allow": ["Bash(echo:*)", "Bash(ls:*)"]',
      );
      expect(userEdited).not.toBe(duringRecording);
      writeFileSync(settingsFile, userEdited, "utf8");

      let caught: unknown;
      try {
        stopRecordSession(cwd);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RecordRestoreError);
      expect((caught as RecordRestoreError).code).toBe("ERR_RECORD_RESTORE");
      expect((caught as RecordRestoreError).exitCode).toBe(5);

      const finalText = readFileSync(settingsFile, "utf8");
      // The capture hook was removed (the inverse edit was applied)...
      expect(finalText).not.toContain(info.captureScript);
      // ...but the user's own edit is preserved, not silently discarded.
      expect(finalText).toContain("Bash(ls:*)");
      // The session is over even though it diverged.
      expect(existsSync(sessionFilePath(cwd))).toBe(false);
    },
  );

  it("refuses to start a second session on top of an already-active one", () => {
    const cwd = project();
    startRecordSession({
      cwd,
      events: ["PreToolUse"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });

    // The settings file already declares the capture-hook command from the
    // first start, so a second start (even below src/cli.ts's own
    // isRecordSessionActive guard) must refuse rather than insert a
    // duplicate matcher group next to the first one's still-active leftovers.
    let caught: unknown;
    try {
      startRecordSession({
        cwd,
        events: ["PreToolUse"],
        matcherForEvent,
        captureDir: undefined,
        claudeVersionFlag: undefined,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).code).toBe("ERR_USAGE");
    // The first session's own bookkeeping is untouched by the refused retry.
    expect(existsSync(sessionFilePath(cwd))).toBe(true);
  });

  it("refuses to start when the settings file already declares the capture-hook command but no session file exists", () => {
    // Simulates a previous `record` run that failed between writing the
    // settings file and finalizing its own session bookkeeping: an orphaned
    // capture hook with nothing tracking it.
    const cwd = project();
    const started = startRecordSession({
      cwd,
      events: ["PreToolUse"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });
    rmSync(sessionFilePath(cwd));
    expect(isRecordSessionActive(cwd)).toBe(false);

    let caught: unknown;
    try {
      startRecordSession({
        cwd,
        events: ["PreToolUse"],
        matcherForEvent,
        captureDir: undefined,
        claudeVersionFlag: undefined,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).code).toBe("ERR_USAGE");
    expect((caught as UsageError).message).toContain(started.captureScript);
  });

  it("leaves no temporary session file behind after a successful start", () => {
    const cwd = project();
    startRecordSession({
      cwd,
      events: ["PreToolUse"],
      matcherForEvent,
      captureDir: undefined,
      claudeVersionFlag: undefined,
    });

    const sessionFileBasename = path.basename(sessionFilePath(cwd));
    const leftovers = readdirSync(hookassertDir(cwd)).filter((name) =>
      name.startsWith(`${sessionFileBasename}.tmp-`),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("hookassertDir / readLastRecordedClaudeVersion", () => {
  it("hookassertDir is a project-local directory, never inside .claude/", () => {
    const cwd = "/some/project";
    expect(hookassertDir(cwd)).toBe(path.join(cwd, ".hookassert"));
  });

  it("readLastRecordedClaudeVersion returns undefined when nothing has been recorded yet", () => {
    const cwd = makeTempDir("hookassert-record-lastversion-");
    expect(readLastRecordedClaudeVersion(cwd)).toBeUndefined();
  });

  it("readLastRecordedClaudeVersion reads back what the capture script wrote", () => {
    const cwd = makeTempDir("hookassert-record-lastversion-written-");
    mkdirSync(hookassertDir(cwd), { recursive: true });
    writeFileSync(
      lastRecordedClaudeVersionPath(cwd),
      JSON.stringify({
        claudeVersion: "2.1.300",
        capturedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    expect(readLastRecordedClaudeVersion(cwd)).toBe("2.1.300");
  });

  it("readLastRecordedClaudeVersion returns undefined for a malformed file", () => {
    const cwd = makeTempDir("hookassert-record-lastversion-malformed-");
    mkdirSync(hookassertDir(cwd), { recursive: true });
    writeFileSync(lastRecordedClaudeVersionPath(cwd), "not json", "utf8");
    expect(readLastRecordedClaudeVersion(cwd)).toBeUndefined();
  });

  it("readLastRecordedClaudeVersion returns undefined when claudeVersion is present but not a string", () => {
    const cwd = makeTempDir("hookassert-record-lastversion-wrongtype-");
    mkdirSync(hookassertDir(cwd), { recursive: true });
    writeFileSync(
      lastRecordedClaudeVersionPath(cwd),
      JSON.stringify({ claudeVersion: 123 }),
      "utf8",
    );
    expect(readLastRecordedClaudeVersion(cwd)).toBeUndefined();
  });
});

describe("readTextOrUndefined's non-ENOENT propagation", () => {
  it("record --stop propagates a non-ENOENT read failure rather than treating it as no active session", () => {
    const cwd = makeTempDir("hookassert-record-eisdir-");
    // A directory where the session file would be makes readFileSync fail
    // with EISDIR, not ENOENT — that must not be swallowed the way a
    // genuinely missing session file is.
    mkdirSync(sessionFilePath(cwd), { recursive: true });

    expect(() => stopRecordSession(cwd)).toThrow();
  });
});
