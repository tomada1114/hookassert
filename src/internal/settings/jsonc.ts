/**
 * The shared JSONC reading primitives `settings/load.ts`'s strict loader and
 * `lint/parse.ts`'s tolerant walk both build on.
 *
 * @remarks
 * Static layer: reads a file's text and parses it, but never spawns a
 * process and never writes anything back — the same guarantee every module
 * under `src/internal/settings/` and `src/internal/lint/` makes. Uses
 * `jsonc-parser`'s `parseTree` rather than `JSON.parse` so a hook's
 * declaration keeps its offset into the source text — the same convention
 * `record`'s later write-back path depends on. Neither `load.ts` nor
 * `parse.ts` may drift from what counts as a well-formed settings file
 * without also drifting from this module — that is the point of pulling it
 * out from under both.
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
import type { SettingsSource } from "./types.js";

/**
 * The event names hookassert recognizes today.
 *
 * @remarks
 * Typed as `Record<EventName, true>` rather than an array so the mirror
 * cannot silently drift: widening `src/types.ts`'s `EventName` without
 * extending this map is a type error here, instead of a reader that quietly
 * drops every hook declared under the new event. A `hooks` key outside this
 * set is still not an error — it is treated as an event Claude Code added
 * after this map was last extended, and silently carries no hooks forward,
 * exactly as it would if the spec module does not yet classify it either. The
 * `matcher` issue is what wires the strict loader to `src/internal/spec/`
 * instead of this hand-kept mirror.
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

/** Whether `value` is one of the events {@link KNOWN_EVENT_NAMES} mirrors from `EventName`. */
export function isEventName(value: string): value is EventName {
  return Object.hasOwn(KNOWN_EVENT_NAMES, value);
}

/** Find a property node's *value* node inside an object node, by key. */
export function getProperty(objectNode: Node, key: string): Node | undefined {
  for (const property of objectNode.children ?? []) {
    const [keyNode, valueNode] = property.children ?? [];
    if (keyNode?.type === "string" && keyNode.value === key) {
      return valueNode;
    }
  }
  return undefined;
}

/** 1-based line and column of a UTF-16 code-unit offset into `text`. */
export function positionAt(
  text: string,
  offset: number,
): { line: number; col: number } {
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

export function describeParseErrors(errors: readonly ParseError[]): string {
  return errors
    .map(
      (error) =>
        `${printParseErrorCode(error.error)} at offset ${String(error.offset)}`,
    )
    .join(", ");
}

export function fail(source: SettingsSource, reason: string): never {
  throw new SettingsParseError(source.path, source.layer, reason);
}

export function requireObject(
  node: Node | undefined,
  source: SettingsSource,
  description: string,
): Node {
  if (node?.type !== "object") {
    fail(source, `${description} must be an object`);
  }
  return node;
}

export function requireArray(
  node: Node | undefined,
  source: SettingsSource,
  description: string,
): readonly Node[] {
  if (node?.type !== "array") {
    fail(source, `${description} must be an array`);
  }
  return node.children ?? [];
}

export function requireString(
  node: Node | undefined,
  source: SettingsSource,
  description: string,
): string {
  if (node?.type !== "string" || typeof node.value !== "string") {
    fail(source, `${description} must be a string`);
  }
  return node.value;
}

export function requireNonEmptyString(
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

export function requireNumber(
  node: Node,
  source: SettingsSource,
  description: string,
): number {
  if (node.type !== "number" || typeof node.value !== "number") {
    fail(source, `${description} must be a number`);
  }
  return node.value;
}

export function readStringArray(
  node: Node,
  source: SettingsSource,
  description: string,
): readonly string[] {
  const elements = requireArray(node, source, description);
  return elements.map((element) =>
    requireString(element, source, `every element of ${description}`),
  );
}

/**
 * Read `source`'s file text and its `hooks` object node.
 *
 * @remarks
 * Returns `undefined` when the file does not exist — most projects declare
 * only one or two of the three well-known layers, and that is not an error.
 * A file that exists but cannot be parsed as JSONC, or whose top level or
 * `hooks` value is not an object, throws {@link SettingsParseError}.
 * `hooksNode` is `undefined` when the file parses but declares no `hooks`
 * key at all — distinct from the file not existing, which this function
 * signals by returning `undefined` itself rather than an object whose
 * `hooksNode` is `undefined`.
 */
export function readSettingsTree(
  source: SettingsSource,
): { readonly text: string; readonly hooksNode: Node | undefined } | undefined {
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
      return undefined;
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
    return { text, hooksNode: undefined };
  }
  requireObject(hooksNode, source, '"hooks"');

  return { text, hooksNode };
}

/**
 * Read one `hooks.<event>[].hooks[]` entry's `command` and `args` — the part
 * `settings/load.ts`'s strict `readCommandHooks` and `lint/parse.ts`'s
 * tolerant `readGroupCommands` both read identically. `load.ts` adds
 * `timeout` and `provenance` on top; `parse.ts` adds `line`.
 */
export function readCommandEntry(
  hookNode: Node,
  event: EventName,
  source: SettingsSource,
): { readonly command: string; readonly args: readonly string[] | undefined } {
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

  return { command, args };
}
