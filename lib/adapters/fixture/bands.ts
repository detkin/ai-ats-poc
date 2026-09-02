/**
 * lib/adapters/fixture/bands.ts — compensation bands over the fixture tenant.
 *
 * Owns: `FixtureBandsAdapter`. The only place a compa-ratio is computed:
 * `base_annual / band.mid`, rounded to three decimals, `null` when no band matches the
 * worker's (level, job function, location group). The engine reads this every tick and never
 * stores it — a stored compa-ratio would be a Tier-1 value in Tier-2 state (spec §3).
 *
 * Public interface: `FixtureBandsAdapter` (implements `BandsPort`), `compaRatio`.
 *
 * Rippling calls this stands in for: REST GET /compensation-bands and
 * GET /workers/{id}?expand=compensation. Compensation is REST-only; the MCP redacts pay.
 *
 * Spec: docs/SPEC.md §2, §8 loop 1; docs/PLAN.md §2.3.
 */

import type { TenantBundle } from '#lib/fixtures/index.ts';
import type { BandQuery, BandsPort, WorkerCompensation } from '#lib/ports/bands.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type { CompBand, WorkerId } from '#lib/types/tier1.ts';

/** `base_annual / band.mid`, rounded to 3 decimal places. */
export function compaRatio(baseAnnual: number, bandMid: number): number | null {
  if (!Number.isFinite(baseAnnual) || !Number.isFinite(bandMid) || bandMid === 0) return null;
  return Math.round((baseAnnual / bandMid) * 1000) / 1000;
}

export class FixtureBandsAdapter implements BandsPort {
  private readonly bundle: TenantBundle;

  constructor(bundle: TenantBundle) {
    this.bundle = bundle;
  }

  async listBands(): Promise<CompBand[]> {
    return this.bundle.comp_bands.map((b) => ({ ...b }));
  }

  async findBand(q: BandQuery): Promise<CompBand | null> {
    const found = this.bundle.comp_bands.find(
      (b) =>
        b.level_id === q.level_id &&
        b.job_function === q.job_function &&
        b.location_group === q.location_group,
    );
    return found === undefined ? null : { ...found };
  }

  /**
   * The worker's own pay plus where it sits in their band. Throws when the worker id is
   * unknown — a caller asking about a non-existent worker is a bug, not an empty answer.
   */
  async getWorkerCompensation(workerId: WorkerId): Promise<WorkerCompensation> {
    const worker = this.bundle.workers.find((w) => w.id === workerId);
    if (worker === undefined) {
      throw new TalentLoopsError('WORKER_NOT_FOUND', `no worker "${workerId}" in the fixtures`);
    }
    const location = this.bundle.locations.find((l) => l.id === worker.location_id);
    const band =
      location === undefined
        ? undefined
        : this.bundle.comp_bands.find(
            (b) =>
              b.level_id === worker.level_id &&
              b.job_function === worker.job_function &&
              b.location_group === location.location_group,
          );

    return {
      base_annual: worker.compensation.base_annual,
      currency: worker.compensation.currency,
      band_id: band === undefined ? null : band.id,
      compa_ratio:
        band === undefined ? null : compaRatio(worker.compensation.base_annual, band.mid),
    };
  }
}
