/**
 * lib/cli/doctor.ts — the cold-start health check, as a CLI (blocks B0.5, B1.5).
 *
 * Owns: `DOCTOR_SPEC` and `runDoctor`, the thin wrapper that turns `lib/doctor/*`'s report
 * into a `CliOutput`. All the checking lives in `#lib/doctor/index.ts`; all the parsing,
 * `--help` and exit codes live in `lib/cli/runtime.ts`. That leaves `bin/doctor.mjs` the
 * same three lines as the other nine CLIs (docs/DECISIONS.md D11; M1 tester defect D-3).
 *
 * Exit codes here differ from the house contract in one place, on purpose:
 *
 *   0  every check is `ok` or `warn`
 *   1  at least one check `fail`s — **and** an invalid `TL_*` environment, which for every
 *      other CLI is exit 2. Doctor is the tool you run *because* the environment might be
 *      wrong; "not ready" is its domain answer, not a usage error. A bad *argument* is still
 *      exit 2, from `runCli`.
 *
 * Public interface: `DOCTOR_SPEC`, `runDoctor`.
 *
 * Spec: docs/SPEC.md §5, §11; docs/PLAN.md §2.9, §4 block B0.5.
 */

import type { Args, CliSpec } from '#lib/cli/args.ts';
import { fail, ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { CliError } from '#lib/cli/runtime.ts';
import { ConfigError, loadConfig } from '#lib/config.ts';
import type { Config } from '#lib/config.ts';
import { renderJson, renderText, runDoctor as runChecks } from '#lib/doctor/index.ts';

export const DOCTOR_SPEC: CliSpec = {
  name: 'doctor.mjs',
  summary: 'cold-start health check: node, adapter, tenant policy, fixtures, write dirs, MCP',
  usage: ['bin/doctor.mjs [--json]'],
  flags: [],
  notes: [
    'Reports whether this checkout can run a Talent Loops tick. --json prints\n' +
      '{ ok, summary: { ok, warn, fail }, checks: [{ id, status, detail, fix? }] }.',
    'Exit 0 healthy (ok/warn only); 1 at least one failing check, or an invalid TL_*\n' +
      'environment; 2 a bad argument.',
    'Environment: TL_ADAPTER TL_NOW TL_DATA_DIR TL_TENANT_DIR TL_FIXTURES_DIR TL_ACTOR\n' +
      'TL_LOCK_STALE_MS',
  ],
};

/** `loadConfig`, but a bad environment is doctor's own domain failure (exit 1). */
function configOrDomainFailure(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new CliError('BAD_ENVIRONMENT', `invalid environment — ${error.message}`);
    }
    throw error;
  }
}

export async function runDoctor(_args: Args): Promise<CliOutput> {
  const config = configOrDomainFailure();
  const report = await runChecks(config);
  // The `--json` shape is a contract owned by `lib/doctor/render.ts`; reuse it rather than
  // restating it here, so the two can never drift.
  const data: unknown = JSON.parse(renderJson(report));
  const lines = renderText(report, config).split('\n');
  return report.ok ? ok(data, lines) : fail(data, lines);
}
