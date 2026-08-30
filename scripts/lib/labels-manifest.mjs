// Parse `.github/labels.yml`, the single declarative source for this
// repository's label taxonomy (name, colour, description).
//
// This is deliberately not a general YAML parser. tests/workflows.test.ts
// makes the same call for workflow files, for the same reason: a parser is a
// new dependency, and the manifest's shape is a flat list of three-key
// mappings, which a few lines of line scanning read exactly as well as a
// library would.

/**
 * One label declaration.
 *
 * @typedef {object} LabelDeclaration
 * @property {string} name - Label name, exactly as GitHub displays it.
 * @property {string} color - Six lowercase hex digits, no leading `#`.
 * @property {string} description - One-line description shown on the label.
 */

const ENTRY_START = /^- name:\s*(.+)$/;
const FIELD = /^ {2}([a-z]+):\s*(.*)$/;
const HEX_COLOR = /^[0-9a-f]{6}$/;

/**
 * Strip one matching pair of surrounding double quotes from a scalar value.
 *
 * @param {string} value - Raw text after the `key:`.
 * @returns {string} The value with its quotes removed, if it had any.
 */
function unquote(value) {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/**
 * Parse the label manifest into declarations.
 *
 * @param {string} text - Contents of `.github/labels.yml`.
 * @returns {LabelDeclaration[]} Declarations, in file order.
 * @throws Error when an entry is missing a field, has an invalid colour, or
 * repeats a name already declared earlier in the file.
 */
export function parseLabelManifest(text) {
  /** @type {Partial<LabelDeclaration>[]} */
  const entries = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const start = ENTRY_START.exec(line);
    const startedName = start?.[1];
    if (startedName !== undefined) {
      entries.push({ name: unquote(startedName.trim()) });
      continue;
    }

    const field = FIELD.exec(line);
    const key = field?.[1];
    const rawValue = field?.[2];
    if (key === undefined || rawValue === undefined || entries.length === 0) {
      continue;
    }
    const value = unquote(rawValue.trim());
    const current = entries[entries.length - 1];
    if (current !== undefined && (key === "color" || key === "description")) {
      current[key] = value;
    }
  }

  /** @type {Set<string>} */
  const seen = new Set();
  return entries.map((entry, index) => {
    if (
      entry.name === undefined ||
      entry.color === undefined ||
      entry.description === undefined
    ) {
      throw new Error(
        `ERR_LABELS_MANIFEST_INCOMPLETE: entry ${String(index)} of .github/labels.yml is missing a field.\n` +
          "Expected: name, color, and description on every entry.\n" +
          `Actual: ${JSON.stringify(entry)}\n` +
          "Next: fix .github/labels.yml.",
      );
    }
    if (!HEX_COLOR.test(entry.color)) {
      throw new Error(
        `ERR_LABELS_MANIFEST_COLOR: "${entry.name}" in .github/labels.yml has an invalid color.\n` +
          "Expected: six lowercase hex digits, no leading `#` (e.g. d73a4a).\n" +
          `Actual: ${JSON.stringify(entry.color)}\n` +
          "Next: fix .github/labels.yml.",
      );
    }
    if (seen.has(entry.name)) {
      throw new Error(
        `ERR_LABELS_MANIFEST_DUPLICATE: "${entry.name}" is declared more than once in .github/labels.yml.\n` +
          "Expected: every label name to appear exactly once.\n" +
          "Next: remove the duplicate entry.",
      );
    }
    seen.add(entry.name);
    return { name: entry.name, color: entry.color, description: entry.description };
  });
}
