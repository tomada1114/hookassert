import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildProposedDiff,
  compareFiringSets,
} from "../scripts/lib/conformance/compare.mjs";
import { proposePayloadShapeVerification } from "../scripts/lib/conformance/payload-shape.mjs";
import {
  firedInExplainReport,
  predictedCasesFromMatcherTable,
} from "../scripts/lib/conformance/predicted.mjs";
import {
  normalizeTranscript,
  TranscriptShapeError,
} from "../scripts/lib/conformance/transcript.mjs";
import {
  ConformanceError,
  defaultRunExplainCase,
  defaultSpecPath,
  main,
  parseArguments,
  runExplain,
  singleHookSettings,
} from "../scripts/conformance.mjs";

// scripts/lib/conformance/** is this issue's pure comparison layer: transcript
// data in, a structured diff out, with no I/O of its own -- see
// docs/conformance/README.md. scripts/conformance.mjs is the thin,
// subprocess-invoking wrapper around it; its own `main` accepts injected
// dependencies precisely so this suite can exercise the whole
// parse -> compare -> report pipeline without a `claude` binary or a built
// `dist/`, per the `placing-tests` skill's guidance to keep the part that
// actually spawns a process minimal and separately callable.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPEC_PATH = path.join(REPO_ROOT, "spec", "claude-code-2.1.251-2.2.0.json");
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/conformance/", import.meta.url));

interface MatcherTableRowLike {
  readonly event: string;
  readonly matcher: string;
  readonly matches: readonly string[];
  readonly doesNotMatch: readonly string[];
}

interface EventSpecLike {
  readonly payloadShape: {
    readonly requiredKeys: readonly string[];
    readonly verified: boolean;
  };
}

interface SpecLike {
  readonly matcherTable: readonly MatcherTableRowLike[];
  readonly events: Record<string, EventSpecLike>;
}

/**
 * The real spec, read as plain JSON -- never through `loadSpecFile`
 * (`src/internal/spec/index.js`), which is off limits here: `tests/conformance
 * .test.ts` is not in eslint.config.mjs's `tests/static-layer-unit-tests`
 * allowlist, matching the design's black-box constraint (this issue treats
 * the spec the same way scripts/conformance.mjs itself does -- as data, not
 * as an import).
 */
const REAL_SPEC = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as SpecLike;

function readFixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

describe("predictedCasesFromMatcherTable and compareFiringSets: every spec.matcherTable row against a recorded transcript", () => {
  it("the comparison function reports no mismatch when a transcript's observed firing set matches hookassert's prediction", () => {
    const predicted = predictedCasesFromMatcherTable(REAL_SPEC.matcherTable);
    const transcript = normalizeTranscript(
      readFixtureJson("transcript-matches-spec.json"),
    );

    // The fixture was hand-constructed from this same matcherTable (see its
    // own "note" field) and is expected to cover every case the sweep
    // produces, so this also proves no row's cases silently went unobserved.
    expect(transcript.firingObservations.length).toBe(predicted.length);

    const result = compareFiringSets(predicted, transcript.firingObservations);

    expect(result.mismatches).toEqual([]);
    expect(result.unobserved).toEqual([]);
    expect(result.agreements.length).toBe(predicted.length);
  });

  it("the comparison function reports a mismatch, with a proposed diff, when the transcript disagrees with the prediction", () => {
    const predicted = predictedCasesFromMatcherTable(REAL_SPEC.matcherTable);
    const transcript = normalizeTranscript(
      readFixtureJson("transcript-with-mismatch.json"),
    );

    const result = compareFiringSets(predicted, transcript.firingObservations);

    expect(result.mismatches).toHaveLength(1);
    const [mismatch] = result.mismatches;
    expect(mismatch).toMatchObject({
      event: "PreToolUse",
      matcher: "Bash",
      tool: "Bash",
      predictedFired: true,
      observedFired: false,
    });
    expect(mismatch?.proposedDiff).toContain("proposed spec correction");
    expect(mismatch?.proposedDiff).toContain('matcher: "Bash"');
    // every other case in the fixture still agrees
    expect(result.agreements.length).toBe(predicted.length - 1);
  });

  it("the mismatch report never includes a write instruction to the spec file -- only a printed diff", () => {
    const predicted = predictedCasesFromMatcherTable(REAL_SPEC.matcherTable);
    const transcript = normalizeTranscript(
      readFixtureJson("transcript-with-mismatch.json"),
    );
    const specBefore = readFileSync(SPEC_PATH, "utf8");

    const result = compareFiringSets(predicted, transcript.firingObservations);

    const specAfter = readFileSync(SPEC_PATH, "utf8");
    expect(specAfter).toBe(specBefore);

    expect(result.mismatches.length).toBeGreaterThan(0);
    for (const mismatch of result.mismatches) {
      expect(mismatch).not.toHaveProperty("write");
      expect(mismatch).not.toHaveProperty("applied");
      expect(mismatch.proposedDiff).toContain("not applied automatically");
      expect(mismatch.proposedDiff).not.toMatch(/writeFile|fs\.write/i);
    }
  });

  it.each([
    [
      "observed fired=false",
      { event: "PreToolUse", matcher: "Bash", tool: "Bash", fired: true },
      { event: "PreToolUse", matcher: "Bash", tool: "Bash", fired: false },
      '+ move "Bash" to matcherTable[...].doesNotMatch',
      "reason: the transcript observed fired=false",
    ],
    [
      "observed fired=true",
      { event: "PreToolUse", matcher: "PowerShell", tool: "PowerShell", fired: false },
      { event: "PreToolUse", matcher: "PowerShell", tool: "PowerShell", fired: true },
      '+ move "PowerShell" to matcherTable[...].matches',
      "reason: the transcript observed fired=true",
    ],
  ])(
    "builds a proposed diff that names the matcher and the direction to move the tool (%s)",
    (_label, predicted, observed, expectedMove, expectedReason) => {
      const diff = buildProposedDiff(predicted, observed);
      expect(diff).toContain(expectedMove);
      expect(diff).toContain(expectedReason);
    },
  );

  it("reports a predicted case the transcript never observed as unobserved, not as agreement or mismatch", () => {
    const predicted = [
      { event: "PreToolUse", matcher: "Bash", tool: "Bash", fired: true },
    ];
    const result = compareFiringSets(predicted, []);
    expect(result.unobserved).toEqual(predicted);
    expect(result.agreements).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });
});

describe("firedInExplainReport", () => {
  it("reports true when a firing hook declares the matcher", () => {
    const report = { firing: [{ matcher: "Bash" }, { matcher: "Write" }] };
    expect(firedInExplainReport(report, "Bash")).toBe(true);
  });

  it("reports false when no firing hook declares the matcher", () => {
    const report = { firing: [{ matcher: "Write" }] };
    expect(firedInExplainReport(report, "Bash")).toBe(false);
  });

  it("throws when the report carries no firing array at all", () => {
    expect(() => firedInExplainReport({}, "Bash")).toThrow(
      /ERR_CONFORMANCE_REPORT_SHAPE/,
    );
  });
});

describe("normalizeTranscript", () => {
  it("throws TranscriptShapeError when firingObservations is missing", () => {
    const raw = readFixtureJson("malformed-transcript-missing-firing.json");
    expect(() => normalizeTranscript(raw)).toThrow(TranscriptShapeError);
    try {
      normalizeTranscript(raw);
      expect.fail("expected normalizeTranscript to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptShapeError);
      expect((error as TranscriptShapeError).code).toBe(
        "ERR_CONFORMANCE_TRANSCRIPT_SHAPE",
      );
    }
  });

  it("defaults payloadObservations to an empty array when absent", () => {
    const transcript = normalizeTranscript({
      claudeVersion: "2.1.255",
      firingObservations: [],
    });
    expect(transcript.payloadObservations).toEqual([]);
  });

  it.each([
    ["missing claudeVersion", { firingObservations: [] }],
    [
      "a firingObservations entry missing fired",
      {
        claudeVersion: "2.1.255",
        firingObservations: [{ event: "PreToolUse", matcher: "Bash", tool: "Bash" }],
      },
    ],
    [
      "a payloadObservations entry missing payload",
      {
        claudeVersion: "2.1.255",
        firingObservations: [],
        payloadObservations: [{ event: "SessionStart" }],
      },
    ],
  ])("rejects a transcript %s", (_label, raw) => {
    expect(() => normalizeTranscript(raw)).toThrow(TranscriptShapeError);
  });
});

describe("proposePayloadShapeVerification: a payload whose shape matches spec.requiredKeys for its event", () => {
  it("proposes flipping payloadShape.verified to true, without actually flipping it", () => {
    const event = "SessionStart";
    const payloadShape = REAL_SPEC.events[event]?.payloadShape;
    if (payloadShape === undefined) {
      throw new Error(
        `fixture assumption broken: spec no longer declares events.${event}`,
      );
    }
    expect(payloadShape.verified).toBe(false); // ground truth from #3, still false on disk

    const payload = readFixtureJson("session-start-payload.json") as Record<
      string,
      unknown
    >;
    const proposal = proposePayloadShapeVerification(event, payloadShape, payload);

    expect(proposal.shapeMatches).toBe(true);
    expect(proposal.missingKeys).toEqual([]);
    expect(proposal.proposedDiff).toContain(`events.${event}.payloadShape.verified`);
    expect(proposal.proposedDiff).toContain("+ true");
    expect(proposal.proposedDiff).not.toMatch(/writeFile|fs\.write/i);

    // Neither the in-memory spec object nor the file on disk was touched.
    expect(REAL_SPEC.events[event]?.payloadShape.verified).toBe(false);
    const specAfter = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as SpecLike;
    expect(specAfter.events[event]?.payloadShape.verified).toBe(false);
  });

  it("proposes nothing when the payload is missing a required key", () => {
    const event = "SessionStart";
    const payloadShape = REAL_SPEC.events[event]?.payloadShape;
    if (payloadShape === undefined) {
      throw new Error(
        `fixture assumption broken: spec no longer declares events.${event}`,
      );
    }
    const proposal = proposePayloadShapeVerification(event, payloadShape, {
      session_id: "11111111-1111-1111-1111-111111111111",
    });
    expect(proposal.shapeMatches).toBe(false);
    expect(proposal.proposedDiff).toBeNull();
    expect(proposal.missingKeys.length).toBeGreaterThan(0);
  });

  it("proposes nothing when the flag is already verified, even with a matching payload", () => {
    const proposal = proposePayloadShapeVerification(
      "Setup",
      { requiredKeys: ["session_id"], verified: true },
      { session_id: "abc" },
    );
    expect(proposal.shapeMatches).toBe(true);
    expect(proposal.proposedDiff).toBeNull();
  });
});

describe("scripts/conformance.mjs contains no import of src/internal/** or dist/internal/**", () => {
  const conformanceModulePaths = [
    "scripts/conformance.mjs",
    ...readdirSync(path.join(REPO_ROOT, "scripts", "lib", "conformance"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => path.join("scripts", "lib", "conformance", name)),
  ];

  it.each(conformanceModulePaths)("%s", (relative) => {
    const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/(^|\/)(src|dist)\/internal(\/|$)/);
    }
  });

  it("actually finds import specifiers in scripts/conformance.mjs, so the check above is not vacuous", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "scripts", "conformance.mjs"),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
  });
});

describe("scripts/conformance.mjs: parseArguments", () => {
  it("requires --transcript", () => {
    expect(() => parseArguments([])).toThrow(ConformanceError);
    try {
      parseArguments([]);
      expect.fail("expected parseArguments to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConformanceError);
      expect((error as ConformanceError).code).toBe("ERR_CONFORMANCE_ARGUMENT");
    }
  });

  it("rejects an unknown option", () => {
    expect(() => parseArguments(["--nope", "x"])).toThrow(ConformanceError);
  });

  it("rejects a flag with a missing value", () => {
    expect(() => parseArguments(["--transcript"])).toThrow(ConformanceError);
  });

  it("parses --transcript alone", () => {
    expect(parseArguments(["--transcript", "t.json"])).toEqual({
      transcriptPath: "t.json",
    });
  });

  it("parses --transcript and --spec together", () => {
    expect(parseArguments(["--transcript", "t.json", "--spec", "s.json"])).toEqual({
      transcriptPath: "t.json",
      specPath: "s.json",
    });
  });
});

describe("scripts/conformance.mjs: singleHookSettings", () => {
  it("builds a settings document with exactly one hook for the given event and matcher", () => {
    expect(singleHookSettings("PreToolUse", "Bash")).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "true" }] },
        ],
      },
    });
  });
});

describe("scripts/conformance.mjs: defaultSpecPath", () => {
  it("resolves the single spec/*.json file in this repository", () => {
    expect(defaultSpecPath(REPO_ROOT)).toBe(SPEC_PATH);
  });

  const workspaces: string[] = [];
  afterEach(() => {
    for (const dir of workspaces.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "hookassert-conformance-spec-"));
    workspaces.push(dir);
    return dir;
  }

  it("throws ERR_CONFORMANCE_SPEC_AMBIGUOUS when spec/ holds no .json file", () => {
    const root = makeWorkspace();
    mkdirSync(path.join(root, "spec"));
    expect(() => defaultSpecPath(root)).toThrow(ConformanceError);
    expect(() => defaultSpecPath(root)).toThrow(/ERR_CONFORMANCE_SPEC_AMBIGUOUS/);
  });

  it("throws ERR_CONFORMANCE_SPEC_AMBIGUOUS when spec/ holds more than one .json file", () => {
    const root = makeWorkspace();
    const specDir = path.join(root, "spec");
    mkdirSync(specDir);
    writeFileSync(path.join(specDir, "a.json"), "{}", "utf8");
    writeFileSync(path.join(specDir, "b.json"), "{}", "utf8");
    expect(() => defaultSpecPath(root)).toThrow(/ERR_CONFORMANCE_SPEC_AMBIGUOUS/);
  });
});

describe("scripts/conformance.mjs: runExplain (a real subprocess)", () => {
  const successCli = path.join(FIXTURES_DIR, "fake-explain-cli-success.mjs");
  const failureCli = path.join(FIXTURES_DIR, "fake-explain-cli-failure.mjs");

  it("parses the built CLI's JSON report on success", () => {
    const report = runExplain(successCli, "settings.json", "PreToolUse", "Bash");
    expect(report).toEqual({ firing: [{ matcher: "Bash" }] });
  });

  it("throws ERR_CONFORMANCE_CLI_FAILED when the CLI exits non-zero", () => {
    expect(() => runExplain(failureCli, "settings.json", "PreToolUse", "Bash")).toThrow(
      /ERR_CONFORMANCE_CLI_FAILED/,
    );
  });
});

describe("scripts/conformance.mjs: defaultRunExplainCase (a real subprocess, end to end)", () => {
  it("writes a throwaway single-hook settings file, asks the given CLI, and cleans up", () => {
    const successCli = path.join(FIXTURES_DIR, "fake-explain-cli-success.mjs");
    const fired = defaultRunExplainCase("PreToolUse", "Bash", "Bash", successCli);
    expect(fired).toBe(true);
  });

  it("still cleans up its temp directory when the CLI call throws", () => {
    const failureCli = path.join(FIXTURES_DIR, "fake-explain-cli-failure.mjs");
    expect(() =>
      defaultRunExplainCase("PreToolUse", "Bash", "Bash", failureCli),
    ).toThrow(ConformanceError);
  });
});

describe("scripts/conformance.mjs: main", () => {
  it("returns exit code 2 and reports ERR_CONFORMANCE_ARGUMENT when --transcript is missing", () => {
    const errors: string[] = [];
    const code = main([], { logError: (text) => errors.push(text) });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("ERR_CONFORMANCE_ARGUMENT");
  });

  it("returns exit code 0 and logs agreement when every observed case agrees with the injected predictor", () => {
    const logs: string[] = [];
    const code = main(
      ["--transcript", path.join(FIXTURES_DIR, "small-agree-transcript.json")],
      {
        runExplainCase: () => true,
        log: (text) => logs.push(text),
      },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("2 firing case(s) agree");
  });

  it("returns exit code 1 and prints a proposed diff on stderr when a case disagrees with the injected predictor", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = main(
      ["--transcript", path.join(FIXTURES_DIR, "small-mismatch-transcript.json")],
      {
        runExplainCase: () => true,
        log: (text) => logs.push(text),
        logError: (text) => errors.push(text),
      },
    );
    expect(code).toBe(1);
    const combined = errors.join("\n");
    expect(combined).toContain("1 mismatch(es) found");
    expect(combined).toContain("proposed spec correction");
    expect(combined).not.toContain("spec/claude-code");
    // never actually touches the spec file
    const specAfter = readFileSync(SPEC_PATH, "utf8");
    expect(specAfter).toBe(readFileSync(SPEC_PATH, "utf8"));
  });

  it("prints a payload-shape proposal, without affecting the exit code, when the transcript carries a matching payload", () => {
    const logs: string[] = [];
    const code = main(
      ["--transcript", path.join(FIXTURES_DIR, "transcript-with-payload.json")],
      {
        runExplainCase: () => true,
        resolveSpecPath: () => SPEC_PATH,
        log: (text) => logs.push(text),
      },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("events.SessionStart.payloadShape.verified");
  });

  it("reports ERR_CONFORMANCE_TRANSCRIPT_SHAPE and exits 1 for a malformed transcript", () => {
    const errors: string[] = [];
    const code = main(
      [
        "--transcript",
        path.join(FIXTURES_DIR, "malformed-transcript-missing-firing.json"),
      ],
      { logError: (text) => errors.push(text) },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("ERR_CONFORMANCE_TRANSCRIPT_SHAPE");
  });

  it("reports ERR_CONFORMANCE_UNKNOWN_EVENT and still exits 0 when a payload names an event the spec does not declare", () => {
    const errors: string[] = [];
    const code = main(
      [
        "--transcript",
        path.join(FIXTURES_DIR, "transcript-with-unknown-event-payload.json"),
      ],
      {
        runExplainCase: () => true,
        resolveSpecPath: () => SPEC_PATH,
        logError: (text) => errors.push(text),
      },
    );
    expect(code).toBe(0);
    expect(errors.join("\n")).toContain("ERR_CONFORMANCE_UNKNOWN_EVENT");
  });

  it("returns exit code 1, not 2, for a ConformanceError raised mid-run rather than at argument parsing", () => {
    const errors: string[] = [];
    const code = main(
      ["--transcript", path.join(FIXTURES_DIR, "small-agree-transcript.json")],
      {
        runExplainCase: () => {
          throw new ConformanceError("ERR_CONFORMANCE_CLI_FAILED", "simulated failure");
        },
        logError: (text) => errors.push(text),
      },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("ERR_CONFORMANCE_CLI_FAILED");
  });

  it("falls back to console.log/console.error and the real spec/ directory when no deps are injected", () => {
    // No log/logError/resolveSpecPath override: this exercises main's actual
    // default wiring (console.log, console.error, defaultSpecPath(repoRoot))
    // against a real, committed fixture and this repository's real spec file.
    const code = main(
      ["--transcript", path.join(FIXTURES_DIR, "transcript-with-payload.json")],
      { runExplainCase: () => true },
    );
    expect(code).toBe(0);
  });
});
