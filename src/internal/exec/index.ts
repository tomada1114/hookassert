/**
 * The executor's own internal surface: the dynamic layer's spawn seam and
 * the primitive that runs an `ExecutionPlan` through it.
 *
 * @remarks
 * `src/cli.ts` is the composition root that wires a real `NodeSpawner` and
 * `executeHooks` into the `test` command; nothing here is re-exported from
 * `src/index.ts` — see `spec/index.ts`'s doc comment for why that boundary
 * is enforced mechanically, not just by convention.
 */

export {
  buildHookEnv,
  executeHooks,
  HOOKASSERT_DEFAULT_TIMEOUT_MS,
  isCredentialShapedEnvKey,
  resolveDefaultTimeoutMs,
} from "./executor.js";
export type { ExecDeps, ExecutionPlan, ExecutionStep } from "./executor.js";
export { createUnimplementedSpawner, NodeSpawner } from "./spawner.js";
export type { SpawnRequest, Spawner } from "./spawner.js";
export type { VersionProbe } from "./version.js";
