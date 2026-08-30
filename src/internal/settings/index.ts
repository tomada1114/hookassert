/**
 * The settings loader's own internal surface.
 *
 * @remarks
 * `src/cli.ts` (a later cli-explain issue) is the composition root that will
 * import from here; nothing here is re-exported from `src/index.ts` - see
 * `types.ts`'s doc comment for why that boundary is enforced mechanically,
 * not just by convention.
 */

import { loadSourceHooks } from "./load.js";
import { mergeSources } from "./merge.js";
import type { ResolvedSettings, SettingsSource } from "./types.js";

export { discoverSources } from "./discover.js";
export type { DiscoverSettingsOptions } from "./discover.js";
export { loadSourceHooks } from "./load.js";
export { hooksForEvent, mergeSources } from "./merge.js";
export type {
  RawHook,
  ResolvedSettings,
  SettingsSource,
  SourceHooks,
} from "./types.js";

/**
 * Read every hook declared across the four settings layers.
 *
 * @remarks
 * Ties `discover.ts` (which sources exist), `load.ts` (what each one
 * declares) and `merge.ts` (how they combine) together into the one entry
 * point this issue's design section names. Given `sources` directly rather
 * than deriving them, so a caller who already knows its own layout (tests,
 * and the eventual CLI wiring) never has to fight `discoverSources`'s
 * cwd/home defaults.
 */
export function loadSettings(sources: readonly SettingsSource[]): ResolvedSettings {
  const perSource = sources.map((source) => ({
    source,
    hooks: loadSourceHooks(source),
  }));
  return mergeSources(perSource);
}
