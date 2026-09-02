/**
 * lib/fixtures/gen/ratings.ts — prior-cycle ratings (`FY2025 Year-End`).
 *
 * Owns: one rating per worker who started before 2026-01-01 and has a manager, rated by
 * that manager. One manager — `PINNED.outlier_manager` — is given a deliberately high,
 * deterministic pattern so the calibration packet in loop 1 has a real distribution
 * outlier to *observe* (never to judge; spec §8, §10 neutrality).
 *
 * Public interface: `PRIOR_CYCLE_NAME`, `generatePriorRatings`.
 *
 * Spec: docs/SPEC.md §8 loop 1; docs/PLAN.md §3 block B0.4.
 */

import type { PriorRating, Worker } from '#lib/types/tier1.ts';
import { PINNED } from '#lib/fixtures/gen/catalog.ts';
import type { Rng } from '#lib/fixtures/gen/rng.ts';

export const PRIOR_CYCLE_NAME = 'FY2025 Year-End';

/** Everyone hired on or after this date sat out the FY2025 cycle. */
const ELIGIBILITY_CUTOFF = '2026-01-01';

const RATING_VALUES = [1, 2, 3, 4, 5] as const;
const RATING_WEIGHTS = [2, 8, 40, 35, 15] as const;

/** Mean 4.75 over eight reports — comfortably above the 4.5 the README claims. */
const OUTLIER_PATTERN = [5, 5, 4, 5, 5, 5, 4, 5] as const;

export function generatePriorRatings(rng: Rng, workers: readonly Worker[]): PriorRating[] {
  const ratings: PriorRating[] = [];
  let outlierIndex = 0;
  for (const worker of workers) {
    if (worker.manager_id === null) continue;
    if (worker.start_date >= ELIGIBILITY_CUTOFF) continue;
    let rating: number;
    if (worker.manager_id === PINNED.outlier_manager) {
      rating = OUTLIER_PATTERN[outlierIndex % OUTLIER_PATTERN.length] ?? 5;
      outlierIndex += 1;
    } else {
      rating = rng.weighted(RATING_VALUES, RATING_WEIGHTS);
    }
    ratings.push({
      worker_id: worker.id,
      cycle_name: PRIOR_CYCLE_NAME,
      rating,
      rated_by_worker_id: worker.manager_id,
    });
  }
  return ratings;
}
