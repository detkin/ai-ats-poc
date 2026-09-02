/**
 * lib/fixtures/gen/bands.ts — compensation bands, one per level × job function × location group.
 *
 * Owns: the salary scale the fixture tenant is built on, `generateBands`, and the helpers
 * the worker generator uses to price a person inside (or deliberately outside) their band.
 * The bands are Tier 1: the engine reads them and never copies them into `tl_*` state.
 *
 * Public interface: `generateBands`, `bandIdFor`, `findBandFor`, `BandIndex`, `indexBands`.
 *
 * Spec: docs/SPEC.md §3 (Tier 1), §8 loop 1 (compa-ratio); docs/PLAN.md §2.1.
 */

import { JOB_FUNCTIONS, LOCATION_GROUPS } from '#lib/types/tier1.ts';
import type { CompBand, JobFunction, Level, LocationGroup } from '#lib/types/tier1.ts';
import { LEVELS } from '#lib/fixtures/gen/catalog.ts';

/** USD band minimum by level rank. Ranks are comparable across tracks (docs/PLAN.md §2.1). */
const MIN_BY_RANK: Record<number, number> = {
  3: 110_000,
  4: 140_000,
  5: 175_000,
  6: 215_000,
  7: 255_000,
  8: 330_000,
};

/** People-management carries a small premium over the IC rank it maps to. */
const TRACK_MULTIPLIER: Record<string, number> = { IC: 1, M: 1.05, E: 1 };

const FUNCTION_MULTIPLIER: Record<JobFunction, number> = {
  engineering: 1,
  product: 0.97,
  design: 0.9,
  sales: 0.82,
  customer_success: 0.75,
  ga: 0.8,
};

/** Bangalore bands are quoted in INR on a local scale, not a converted US number. */
const INR_FACTOR = 24;

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** `band_L5_engineering_US` — level *name*, job function, location group. */
export function bandIdFor(level: Level, jobFunction: JobFunction, group: LocationGroup): string {
  return `band_${level.name}_${jobFunction}_${group}`;
}

/** Every combination exists, so every worker resolves to exactly one band. */
export function generateBands(): CompBand[] {
  const bands: CompBand[] = [];
  for (const level of LEVELS) {
    for (const jobFunction of JOB_FUNCTIONS) {
      for (const group of LOCATION_GROUPS) {
        const base = MIN_BY_RANK[level.rank] ?? 110_000;
        const track = TRACK_MULTIPLIER[level.track] ?? 1;
        const usdMin = base * track * FUNCTION_MULTIPLIER[jobFunction];
        const currency = group === 'IN' ? 'INR' : 'USD';
        const step = group === 'IN' ? 10_000 : 1_000;
        const scale = group === 'IN' ? INR_FACTOR : 1;
        const min = roundTo(usdMin * scale, step);
        bands.push({
          id: bandIdFor(level, jobFunction, group),
          level_id: level.id,
          job_function: jobFunction,
          location_group: group,
          currency,
          min,
          mid: roundTo(min * 1.18, step),
          max: roundTo(min * 1.42, step),
        });
      }
    }
  }
  return bands;
}

export type BandIndex = Map<string, CompBand>;

export function indexBands(bands: readonly CompBand[]): BandIndex {
  return new Map(bands.map((band) => [band.id, band]));
}

export function findBandFor(
  index: BandIndex,
  level: Level,
  jobFunction: JobFunction,
  group: LocationGroup,
): CompBand {
  const band = index.get(bandIdFor(level, jobFunction, group));
  if (!band) {
    throw new Error(`No band for ${level.name}/${jobFunction}/${group}`);
  }
  return band;
}
