/**
 * Reads every `hooks.<event>[]` matcher group out of a settings file,
 * tolerant of a matcher declared as a JSON array.
 *
 * @remarks
 * Static layer: reads a file's text and parses it, but never spawns a
 * process and never writes anything back — the same guarantee
 * `settings/load.ts` makes.
 *
 * `settings/load.ts`'s own `loadSourceHooks` cannot be reused here: it calls
 * `requireString` on every declared `matcher`, which throws
 * `SettingsParseError` the moment one is a JSON array
 * (`tests/settings.test.ts`'s "a matcher written as a JSON array disables
 * every hook in that settings file" describes exactly this). That is the
 * right behavior for `explain`/`test`, which need a fully resolved
 * `ResolvedHook[]` or nothing at all — but it is exactly the case
 * `matcher-is-array` exists to turn into a `Finding` instead of a thrown
 * error, so this module reads the same JSONC tree with the same structural
 * strictness everywhere else, carving out only the one exception: a
 * `matcher` may be `absent`, a `string`, or an `array` without ever
 * throwing. Any other shape (a number, a boolean, an object) is still
 * rejected exactly as `settings/load.ts` would reject it — this module is
 * not a general-purpose lenient settings reader, only the one exception
 * `matcher-is-array` needs.
 */

import { readFileSync } from "node:fs";

import {
  type Node,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";

import type { EventName } from "../../types.js";
import { SettingsParseError } from "../errors.js";
import type { SettingsSource } from "../settings/index.js";
import type { LintContext, LintMatcherGroup, LintMatcherValue } from "./types.js";

/**
 * The event names this reader recognizes — the same set
 * `settings/load.ts`'s own `KNOWN_EVENT_NAMES` mirrors from `EventName`.
 *
 * @remarks
 * Typed as `Record<EventName, true>` rather than an array so widening
 * `EventName` without extending this map is a type error here, instead of a
 * reader that quietly drops every group declared under the new event. A
 * `hooks` key outside this set is not an error — see `KNOWN_EVENT_NAMES`'s
 * own doc comment in `settings/load.ts` for why.
 */
const KNOWN_EVENT_NAMES: Readonly<Record<EventName, true>> = {
  SessionStart: true,
  Setup: true,
  InstructionsLoaded: true,
  UserPromptSubmit: true,
  UserPromptExpansion: true,
  MessageDisplay: true,
  PreToolUse: true,
  PermissionRequest: true,
  PostToolUse: true,
  PostToolUseFailure: true,
  PostToolBatch: true,
  PermissionDenied: true,
  Notification: true,
  SubagentStart: true,
  SubagentStop: true,
  TaskCreated: true,
  TaskCompleted: true,
  Stop: true,
  StopFailure: true,
  TeammateIdle: true,
  ConfigChange: true,
  CwdChanged: true,
  DirectoryAdded: true,
  FileChanged: true,
  WorktreeCreate: true,
  WorktreeRemove: true,
  PreCompact: true,
  PostCompact: true,
  PreModelSwitch: true,
  PostModelSwitch: true,
  SessionEnd: true,
  Elicitation: true,
  ElicitationResult: true,
};

function isEventName(value: string): value is EventName {
  return Object.hasOwn(KNOWN_EVENT_NAMES, value);
}

/** Find a property node's *value* node inside an object node, by key. */
function getProperty(objectNode: Node, key: string): Node | undefined {
  for (const property of objectNode.children ?? []) {
    const [keyNode, valueNode] = property.children ?? [];
    if (keyNode?.type === "string" && keyNode.value === key) {
      return valueNode;
    }
  }
  return undefined;
}

/** 1-based line of a UTF-16 code-unit offset into `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

function describeParseErrors(errors: readonly ParseError[]): string {
  return errors
    .map(
      (error) =>
        `${printParseErrorCode(error.error)} at offset ${String(error.offset)}`,
    )
    .join(", ");
}

function fail(source: SettingsSource, reason: string): never {
  throw new SettingsParseError(source.path, source.layer, reason);
}

function requireObject(
  node: Node | undefined,
  source: SettingsSource,
  description: string,
): Node {
  if (node?.type !== "object") {
    fail(source, `${description} must be an object`);
  }
  return node;
}

function requireArray(
  node: Node | undefined,
  source: SettingsSource,
  description: string,
): readonly Node[] {
  if (node?.type !== "array") {
    fail(source, `${description} must be an array`);
  }
  return node.children ?? [];
}

function requireString(
  node: Node | undefined,
  source: SettingsSource,
  description: string,
): string {
  if (node?.type !== "string" || typeof node.value !== "string") {
    fail(source, `${description} must be a string`);
  }
  return node.value;
}

/**
 * Read one group's `matcher` property tolerantly: `absent`, `string`, or
 * `array` never throw — anything else is still a structural error, exactly
 * as `settings/load.ts`'s `requireString` would reject it.
 */
function readMatcherValue(
  node: Node | undefined,
  source: SettingsSource,
  event: EventName,
): LintMatcherValue {
  if (node === undefined) {
    return { kind: "absent" };
  }
  if (node.type === "string" && typeof node.value === "string") {
    return { kind: "string", value: node.value };
  }
  if (node.type === "array") {
    const items = (node.children ?? []).flatMap((child) =>
      child.type === "string" && typeof child.value === "string" ? [child.value] : [],
    );
    return { kind: "array", items };
  }
  fail(source, `"hooks.${event}[].matcher" must be a string or an array`);
}

/**
 * Read every matcher group `source` declares.
 *
 * @remarks
 * A missing file contributes zero groups — the same "most projects declare
 * only one or two of the three well-known layers" convention
 * `settings/load.ts` follows. A file that exists but cannot be parsed as
 * JSONC, or whose `hooks` value is not shaped the way Claude Code's own
 * settings schema requires (beyond the one exception above), throws
 * {@link SettingsParseError}.
 */
export function readMatcherGroups(source: SettingsSource): readonly LintMatcherGroup[] {
  let text: string;
  try {
    text = readFileSync(source.path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    fail(source, describeParseErrors(errors));
  }
  const rootNode = requireObject(root, source, "the settings file");

  const hooksNode = getProperty(rootNode, "hooks");
  if (hooksNode === undefined) {
    return [];
  }
  requireObject(hooksNode, source, '"hooks"');

  const groups: LintMatcherGroup[] = [];
  for (const property of hooksNode.children ?? []) {
    const [keyNode, groupsNode] = property.children ?? [];
    const eventKey = requireString(keyNode, source, 'every key of "hooks"');
    if (!isEventName(eventKey)) {
      // Forward-compatible: an event this reader does not yet know about is
      // skipped rather than rejected. See KNOWN_EVENT_NAMES's doc comment.
      continue;
    }

    const groupNodes = requireArray(groupsNode, source, `"hooks.${eventKey}"`);
    for (const groupNode of groupNodes) {
      requireObject(groupNode, source, `an entry of "hooks.${eventKey}"`);
      const matcherNode = getProperty(groupNode, "matcher");
      const matcher = readMatcherValue(matcherNode, source, eventKey);
      const line = lineAt(text, matcherNode?.offset ?? groupNode.offset);
      groups.push({
        file: source.path,
        layer: source.layer,
        event: eventKey,
        line,
        matcher,
      });
    }
  }

  return groups;
}

/** Build the `LintContext` every `LintRule` runs over, from every settings source `lint` discovered. */
export function buildLintContext(
  sources: readonly SettingsSource[],
  spec: LintContext["spec"],
  versionContext: LintContext["versionContext"],
): LintContext {
  return {
    spec,
    versionContext,
    groups: sources.flatMap((source) => readMatcherGroups(source)),
  };
}
