/**
 * tests/cli/help.test.ts — every CLI answers `--help` with 0 and lists its own flags.
 *
 * Block B1.4's `tests/modes/consistency.test.ts` asserts that each flag a mode file names
 * appears in that CLI's `--help`. This is the other half of that contract: the help text is
 * generated from the spec, so a flag can never exist without being documented.
 */

import { describe, expect, it } from 'vitest';

import { flagsOf } from '#lib/cli/args.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { AUDIT_SPEC, runAudit } from '#lib/cli/audit.ts';
import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import { DECIDE_SPEC, runDecide } from '#lib/cli/decide.ts';
import { DOCTOR_SPEC, runDoctor } from '#lib/cli/doctor.ts';
import { NUDGE_SPEC, runNudge } from '#lib/cli/nudge.ts';
import { PACKET_SPEC, runPacket } from '#lib/cli/packet.ts';
import { PROPOSE_SPEC, runPropose } from '#lib/cli/propose.ts';
import { SEED_SPEC, runSeed } from '#lib/cli/seed.ts';
import { TICK_SPEC, runTick } from '#lib/cli/tick.ts';
import { VERIFY_SPEC, runVerify } from '#lib/cli/verify.ts';
import { runCli } from '#tests/cli/helpers.ts';

const CLIS: [CliSpec, (args: Args) => Promise<CliOutput>][] = [
  [TICK_SPEC, runTick],
  [CYCLE_SPEC, runCycle],
  [PROPOSE_SPEC, runPropose],
  [DECIDE_SPEC, runDecide],
  [NUDGE_SPEC, runNudge],
  [PACKET_SPEC, runPacket],
  [AUDIT_SPEC, runAudit],
  [VERIFY_SPEC, runVerify],
  [SEED_SPEC, runSeed],
  [DOCTOR_SPEC, runDoctor],
];

for (const [spec, handler] of CLIS) {
  describe(`${spec.name} --help`, () => {
    it('exits 0 and lists every flag, the usage and the exit codes', async () => {
      const run = await runCli(spec, handler, ['--help']);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      for (const flag of flagsOf(spec)) {
        expect(run.stdout).toContain(`--${flag.name}`);
      }
      for (const usage of spec.usage) {
        expect(run.stdout).toContain(usage.split(' ')[0] ?? '');
      }
      for (const sub of spec.subcommands ?? []) {
        expect(run.stdout).toContain(sub.name);
      }
      expect(run.stdout).toContain('Exit codes:');
    });

    it('rejects an unknown flag with a usage exit code', async () => {
      const usageExit = spec.name === 'seed.mjs' ? 1 : 2;
      const run = await runCli(spec, handler, ['--definitely-not-a-flag'], usageExit);
      expect(run.code).toBe(usageExit);
      expect(run.stderr).toContain('unknown argument');
    });
  });
}
