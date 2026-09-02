/**
 * lib/fixtures/generate.ts — the whole fixture tenant, from one integer.
 *
 * Owns: `generateTenant(seed)`, a pure function that assembles the Acme Robotics fixture
 * tenant — ~120 workers across six departments, comp bands, a headcount plan, four
 * requisitions, forty candidates with résumés, an absence table anchored on
 * 2026-09-02, prior-cycle ratings and one configured review cycle. It performs no I/O;
 * `lib/fixtures/write.ts` puts the result on disk and `lib/fixtures/load.ts` reads it back.
 *
 * Determinism is the contract: the PRNG is consumed in exactly the order below, so two
 * calls with the same seed are deep-equal and `bin/seed.mjs --verify` can hash-compare a
 * fresh run against the committed files.
 *
 * Public interface: `generateTenant`, plus re-exports of `TenantBundle` and the file maps.
 *
 * Spec: docs/SPEC.md §5 (fixture tenant), §8 (the demo scenarios the data must support);
 * docs/PLAN.md §2.1, §2.7, §2.8, §3 block B0.4.
 */

import { DEFAULT_SEED } from '#lib/fixtures/gen/bundle.ts';
import type { TenantBundle } from '#lib/fixtures/gen/bundle.ts';
import { generateBands } from '#lib/fixtures/gen/bands.ts';
import { LEVELS, LOCATIONS } from '#lib/fixtures/gen/catalog.ts';
import {
  HEADCOUNT_POSITIONS,
  REQUISITIONS,
  generateApplications,
  generateCandidates,
} from '#lib/fixtures/gen/hiring.ts';
import { generatePeople } from '#lib/fixtures/gen/people.ts';
import { generatePriorRatings } from '#lib/fixtures/gen/ratings.ts';
import { generateResumes } from '#lib/fixtures/gen/resumes.ts';
import { makeRng } from '#lib/fixtures/gen/rng.ts';
import { IDENTITIES, generateSeedState } from '#lib/fixtures/gen/state.ts';
import { LEAVE_TYPES, generateAbsences, generateHolidays } from '#lib/fixtures/gen/time-off.ts';

export {
  ANCHOR_DATE,
  ANCHOR_NOW,
  DEFAULT_SEED,
  GENERATOR_VERSION,
  LEDGER_FILE,
  MANIFEST_FILE,
  STATE_FILES,
  STATE_FILE_BY_KIND,
  TIER1_FILES,
} from '#lib/fixtures/gen/bundle.ts';
export type { TenantBundle, TenantState } from '#lib/fixtures/gen/bundle.ts';

/**
 * Build the tenant. Same seed in, byte-identical tenant out — nothing here reads the
 * clock, the filesystem, the environment or `Math.random`.
 */
export function generateTenant(seed: number = DEFAULT_SEED): TenantBundle {
  const rng = makeRng(seed);

  const comp_bands = generateBands();
  const { workers, departments, teams } = generatePeople(rng, comp_bands);
  const prior_ratings = generatePriorRatings(rng, workers);
  const candidates = generateCandidates(rng);
  const applications = generateApplications(rng);
  const resumes = generateResumes(rng, candidates, applications);

  return {
    workers,
    departments,
    teams,
    levels: LEVELS.map((level) => ({ ...level })),
    locations: LOCATIONS.map((location) => ({
      ...location,
      work_hours: { ...location.work_hours },
    })),
    comp_bands,
    headcount_positions: HEADCOUNT_POSITIONS.map((position) => ({ ...position })),
    job_requisitions: REQUISITIONS.map((req) => ({ ...req, criteria: [...req.criteria] })),
    candidates,
    applications,
    absences: generateAbsences(),
    leave_types: LEAVE_TYPES.map((type) => ({ ...type })),
    holidays: generateHolidays(),
    prior_ratings,
    identities: IDENTITIES.map((identity) => ({
      ...identity,
      permissions: [...identity.permissions],
    })),
    resumes,
    state: generateSeedState(),
  };
}
