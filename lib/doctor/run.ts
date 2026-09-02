/**
 * lib/doctor/run.ts — run every cold-start check and summarize (block B0.5).
 *
 * Owns: the orchestration half of `bin/doctor.mjs`. It runs the checks in
 * `lib/doctor/checks.ts` in report order, tolerates a check that throws (that
 * becomes a `fail`, so one broken input never hides the other eight answers), and
 * reduces the results to one boolean the CLI turns into an exit code.
 * Spec §5 (`doctor.mjs` row), §11; plan §2.5–2.7.
 *
 * Public interface:
 *   DoctorSummary                 -- { ok, warn, fail } counts
 *   DoctorReport                  -- { ok, checks, summary }
 *   runDoctor(config)             -- Promise<DoctorReport>
 *   summarize(checks)             -- the same reduction, exposed for tests
 *
 * `report.ok` is false exactly when at least one check is `fail`; `warn` never
 * blocks a run (an unconnected MCP in fixture mode is expected, not broken).
 */

import type { Config } from '#lib/config.ts';
import type { Check, CheckFn } from '#lib/doctor/checks.ts';
import { CHECKS } from '#lib/doctor/checks.ts';

export interface DoctorSummary {
  readonly ok: number;
  readonly warn: number;
  readonly fail: number;
}

export interface DoctorReport {
  /** False iff any check is `fail`. `bin/doctor.mjs` exits 1 when false. */
  readonly ok: boolean;
  readonly checks: readonly Check[];
  readonly summary: DoctorSummary;
}

/** Count checks by status. */
export function summarize(checks: readonly Check[]): DoctorSummary {
  let okCount = 0;
  let warnCount = 0;
  let failCount = 0;
  for (const check of checks) {
    if (check.status === 'ok') okCount += 1;
    else if (check.status === 'warn') warnCount += 1;
    else failCount += 1;
  }
  return { ok: okCount, warn: warnCount, fail: failCount };
}

/** A check that throws is a bug; surface it as a fail rather than losing the report. */
async function runOne(check: CheckFn, config: Config): Promise<Check> {
  try {
    return await check(config);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      id: check.name === '' ? 'unknown_check' : check.name,
      status: 'fail',
      detail: `check threw unexpectedly: ${detail}`,
      fix: 'report this: a doctor check must return a fail, never throw',
    };
  }
}

/**
 * Run the full cold-start report.
 * @param checks injection point for tests; defaults to the shipped ordered list.
 */
export async function runDoctor(
  config: Config,
  checks: readonly CheckFn[] = CHECKS,
): Promise<DoctorReport> {
  const results: Check[] = [];
  for (const check of checks) {
    results.push(await runOne(check, config));
  }
  const summary = summarize(results);
  return { ok: summary.fail === 0, checks: results, summary };
}
