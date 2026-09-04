/**
 * Reads every `hooks.<event>[]` matcher group and `hooks.<event>[].hooks[]`
 * command declaration out of a settings file, tolerant of a matcher declared
 * as a JSON array.
 *
 * @remarks
 * Static layer: reads a file's text and parses it, but never spawns a
 * process and never writes anything back — the same guarantee
 * `settings/load.ts` makes. This is not a second reader: it is a second
 * *walk* over the same shared parse `settings/jsonc.ts` owns.
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
 * `matcher-is-array` needs. Every command entry (`hooks.<event>[].hooks[]`)
 * is read with the same strictness `settings/jsonc.ts`'s `readCommandEntry`
 * applies — no exception carved out there.
 */

import type { Node } from "jsonc-parser";

import type { EventName } from "../../types.js";
import {
  fail,
  getProperty,
  isEventName,
  positionAt,
  readCommandEntry,
  readSettingsTree,
  requireArray,
  requireObject,
  requireString,
  type SettingsSource,
} from "../settings/index.js";
import type {
  LintContext,
  LintHookCommand,
  LintMatcherGroup,
  LintMatcherValue,
} from "./types.js";

/**
 * Read one group's `matcher` property tolerantly: `absent`, `string`, or
 * `array` never throw — anything else is still a structural error, exactly
 * as `settings/jsonc.ts`'s `requireString` would reject it.
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
 * Read one group's own `hooks: [...]` command entries — the same shape
 * `settings/jsonc.ts`'s `readCommandEntry` reads, minus the `timeoutMs`
 * conversion and `dedupeKey` fields the command rules never need.
 */
function readGroupCommands(
  groupNode: Node,
  event: EventName,
  source: SettingsSource,
  text: string,
): readonly LintHookCommand[] {
  const commandsNode = getProperty(groupNode, "hooks");
  const commandNodes = requireArray(commandsNode, source, `"hooks.${event}[].hooks"`);

  return commandNodes.map((hookNode) => {
    const { command, args } = readCommandEntry(hookNode, event, source);

    return {
      file: source.path,
      layer: source.layer,
      event,
      line: positionAt(text, hookNode.offset).line,
      command,
      args,
    } satisfies LintHookCommand;
  });
}

/** {@link readMatcherGroups} and {@link readHookCommands}' shared, single-parse implementation. */
function readGroupsAndCommands(source: SettingsSource): {
  readonly groups: readonly LintMatcherGroup[];
  readonly commands: readonly LintHookCommand[];
} {
  const settingsTree = readSettingsTree(source);
  if (settingsTree === undefined) {
    return { groups: [], commands: [] };
  }
  const { text, hooksNode } = settingsTree;
  if (hooksNode === undefined) {
    return { groups: [], commands: [] };
  }

  const groups: LintMatcherGroup[] = [];
  const commands: LintHookCommand[] = [];
  for (const property of hooksNode.children ?? []) {
    const [keyNode, groupsNode] = property.children ?? [];
    const eventKey = requireString(keyNode, source, 'every key of "hooks"');
    if (!isEventName(eventKey)) {
      // Forward-compatible: an event this reader does not yet know about is
      // skipped rather than rejected. See `settings/jsonc.ts`'s
      // `isEventName` doc comment.
      continue;
    }

    const groupNodes = requireArray(groupsNode, source, `"hooks.${eventKey}"`);
    for (const groupNode of groupNodes) {
      requireObject(groupNode, source, `an entry of "hooks.${eventKey}"`);
      const matcherNode = getProperty(groupNode, "matcher");
      const matcher = readMatcherValue(matcherNode, source, eventKey);
      const line = positionAt(text, matcherNode?.offset ?? groupNode.offset).line;
      groups.push({
        file: source.path,
        layer: source.layer,
        event: eventKey,
        line,
        matcher,
      });
      commands.push(...readGroupCommands(groupNode, eventKey, source, text));
    }
  }

  return { groups, commands };
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
  return readGroupsAndCommands(source).groups;
}

/**
 * Read every hook command `source` declares, across every matcher group.
 *
 * @remarks
 * Same tolerance and structural strictness as {@link readMatcherGroups} —
 * both are views over the same single parse of `source`'s text.
 */
export function readHookCommands(source: SettingsSource): readonly LintHookCommand[] {
  return readGroupsAndCommands(source).commands;
}

/**
 * Build the `LintContext` every `LintRule` runs over, from every settings
 * source `lint` discovered.
 *
 * @remarks
 * `env` is read for `PATH`/`HOME` only, and defaults to `{}` rather than
 * `process.env` — a caller that wants the running process's real
 * environment (`src/cli.ts`'s `runLint`, which passes `deps.env`) says so
 * explicitly, so a test builds a `LintContext` that depends only on what it
 * injects, never on the host machine's own environment.
 */
export function buildLintContext(
  sources: readonly SettingsSource[],
  spec: LintContext["spec"],
  versionContext: LintContext["versionContext"],
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = {},
): LintContext {
  const groups: LintMatcherGroup[] = [];
  const commands: LintHookCommand[] = [];
  for (const source of sources) {
    const read = readGroupsAndCommands(source);
    groups.push(...read.groups);
    commands.push(...read.commands);
  }
  return {
    spec,
    versionContext,
    groups,
    commands,
    projectRoot,
    pathEnv: env["PATH"],
    homeDir: env["HOME"],
  };
}
