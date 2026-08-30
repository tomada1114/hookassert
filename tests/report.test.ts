import { describe, expect, it } from "vitest";

import type { MatcherOutcome } from "../src/internal/matcher/index.js";
import { buildReportHeader, renderPretty } from "../src/internal/report/index.js";
import type { ExplainReport } from "../src/internal/report/index.js";
import type { Provenance, ResolvedHook } from "../src/types.js";

// Reaching src/internal/report/ and src/internal/matcher/ directly (rather
// than through src/index.ts's exports, per the writing-tests skill) is a
// deliberate, narrowly scoped exception: neither module has a public surface
// in this issue and never will one for its own plumbing types — see
// eslint.config.mjs's "tests/static-layer-unit-tests" block for the full
// reasoning.

function makeProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    file: "/abs/project/.claude/settings.json",
    layer: "project",
    line: 7,
    col: 11,
    offset: 100,
    ...overrides,
  };
}

function makeHook(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return {
    event: "PreToolUse",
    matcher: "Bash",
    command: "./scripts/guard.sh",
    args: undefined,
    timeoutMs: undefined,
    provenance: makeProvenance(),
    dedupeKey: '["PreToolUse","Bash","./scripts/guard.sh"]',
    ...overrides,
  };
}

describe("buildReportHeader", () => {
  it("formats a known Claude Code version as major.minor.patch", () => {
    const header = buildReportHeader(
      { kind: "known", version: { major: 2, minor: 1, patch: 300 } },
      ">=2.1.251 <2.2.0",
    );

    expect(header.claudeVersion).toBe("2.1.300");
    expect(header.specRange).toBe(">=2.1.251 <2.2.0");
    expect(header.notices).toEqual([]);
  });

  it("formats an undetermined version as the literal string 'undetermined'", () => {
    const header = buildReportHeader({ kind: "undetermined" }, ">=2.1.251 <2.2.0");

    expect(header.claudeVersion).toBe("undetermined");
  });
});

describe("renderPretty", () => {
  function baseReport(overrides: Partial<ExplainReport> = {}): ExplainReport {
    return {
      header: buildReportHeader({ kind: "undetermined" }, ">=2.1.251 <2.2.0"),
      event: "PreToolUse",
      target: "Bash",
      firing: [],
      matcherIgnored: [],
      rejected: [],
      ...overrides,
    };
  }

  it("prints firing hooks with layer, absolute file path, and line", () => {
    const hook = makeHook();
    const output = renderPretty(baseReport({ firing: [hook] }));

    expect(output).toContain("[project]");
    expect(output).toContain("/abs/project/.claude/settings.json:7");
    expect(output).toContain("./scripts/guard.sh");
  });

  it("prints the header even when there are zero firing or rejected cases", () => {
    const output = renderPretty(
      baseReport({
        header: buildReportHeader(
          { kind: "known", version: { major: 2, minor: 1, patch: 300 } },
          ">=2.1.251 <2.2.0",
        ),
      }),
    );

    expect(output).toContain("Claude Code version: 2.1.300");
    expect(output).toContain("Spec range: >=2.1.251 <2.2.0");
    expect(output).toContain("Firing hooks: none");
    expect(output).toContain("Not firing: none");
  });

  it("prints a rejected matcher's reason", () => {
    const outcome: MatcherOutcome = {
      hook: makeHook({ matcher: "Write", command: "./scripts/write-guard.sh" }),
      kind: "exact-list",
      reason: "evaluated as an exact-match list and did not match Bash",
    };

    const output = renderPretty(baseReport({ rejected: [outcome] }));

    expect(output).toContain("./scripts/write-guard.sh");
    expect(output).toContain("evaluated as an exact-match list and did not match Bash");
  });

  it("notes when a firing hook's matcher was ignored", () => {
    const hook = makeHook({ matcher: "anything" });
    const output = renderPretty(baseReport({ firing: [hook], matcherIgnored: [hook] }));

    expect(output).toContain("matcher ignored");
  });

  it("prints the event alone when no target was given", () => {
    const output = renderPretty(baseReport({ target: undefined }));

    expect(output).toContain("PreToolUse");
    expect(output).not.toContain("PreToolUse Bash");
  });
});
