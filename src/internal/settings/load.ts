/**
 * Reads one settings file's hooks, with source position attached to each.
 *
 * @remarks
 * Static layer: reads a file's text and parses it, but never spawns a
 * process and never writes anything back — see `jsonc.ts`'s own remark for
 * the shared reading primitives this module builds on. `merge.ts` is what
 * turns several files' worth of these into one ordered, deduped
 * `ResolvedSettings`.
 */

import type { Node } from "jsonc-parser";

import type { EventName, Provenance } from "../../types.js";
import { SettingsParseError } from "../errors.js";
import {
  getProperty,
  isEventName,
  positionAt,
  readCommandEntry,
  readSettingsTree,
  requireArray,
  requireNumber,
  requireObject,
  requireString,
} from "./jsonc.js";
import type { RawHook, SettingsSource } from "./types.js";

function provenanceAt(
  file: string,
  layer: SettingsSource["layer"],
  text: string,
  offset: number,
): Provenance {
  const { line, col } = positionAt(text, offset);
  return { file, layer, line, col, offset };
}

/** A {@link requireNumber} that also rejects zero, negative, and non-finite values. */
function requirePositiveNumber(
  node: Node,
  source: SettingsSource,
  text: string,
  description: string,
): number {
  const value = requireNumber(node, source, description);
  if (!Number.isFinite(value) || value <= 0) {
    const { line } = positionAt(text, node.offset);
    throw new SettingsParseError(
      source.path,
      source.layer,
      `${description} at line ${String(line)} must be a positive number of seconds, got ${String(value)}`,
    );
  }
  return value;
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
    const { command, args } = readCommandEntry(hookNode, event, source);

    const timeoutNode = getProperty(hookNode, "timeout");
    // Claude Code's own settings schema writes `timeout` in seconds;
    // ResolvedHook.timeoutMs is documented in milliseconds. `timeout` must be
    // finite and > 0 — Claude Code documents no semantics for zero or
    // negative, and either would multiply out to an instant timeout with no
    // hint the settings file is the cause. Fractional seconds still convert
    // as-is: `0.5` yields `timeoutMs: 500`.
    const timeoutMs =
      timeoutNode === undefined
        ? undefined
        : requirePositiveNumber(
            timeoutNode,
            source,
            text,
            `"hooks.${event}[].hooks[].timeout"`,
          ) * 1000;

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
  const settingsTree = readSettingsTree(source);
  if (settingsTree === undefined) {
    return [];
  }
  const { text, hooksNode } = settingsTree;
  if (hooksNode === undefined) {
    return [];
  }

  const hooks: RawHook[] = [];
  for (const property of hooksNode.children ?? []) {
    const [keyNode, groupsNode] = property.children ?? [];
    const eventKey = requireString(keyNode, source, 'every key of "hooks"');
    if (!isEventName(eventKey)) {
      // Forward-compatible: an event this loader does not yet know about is
      // skipped rather than rejected. See `jsonc.ts`'s `isEventName` doc
      // comment.
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
