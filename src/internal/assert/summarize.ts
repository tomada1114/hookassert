/**
 * Folds a `CaseResult[]` into the `Summary` every reporter prints.
 *
 * @remarks
 * Static layer: pure fold — no I/O, no process, no write, and no state
 * outside this function's own local counters. This is the single place a
 * `Summary` is built: no reporter under `src/internal/report/` may keep a
 * tally of its own, so the numbers a reporter prints can never drift from
 * what `summarize` actually counted.
 */

import type { CaseResult, Summary } from "../../types.js";

/**
 * Fold `results` into a `Summary`.
 *
 * @remarks
 * Every `CaseResult` contributes to exactly one of `asserted` (as a
 * `"pass"` or a `"fail"`), `unknown`, or `skipped` — never more than one,
 * and never none. `fromRecorded` and `failed` are further breakdowns of the
 * `asserted` set, so a `"fail"` result deliberately increments both
 * `asserted` and `failed` together, and a recorded-origin `"pass"` or
 * `"fail"` increments both `asserted` and `fromRecorded` together — this is
 * the intended overlap, not double counting across the four disjoint kinds.
 */
export function summarize(results: readonly CaseResult[]): Summary {
  let asserted = 0;
  let fromRecorded = 0;
  let failed = 0;
  let unknown = 0;
  let skipped = 0;

  for (const result of results) {
    switch (result.kind) {
      case "pass": {
        asserted++;
        if (result.origin.kind === "recorded") {
          fromRecorded++;
        }
        break;
      }
      case "fail": {
        asserted++;
        failed++;
        if (result.origin.kind === "recorded") {
          fromRecorded++;
        }
        break;
      }
      case "unknown": {
        unknown++;
        break;
      }
      case "skipped": {
        skipped++;
        break;
      }
    }
  }

  return { asserted, fromRecorded, failed, unknown, skipped };
}
