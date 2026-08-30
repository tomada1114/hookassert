import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// A malformed skill is the one failure no other gate can see. `pnpm
// agents:check` compares two trees byte-for-byte, Prettier formats the file
// and `typos` spell-checks it, so a SKILL.md whose `name` disagrees with its
// directory — or whose frontmatter does not parse at all — mirrors cleanly,
// passes every check, and simply never loads in Claude Code or Codex CLI.
// Nothing reports it; the skill is just silently absent.
//
// The frontmatter this repository writes is deliberately small (two keys, one
// of them a folded block scalar), so it is parsed here rather than by adding a
// YAML dependency for a file format the repository itself controls.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDirectory = path.join(repoRoot, ".agents", "skills");
const agentsMdPath = path.join(repoRoot, "AGENTS.md");

/**
 * The frontmatter keys a skill in this repository may declare. Claude Code
 * accepts a wider set and Codex CLI documents only these two, so the
 * intersection is what both hosts are guaranteed to honour.
 */
const ALLOWED_KEYS = ["name", "description"] as const;

/**
 * Selection is on the description's meaning, not on literal token match, so a
 * description carrying trigger keywords in a second language buys nothing and
 * contradicts the repository's English-only convention. CJK is the script that
 * would actually appear here.
 */
const NON_ENGLISH_SCRIPT = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/u;

/** Long enough for two sentences; short enough to survive host truncation. */
const DESCRIPTION_LIMIT = 600;

function listSkillNames(): string[] {
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Parse the frontmatter block of a SKILL.md into its declared keys.
 *
 * Supports the two forms this repository uses: a plain `key: value` scalar and
 * a folded block scalar (`key: >`) whose continuation lines are indented.
 *
 * @param {string} source - The full contents of a SKILL.md file.
 * @returns {Record<string, string>} Every key declared in the frontmatter.
 * @throws {Error} When the file has no delimited frontmatter block, a line
 *   inside it is neither a key nor a continuation, a key is declared more than
 *   once, or a plain scalar value contains an unquoted ": ".
 */
function parseFrontmatter(source: string): Record<string, string> {
  const lines = source.split("\n");
  if (lines[0] !== "---") {
    throw new Error("SKILL.md does not open with a `---` frontmatter delimiter");
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error("SKILL.md frontmatter is never closed by a `---` delimiter");
  }

  const fields: Record<string, string> = {};
  let currentKey: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const keyed = /^([A-Za-z][\w-]*):[ \t]*(.*)$/u.exec(line);
    if (keyed) {
      const [, key = "", rawValue = ""] = keyed;
      if (key in fields) {
        throw new Error(`frontmatter declares "${key}" more than once`);
      }
      currentKey = key;
      // `>` and `>-` open a folded block; the value is on the lines below.
      if (rawValue === ">" || rawValue === ">-") {
        fields[key] = "";
        continue;
      }
      // An unquoted "key: value" plain scalar whose value itself contains
      // ": " is not valid YAML — a real parser reads the second colon as
      // nesting a mapping inside the value and rejects the line. Every skill
      // in this repository writes its description as a folded block scalar
      // for exactly this reason: a plain scalar that happened to work here
      // still breaks Codex CLI's real YAML loader (openai/codex#8609).
      if (/:[ \t]/u.test(rawValue)) {
        throw new Error(
          `frontmatter value for "${key}" is a plain scalar containing an unquoted ": ", which is not valid YAML: ${line}`,
        );
      }
      fields[key] = rawValue.trim();
      continue;
    }
    if (currentKey === undefined || !line.startsWith(" ")) {
      throw new Error(`frontmatter line is neither a key nor a continuation: ${line}`);
    }
    const folded = fields[currentKey] ?? "";
    fields[currentKey] = folded === "" ? line.trim() : `${folded} ${line.trim()}`;
  }
  return fields;
}

/**
 * Extract the skill names named by AGENTS.md's "## Skills" routing table.
 *
 * The table's first column holds a backticked skill name; every other cell,
 * and the row's surrounding prose, is free to change without affecting this
 * parse — only the backticked names in that section are read.
 *
 * @param {string} source - The full contents of AGENTS.md.
 * @returns {string[]} Every backticked name in the first column of a row
 *   under the "## Skills" heading, in document order.
 * @throws {Error} When AGENTS.md has no `## Skills` heading.
 */
function listRoutingTableSkillNames(source: string): string[] {
  const lines = source.split("\n");
  const headingIndex = lines.indexOf("## Skills");
  if (headingIndex === -1) {
    throw new Error('AGENTS.md has no "## Skills" heading');
  }
  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && /^##[ \t]/u.test(line),
  );
  const section = lines.slice(
    headingIndex + 1,
    nextHeadingIndex === -1 ? undefined : nextHeadingIndex,
  );

  const names: string[] = [];
  for (const line of section) {
    const row = /^\|\s*`([^`]+)`\s*\|/u.exec(line);
    if (row) names.push(row[1] ?? "");
  }
  return names;
}

function readSkill(name: string): Record<string, string> {
  return parseFrontmatter(
    readFileSync(path.join(skillsDirectory, name, "SKILL.md"), "utf8"),
  );
}

/** Every path under a skill directory, relative to that directory. */
function listSkillFiles(name: string): string[] {
  const root = path.join(skillsDirectory, name);
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(path.relative(root, absolute));
    }
  };
  walk(root);
  return found;
}

const skillNames = listSkillNames();
const routingTableSkillNames = listRoutingTableSkillNames(
  readFileSync(agentsMdPath, "utf8"),
);

describe("the authored skill tree", () => {
  it("holds at least one skill", () => {
    expect(skillNames.length).toBeGreaterThan(0);
  });

  it.each(skillNames)("gives %s a SKILL.md at its root", (name) => {
    expect(statSync(path.join(skillsDirectory, name, "SKILL.md")).isFile()).toBe(true);
  });

  it.each(skillNames)("names %s's frontmatter after its directory", (name) => {
    expect(readSkill(name)["name"]).toBe(name);
  });

  it.each(skillNames)("declares only the dual-host keys in %s", (name) => {
    expect(Object.keys(readSkill(name)).sort()).toEqual([...ALLOWED_KEYS].sort());
  });

  it.each(skillNames)("gives %s a description both hosts can match on", (name) => {
    const description = readSkill(name)["description"] ?? "";
    expect(description).not.toBe("");
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });

  it.each(skillNames)("keeps %s's description in English", (name) => {
    expect(readSkill(name)["description"]).not.toMatch(NON_ENGLISH_SCRIPT);
  });

  it.each(skillNames)("keeps SKILL.md unique within %s", (name) => {
    // A SKILL.md below the skill root registers as a second, nameless skill.
    expect(
      listSkillFiles(name).filter((file) => path.basename(file) === "SKILL.md"),
    ).toEqual(["SKILL.md"]);
  });
});

describe("AGENTS.md's Skills routing table", () => {
  // The table is the only place an agent learns a skill exists at all; a
  // skill missing from it never gets loaded, and a stale row that survives a
  // rename or deletion sends an agent to a directory that is no longer there.

  it.each(skillNames)("gives %s a row in the routing table", (name) => {
    expect(routingTableSkillNames).toContain(name);
  });

  it.each(routingTableSkillNames)(
    "names %s after an existing skill directory",
    (name) => {
      expect(skillNames).toContain(name);
    },
  );
});

describe("parseFrontmatter", () => {
  it("reads a plain scalar", () => {
    expect(parseFrontmatter("---\nname: a-skill\n---\n# Title\n")).toEqual({
      name: "a-skill",
    });
  });

  it("folds a block scalar onto one line", () => {
    const source = "---\nname: a\ndescription: >\n  First line\n  second line.\n---\n";
    expect(parseFrontmatter(source)["description"]).toBe("First line second line.");
  });

  it("folds a stripped block scalar the same way", () => {
    const source = "---\nname: a\ndescription: >-\n  Only line.\n---\n";
    expect(parseFrontmatter(source)["description"]).toBe("Only line.");
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => parseFrontmatter("# Title\n")).toThrow(/frontmatter delimiter/u);
  });

  it("rejects frontmatter that is never closed", () => {
    expect(() => parseFrontmatter("---\nname: a\n")).toThrow(/never closed/u);
  });

  it("rejects a line that is neither a key nor a continuation", () => {
    expect(() => parseFrontmatter("---\n- stray\n---\n")).toThrow(/neither a key/u);
  });

  it("rejects a plain scalar value with an unquoted colon-space", () => {
    // Valid YAML would read the second colon as opening a nested mapping;
    // real parsers reject or mangle it, so a scalar shaped like this must
    // never be accepted here either. See openai/codex#8609.
    expect(() =>
      parseFrontmatter("---\nname: a\ndescription: bad: value\n---\n"),
    ).toThrow(/unquoted ": "/u);
  });

  it.each(skillNames)(
    "parses %s's real frontmatter without an unquoted colon-space in a plain scalar",
    (name) => {
      // Every skill today writes its description as a folded block scalar,
      // so this should never fire — it exists to catch a future skill that
      // reverts to a plain scalar and reintroduces the invalid shape above.
      expect(() => readSkill(name)).not.toThrow();
    },
  );

  it("rejects frontmatter that declares the same key twice", () => {
    expect(() =>
      parseFrontmatter("---\nname: a\ndescription: one\ndescription: two\n---\n"),
    ).toThrow(/more than once/u);
  });

  it("rejects a folded key that is declared twice", () => {
    const source =
      "---\nname: a\ndescription: >\n  First.\ndescription: >\n  Second.\n---\n";
    expect(() => parseFrontmatter(source)).toThrow(/more than once/u);
  });
});
