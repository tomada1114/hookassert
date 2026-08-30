/**
 * Reads one settings file's hooks, with source position attached to each.
 *
 * @remarks
 * Static layer: reads a file's text and parses it, but never spawns a
 * process and never writes anything back. Uses `jsonc-parser`'s `parseTree`
 * rather than `JSON.parse` so a hook's declaration keeps its offset into the
 * source text — the same convention `record`'s later write-back path depends
 * on. `merge.ts` is what turns several files' worth of these into one
 * ordered, deduped `ResolvedSettings`.
 */

import { readFileSync } from "node:fs";

import {
  type Node,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";

import type { EventName, Provenance } from "../../types.js";
import { SettingsParseError } from "../errors.js";
import type { RawHook, SettingsSource } from "./types.js";

/**
 * The event names this loader recognizes today.
 *
 * @remarks
 * Typed as `Record<EventName, true>` rather than an array so the mirror
 * cannot silently drift: widening `src/types.ts`'s `EventName` without
 * extending this map is a type error here, instead of a loader that quietly
 * drops every hook declared under the new event. A `hooks` key outside this
 * set is still not an error — it is treated as an event Claude Code added
 * after this map was last extended, and silently carries no hooks forward,
 * exactly as it would if the spec module does not yet classify it either. The
 * `matcher` issue is what wires this loader to `src/internal/spec/` instead
 * of this hand-kept mirror.
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

/** 1-based line and column of a UTF-16 code-unit offset into `text`. */
function positionAt(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, col: offset - lastNewline };
}

function provenanceAt(
  file: string,
  layer: SettingsSource["layer"],
  text: string,
  offset: number,
): Provenance {
  const { line, col } = positionAt(text, offset);
  return { file, layer, line, col, offset };
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

function requireNonEmptyString(
  node: Node | undefined,
  source: SettingsSource,
  description: string,
): string {
  const value = requireString(node, source, description);
  if (value.length === 0) {
    fail(source, `${description} must be a non-empty string`);
  }
  return value;
}

function requireNumber(
  node: Node,
  source: SettingsSource,
  description: string,
): number {
  if (node.type !== "number" || typeof node.value !== "number") {
    fail(source, `${description} must be a number`);
  }
  return node.value;
}

function readStringArray(
  node: Node,
  source: SettingsSource,
  description: string,
): readonly string[] {
  const elements = requireArray(node, source, description);
  return elements.map((element) =>
    requireString(element, source, `every element of ${description}`),
  );
}

/** One `hooks.<event>[]` matcher group's own `hooks: [...]` entries. */
function readCommandHooks(
  groupNode: Node,
  event: EventName,
  source: SettingsSource,
  text: string,
): RawHook[] {
  const matcherNode = getProperty(groupNode, "matcher");
  const matcher =
    matcherNode === undefined
      ? undefined
      : requireString(matcherNode, source, `"hooks.${event}[].matcher"`);

  const commandsNode = getProperty(groupNode, "hooks");
  const commandNodes = requireArray(commandsNode, source, `"hooks.${event}[].hooks"`);

  return commandNodes.map((hookNode) => {
    requireObject(hookNode, source, `an entry of "hooks.${event}[].hooks"`);

    const commandNode = getProperty(hookNode, "command");
    const command = requireNonEmptyString(
      commandNode,
      source,
      `"hooks.${event}[].hooks[].command"`,
    );

    const argsNode = getProperty(hookNode, "args");
    const args =
      argsNode === undefined
        ? undefined
        : readStringArray(argsNode, source, `"hooks.${event}[].hooks[].args"`);

    const timeoutNode = getProperty(hookNode, "timeout");
    // Claude Code's own settings schema writes `timeout` in seconds;
    // ResolvedHook.timeoutMs is documented in milliseconds.
    const timeoutMs =
      timeoutNode === undefined
        ? undefined
        : requireNumber(timeoutNode, source, `"hooks.${event}[].hooks[].timeout"`) *
          1000;

    return {
      event,
      matcher,
      command,
      args,
      timeoutMs,
      provenance: provenanceAt(source.path, source.layer, text, hookNode.offset),
    } satisfies RawHook;
  });
}

/**
 * Read one settings file's hooks, tagged with `source.layer` and their
 * position in the source text.
 *
 * @remarks
 * A missing file contributes zero hooks — most projects declare only one or
 * two of the three well-known layers, and that is not an error. A file that
 * exists but cannot be parsed as JSONC, or whose `hooks` value is not shaped
 * the way Claude Code's own settings schema requires, throws
 * {@link SettingsParseError}.
 */
export function loadSourceHooks(source: SettingsSource): readonly RawHook[] {
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

  const hooks: RawHook[] = [];
  for (const property of hooksNode.children ?? []) {
    const [keyNode, groupsNode] = property.children ?? [];
    const eventKey = requireString(keyNode, source, 'every key of "hooks"');
    if (!isEventName(eventKey)) {
      // Forward-compatible: an event this loader does not yet know about is
      // skipped rather than rejected. See KNOWN_EVENT_NAMES's doc comment.
      continue;
    }

    const groupNodes = requireArray(groupsNode, source, `"hooks.${eventKey}"`);
    for (const groupNode of groupNodes) {
      requireObject(groupNode, source, `an entry of "hooks.${eventKey}"`);
      hooks.push(...readCommandHooks(groupNode, eventKey, source, text));
    }
  }

  return hooks;
}
