/**
 * lib/doctor/index.ts — public entry point for the cold-start doctor (block B0.5).
 *
 * Re-exports `checks.ts`, `run.ts` and `render.ts`. `bin/doctor.mjs` and tests import
 * from here so the internals can be split without touching call sites. Spec §5, §11.
 */

export {
  CHECK_IDS,
  CHECK_STATUSES,
  CHECKS,
  EXPECTED_MCP_SERVERS,
  MCP_CONFIG_FILENAME,
  checkAdapterMode,
  checkClock,
  checkFixturesSeeded,
  checkLoopStates,
  checkMcpServers,
  checkNodeVersion,
  checkRuntimeState,
  checkTenantPolicy,
  checkWriteDirs,
} from '#lib/doctor/checks.ts';
export type { Check, CheckFn, CheckStatus } from '#lib/doctor/checks.ts';

export { runDoctor, summarize } from '#lib/doctor/run.ts';
export type { DoctorReport, DoctorSummary } from '#lib/doctor/run.ts';

export { renderJson, renderText, STATUS_SYMBOLS } from '#lib/doctor/render.ts';
