/**
 * lib/fixtures/index.ts — one import for the fixture tenant.
 *
 * Owns: nothing; re-exports the generator (`generateTenant`), the writer (`writeTenant`,
 * manifest helpers), the loader (`loadTenant`, `verifyManifest`, `FixtureError`) and the
 * file-name maps adapters need (`TIER1_FILES`, `STATE_FILES`, `STATE_FILE_BY_KIND`).
 *
 * Spec: docs/PLAN.md §2.1, §2.7, §2.8, §3 block B0.4.
 */

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
  generateTenant,
} from '#lib/fixtures/generate.ts';
export type { TenantBundle, TenantState } from '#lib/fixtures/generate.ts';
export type { CalendarBusyRow } from '#lib/fixtures/gen/bundle.ts';

export { buildManifest, hashBytes, serializeJson, writeTenant } from '#lib/fixtures/write.ts';
export type { FixtureManifest, ManifestEntry, WriteOptions } from '#lib/fixtures/write.ts';

export {
  FixtureError,
  defaultFixturesDir,
  loadTenant,
  readManifest,
  resolveFixturesDir,
  verifyManifest,
} from '#lib/fixtures/load.ts';
export type { ManifestVerification } from '#lib/fixtures/load.ts';

export {
  CALENDAR_WEEK,
  STAFF_ENG_DECLINER,
  STAFF_ENG_PANEL,
  STAFF_ENG_SLOT,
  STAFF_ENG_SUBSTITUTE,
  generateCalendarBusy,
} from '#lib/fixtures/gen/calendar.ts';
export { PINNED } from '#lib/fixtures/gen/catalog.ts';
export { REQ_IDS, INJECTED_RESUME_CANDIDATES } from '#lib/fixtures/gen/hiring.ts';
export { PRIOR_CYCLE_NAME } from '#lib/fixtures/gen/ratings.ts';
export { REVIEW_CYCLE_ID } from '#lib/fixtures/gen/state.ts';
