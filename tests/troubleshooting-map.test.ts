import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LINT_RULES } from "../src/internal/lint/index.js";

const DOC_PATH = fileURLToPath(
  new URL("../docs/troubleshooting-map.md", import.meta.url),
);

/**
 * A rule id "looks like" an inline-code span containing only lowercase
 * letters, digits, and at least one hyphen — `command-not-found`, not
 * `command` or `PostToolUse`. The hyphen requirement is what keeps this from
 * also matching an ordinary single-word inline-code span (`` `command` ``,
 * `` `lint` ``) that the map uses for plain prose, which would otherwise be
 * misread as a (nonexistent) one-word rule id and fail the "exists in the
 * registry" check for a reason that has nothing to do with an actual drift
 * between the map and the registry.
 */
const RULE_ID_LIKE = /`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g;

function ruleIdsReferencedIn(text: string): readonly string[] {
  return [...text.matchAll(RULE_ID_LIKE)].map((match) => {
    const [, id] = match;
    if (id === undefined) {
      throw new Error(
        "RULE_ID_LIKE matched with no capture group — pattern is out of sync",
      );
    }
    return id;
  });
}

describe("docs/troubleshooting-map.md", () => {
  const text = readFileSync(DOC_PATH, "utf8");
  const registryIds = new Set(LINT_RULES.map((rule) => rule.id));

  it("references at least one rule id, so the map is not silently empty", () => {
    expect(ruleIdsReferencedIn(text).length).toBeGreaterThan(0);
  });

  it("every rule id referenced in docs/troubleshooting-map.md exists in the lint rule registry", () => {
    // This is the test the issue's own close condition names: the map and
    // src/internal/lint/registry.ts must never silently drift apart. Checked
    // one-directional (map -> registry) only: not every registered rule
    // corresponds to a symptom the official docs name on their own — the
    // map's own "How to read this table" section explains why the reverse
    // direction would force either an invented symptom row or a rule id
    // present only to satisfy this test, neither of which documents
    // anything real.
    const referenced = ruleIdsReferencedIn(text);
    const unknown = referenced.filter((id) => !registryIds.has(id));
    expect(unknown).toEqual([]);
  });

  it("references every command/exit-code rule this issue ships", () => {
    const referenced = new Set(ruleIdsReferencedIn(text));
    const commandRuleIds = [
      "command-not-found",
      "missing-shebang",
      "not-executable",
      "unquoted-var",
      "exit-1-policy",
      "exit-2-overrides-allow",
    ] as const;
    for (const id of commandRuleIds) {
      expect(referenced.has(id)).toBe(true);
    }
  });

  it("states the fetch date and the same structural-guidance caveat the spec file's own transcription carries", () => {
    // Whitespace-normalized: Prettier's prose wrap is free to break the
    // caveat sentence across lines, and this check should survive that
    // reflow rather than depending on exactly where the line breaks fall.
    const normalized = text.replace(/\s+/g, " ");
    expect(text).toContain("Fetched:");
    expect(normalized).toContain("structural guidance, not verified content");
  });

  it("documents that the map -> registry check is one-directional, and why", () => {
    expect(text).toContain("one-directional");
  });
});
