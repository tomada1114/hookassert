/**
 * Enumerates the settings files hookassert reads hooks from.
 *
 * @remarks
 * Static layer: this module only builds candidate paths from the options it
 * is given. It never touches the filesystem — `load.ts` is what reads (or
 * tolerates the absence of) each file this returns.
 */

import path from "node:path";

import type { SettingsSource } from "./types.js";

/** Where to look for the three well-known settings layers. */
export interface DiscoverSettingsOptions {
  /** The project directory `project` and `local` settings are read relative to. */
  readonly cwd: string;

  /** The directory `user` settings are read relative to. */
  readonly home: string;

  /**
   * Repeatable `--settings <file>` arguments, resolved against `cwd`.
   *
   * @remarks
   * Each becomes its own `explicit`-layer source, in the order given —
   * `merge.ts` preserves that relative order in the firing set.
   */
  readonly explicit?: readonly string[];
}

/**
 * Build the candidate settings sources for the four layers, in
 * `user, project, local, explicit` order.
 *
 * @remarks
 * A returned source is a candidate, not a guarantee the file exists: most
 * projects declare only one or two of the three well-known layers, and
 * `load.ts` treats a missing user/project/local file as contributing zero
 * hooks rather than an error.
 */
export function discoverSources(
  options: DiscoverSettingsOptions,
): readonly SettingsSource[] {
  const explicitFiles = options.explicit ?? [];
  const explicitSources: SettingsSource[] = explicitFiles.map((file) => ({
    path: path.resolve(options.cwd, file),
    layer: "explicit",
  }));

  return [
    { path: path.join(options.home, ".claude", "settings.json"), layer: "user" },
    { path: path.join(options.cwd, ".claude", "settings.json"), layer: "project" },
    {
      path: path.join(options.cwd, ".claude", "settings.local.json"),
      layer: "local",
    },
    ...explicitSources,
  ];
}
