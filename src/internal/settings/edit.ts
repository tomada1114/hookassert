/**
 * Pure text-to-text edits that insert or remove `record`'s capture hook from
 * a settings file's own source text.
 *
 * @remarks
 * Static layer: both functions here are `text -> text`. Neither touches the
 * filesystem, computes a hash, or knows a session exists —
 * `src/internal/record/session.ts` (the dynamic layer) is what reads the
 * file before calling `insertCaptureHook`, writes its result back, and calls
 * `removeCaptureHook` again to invert it. Keeping the split this way is what
 * lets `settings/` stay the layer that "only reads": these functions produce
 * new text, but never write it anywhere themselves.
 *
 * Both use `jsonc-parser`'s `modify`/`applyEdits`, the same minimal-edit
 * machinery `load.ts` already depends on for offset-preserving parsing, so an
 * insertion or removal here disturbs only the JSON node it touches — every
 * other hook's own text, comments included, is left exactly as it was. That
 * is what the "the capture hook's presence changes no existing hook's firing
 * set" acceptance criterion reduces to: `matchHooks`/`hooksForEvent` read
 * each hook independently, so a sibling entry that is never rewritten cannot
 * change what it evaluates to.
 */

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type ModificationOptions,
  type Node,
} from "jsonc-parser";

import type { EventName } from "../../types.js";

/** One event `record` inserts a capture-hook matcher group for. */
export interface CaptureHookEntry {
  /** The event the inserted matcher group fires for. */
  readonly event: EventName;

  /**
   * The matcher string to declare, or `undefined` to omit the `matcher` key
   * entirely.
   *
   * @remarks
   * `undefined` is for an event whose `matcherTargets.kind` is `"none"` —
   * Claude Code accepts no matcher there, so declaring one would be
   * misleading even though it would still fire (`match.ts`'s own
   * `matcherIgnored` case). Every other event gets `"*"`, Claude Code's own
   * documented "match everything" wildcard, so the capture hook fires
   * regardless of which tool or field value the event actually carries.
   */
  readonly matcher: string | undefined;
}

/** What `insertCaptureHook` inserts, and for which events. */
export interface CapturePlan {
  /** Absolute path of the capture-hook script every inserted entry declares as its `command`. */
  readonly command: string;

  /** One matcher group to append per event, in the order given. */
  readonly entries: readonly CaptureHookEntry[];
}

/**
 * Enough of the original text's own shape to invert `insertCaptureHook`
 * precisely: which of the paths it may have created did not already exist,
 * so `removeCaptureHook` deletes only what it added and never a key the
 * original text already declared (even one that is now empty).
 */
export interface CaptureAnchors {
  /** Absolute path of the capture-hook script to search for and remove. */
  readonly command: string;

  /** Every event `insertCaptureHook` inserted a matcher group for. */
  readonly events: readonly EventName[];

  /**
   * Whether `hooks.<event>` already existed as an array in the original
   * text, keyed by event name.
   *
   * @remarks
   * When `false`, `removeCaptureHook` deletes the whole `"<event>": [...]`
   * property once its capture-hook group is the only thing removed from it,
   * restoring the original absence exactly. When `true`, the property is
   * left in place (possibly now empty) because the original text already
   * declared it, and byte-fidelity means never deleting something that was
   * already there.
   */
  readonly preexistingEventArray: Readonly<Record<string, boolean>>;

  /** Whether the top-level `"hooks"` object already existed in the original text. */
  readonly preexistingHooksObject: boolean;
}

/** `insertCaptureHook`'s result: the edited text, plus what `removeCaptureHook` needs to invert it. */
export interface CaptureEdit {
  /** The settings text with every entry of `plan.entries` appended. */
  readonly text: string;

  /** What `removeCaptureHook` needs to find and undo exactly this edit. */
  readonly anchors: CaptureAnchors;
}

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: "\n" };

const ARRAY_INSERT: ModificationOptions = {
  formattingOptions: FORMATTING_OPTIONS,
  isArrayInsertion: true,
};

const PLAIN_MODIFY: ModificationOptions = {
  formattingOptions: FORMATTING_OPTIONS,
};

/** One matcher-group object, exactly as Claude Code's own settings schema shapes `hooks.<event>[]`'s entries. */
function groupValue(command: string, matcher: string | undefined): unknown {
  return matcher === undefined
    ? { hooks: [{ command }] }
    : { matcher, hooks: [{ command }] };
}

/**
 * Insert one matcher group per `plan.entries[]` into `text`'s `hooks.<event>`
 * arrays, creating `"hooks"` and any missing `"<event>"` array along the way.
 *
 * @remarks
 * Pure: `text` in, edited text (plus the anchors that invert it) out. Every
 * insertion appends (`jsonc-parser`'s `-1` array index) rather than
 * replacing, so an existing matcher group for the same event is untouched —
 * order, formatting, and comments included.
 */
export function insertCaptureHook(text: string, plan: CapturePlan): CaptureEdit {
  const originalRoot = parseTree(text);
  const originalHooksNode =
    originalRoot === undefined
      ? undefined
      : findNodeAtLocation(originalRoot, ["hooks"]);
  const preexistingHooksObject = originalHooksNode?.type === "object";

  const preexistingEventArray: Record<string, boolean> = {};
  for (const entry of plan.entries) {
    const eventNode =
      originalHooksNode === undefined
        ? undefined
        : findNodeAtLocation(originalHooksNode, [entry.event]);
    preexistingEventArray[entry.event] = eventNode?.type === "array";
  }

  let current = text;
  for (const entry of plan.entries) {
    const value = groupValue(plan.command, entry.matcher);
    const edits = modify(current, ["hooks", entry.event, -1], value, ARRAY_INSERT);
    current = applyEdits(current, edits);
  }

  return {
    text: current,
    anchors: {
      command: plan.command,
      events: plan.entries.map((entry) => entry.event),
      preexistingEventArray,
      preexistingHooksObject,
    },
  };
}

/** Whether `hookNode` (a `hooks.<event>[].hooks[]` entry) declares `command`. */
function isOurCommand(hookNode: Node, command: string): boolean {
  const commandNode = findNodeAtLocation(hookNode, ["command"]);
  return commandNode?.type === "string" && commandNode.value === command;
}

/**
 * Remove every matcher group `anchors.command` appears in from `text`'s
 * `hooks.<event>` arrays, one event at a time.
 *
 * @remarks
 * Re-parses `text` after every single deletion rather than computing offsets
 * up front: each `modify` call already accounts for exactly one prior edit,
 * and re-parsing is what makes this safe to call against a `text` that
 * diverged from what `insertCaptureHook` produced (the "the user edited the
 * settings file while recording was active" case) — the search is always
 * against the text's current, real shape, never a stale one.
 */
function removeFromEvent(text: string, event: EventName, command: string): string {
  let current = text;
  for (;;) {
    const root = parseTree(current);
    const hooksNode =
      root === undefined ? undefined : findNodeAtLocation(root, ["hooks"]);
    const eventNode =
      hooksNode === undefined ? undefined : findNodeAtLocation(hooksNode, [event]);
    if (eventNode?.type !== "array") {
      return current;
    }

    const groups = eventNode.children ?? [];
    let removedThisPass = false;

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      if (group === undefined) {
        continue;
      }
      const hooksArrayNode = findNodeAtLocation(group, ["hooks"]);
      if (hooksArrayNode?.type !== "array") {
        continue;
      }
      const hookEntries = hooksArrayNode.children ?? [];
      const matchIndex = hookEntries.findIndex((hookNode) =>
        isOurCommand(hookNode, command),
      );
      if (matchIndex === -1) {
        continue;
      }

      const edits =
        hookEntries.length === 1
          ? modify(current, ["hooks", event, groupIndex], undefined, PLAIN_MODIFY)
          : modify(
              current,
              ["hooks", event, groupIndex, "hooks", matchIndex],
              undefined,
              PLAIN_MODIFY,
            );
      current = applyEdits(current, edits);
      removedThisPass = true;
      break;
    }

    if (!removedThisPass) {
      return current;
    }
  }
}

/**
 * Once `event`'s array is empty and it did not exist in the original text,
 * remove the whole `"<event>": []` property so the restored text has no
 * trace of it, matching the original's absence exactly.
 */
function pruneEmptyEventArray(
  text: string,
  event: EventName,
  wasPreexisting: boolean,
): string {
  if (wasPreexisting) {
    return text;
  }
  const root = parseTree(text);
  const hooksNode =
    root === undefined ? undefined : findNodeAtLocation(root, ["hooks"]);
  const eventNode =
    hooksNode === undefined ? undefined : findNodeAtLocation(hooksNode, [event]);
  if (eventNode?.type !== "array" || (eventNode.children?.length ?? 0) > 0) {
    return text;
  }
  const edits = modify(text, ["hooks", event], undefined, PLAIN_MODIFY);
  return applyEdits(text, edits);
}

/** Once `"hooks"` is empty and it did not exist in the original text, remove it entirely. */
function pruneEmptyHooksObject(text: string, wasPreexisting: boolean): string {
  if (wasPreexisting) {
    return text;
  }
  const root = parseTree(text);
  const hooksNode =
    root === undefined ? undefined : findNodeAtLocation(root, ["hooks"]);
  if (hooksNode?.type !== "object" || (hooksNode.children?.length ?? 0) > 0) {
    return text;
  }
  const edits = modify(text, ["hooks"], undefined, PLAIN_MODIFY);
  return applyEdits(text, edits);
}

/**
 * `jsonc-parser`'s own delete-editor leaves a single-property object's
 * former sibling whitespace behind when that property was the object's only
 * one (`{}` round-trips to `{\n}` rather than back to `{}`). Once the root
 * object has been emptied out by every prune step above, rewrite its own
 * span to the canonical two-character literal — the only content that span
 * can represent once it is legitimately empty — leaving everything before
 * and after the root object (a leading BOM, a trailing newline) untouched.
 */
function normalizeEmptyRoot(text: string): string {
  const root = parseTree(text);
  if (root?.type !== "object" || (root.children?.length ?? 0) > 0) {
    return text;
  }
  return text.slice(0, root.offset) + "{}" + text.slice(root.offset + root.length);
}

/**
 * Invert `insertCaptureHook`: remove every matcher group `anchors.command`
 * appears in, then prune any `"<event>"` array or `"hooks"` object that
 * `insertCaptureHook` itself created and is now empty.
 *
 * @remarks
 * Pure: `text` in, edited text out — never throws, and never assumes `text`
 * still matches what `insertCaptureHook` produced. A command this cannot find
 * for a given event (the user deleted it by hand) is simply left alone for
 * that event; `record/session.ts` is what compares the result against the
 * stored pre-image and reports a divergence, not this function.
 */
export function removeCaptureHook(text: string, anchors: CaptureAnchors): string {
  let current = text;
  for (const event of anchors.events) {
    current = removeFromEvent(current, event, anchors.command);
    current = pruneEmptyEventArray(
      current,
      event,
      anchors.preexistingEventArray[event] ?? false,
    );
  }
  current = pruneEmptyHooksObject(current, anchors.preexistingHooksObject);
  return normalizeEmptyRoot(current);
}
