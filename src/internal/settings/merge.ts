/**
 * Concatenates hooks read from several settings sources into one ordered,
 * deduped firing set.
 *
 * @remarks
 * This is the merge semantics the whole issue exists to get right: unlike
 * most settings keys, hooks are never overridden by a later layer - a hook
 * declared in project still fires even when local declares hooks of its own
 * for the same event. Only a same-handler duplicate (identical event,
 * matcher, command and args) collapses into one entry.
 */

import type { EventName, ResolvedHook, SettingsLayer } from "../../types.js";
import type { RawHook, ResolvedSettings, SourceHooks } from "./types.js";

/**
 * Merge order for the four layers.
 *
 * @remarks
 * user, project, local, explicit - the order src/types.ts's SettingsLayer
 * doc comment already names. Two sources of the same layer (only possible
 * for explicit, since discovery yields at most one file for each of the
 * other three) keep their relative order from the input array:
 * Array.prototype.sort is a stable sort, so entries with an equal rank are
 * never reordered against each other.
 */
const LAYER_ORDER: Readonly<Record<SettingsLayer, number>> = {
  user: 0,
  project: 1,
  local: 2,
  explicit: 3,
};

const DEDUPE_KEY_SEPARATOR = "::";

/**
 * The key two hook declarations must share to be treated as the same
 * handler.
 *
 * @remarks
 * Event, matcher, command, and args - not timeoutMs, so a later layer
 * repeating the same handler with a different deadline still collapses to
 * one entry (the first occurrence's own timeout is kept; see mergeSources).
 * Opaque to a caller: explain displays this value verbatim, but nothing
 * outside this module should parse it back apart.
 */
function dedupeKeyFor(hook: RawHook): string {
  const parts = [hook.event, hook.matcher ?? "", hook.command, ...(hook.args ?? [])];
  return parts.join(DEDUPE_KEY_SEPARATOR);
}

/**
 * Merge every source's raw hooks into one ordered, deduped ResolvedSettings.
 *
 * @remarks
 * Sources are concatenated in LAYER_ORDER, not in the order they were passed
 * in - loadSettings may hand this function sources in any order, and the
 * firing set's order must depend only on layer, per this issue's
 * "hooksForEvent returns hooks in a deterministic, documented order"
 * requirement.
 */
export function mergeSources(sources: readonly SourceHooks[]): ResolvedSettings {
  const ordered = [...sources].sort(
    (a, b) => LAYER_ORDER[a.source.layer] - LAYER_ORDER[b.source.layer],
  );

  const seen = new Set<string>();
  const hooks: ResolvedHook[] = [];
  for (const { hooks: rawHooks } of ordered) {
    for (const rawHook of rawHooks) {
      const dedupeKey = dedupeKeyFor(rawHook);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      hooks.push({ ...rawHook, dedupeKey });
    }
  }

  return { hooks };
}

/**
 * Every resolved hook that fires for event, in the same order they appear in
 * settings.hooks.
 */
export function hooksForEvent(
  settings: ResolvedSettings,
  event: EventName,
): readonly ResolvedHook[] {
  return settings.hooks.filter((hook) => hook.event === event);
}
