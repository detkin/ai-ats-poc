/**
 * lib/ports/bands.ts — compensation bands and a worker's position in them (Tier 1, read-only).
 *
 * Owns: `BandsPort`. Used by the calibration packet (compa-ratio as an observation) and by
 * the offer band check. The engine never stores a band or a salary — it re-reads them.
 *
 * Public interface: `BandsPort`, `BandQuery`, `WorkerCompensation`.
 *
 * Rippling backing (research 06 — compensation is REST-only; MCP redacts pay):
 *   listBands / findBand      -> REST GET /compensation-bands
 *   getWorkerCompensation     -> REST GET /workers/{id}?expand=compensation
 *
 * Spec: docs/SPEC.md §2, §8 loop 1 and loop 3; docs/PLAN.md §2.3.
 */

import type {
  CompBand,
  CompBandId,
  Currency,
  JobFunction,
  LevelId,
  LocationGroup,
  WorkerId,
} from '#lib/types/tier1.ts';

export interface BandQuery {
  level_id: LevelId;
  job_function: JobFunction;
  location_group: LocationGroup;
}

/**
 * A worker's pay and where it sits in their band.
 *
 * Every field is nullable because compensation is not always readable: the Rippling MCP
 * redacts pay outright, so a `bridge` tenant (docs/PLAN.md §8) answers all-nulls rather than
 * a plausible zero. A caller that renders pay must handle `null` and say so.
 */
export interface WorkerCompensation {
  base_annual: number | null;
  currency: Currency | null;
  band_id: CompBandId | null;
  /** base_annual / band.mid, or null when no band matches or no pay is readable. */
  compa_ratio: number | null;
}

export interface BandsPort {
  listBands(): Promise<CompBand[]>;
  findBand(q: BandQuery): Promise<CompBand | null>;
  getWorkerCompensation(workerId: WorkerId): Promise<WorkerCompensation>;
}
