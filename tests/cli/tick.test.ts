/**
 * tests/cli/tick.test.ts — the cadence rules, on a cycle small enough to count by hand.
 *
 * `review-cycle.test.ts` runs the whole-company demo at the fixture anchor, where the self
 * reviews are already nine days late and the first tick both reminds and escalates. This
 * file walks the *other* path — the one the policy is actually written for: a reminder, then
 * silence until `nudge_min_gap_hours` has passed, then a second reminder, then escalation
 * once `after_attempts` is reached. It also covers the lock and `--dry-run`.
 *
 * Policy under test (tenant/policy.yml): nudge_min_gap_hours 48, max_attempts 3,
 * escalation.after_attempts 2, escalation.overdue_days 3.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import { TICK_SPEC, runTick } from '#lib/cli/tick.ts';
import type { TickResult } from '#lib/cli/tick.ts';
import { acquireLock } from '#lib/lock.ts';
import type { TlCycle, TlNudge, TlProposedAction, TlTask } from '#lib/types/engine.ts';
import {
  OPEN_AT,
  cleanupDataDirs,
  readOutbox,
  readState,
  runCli,
  runJson,
  seedDataDir,
  setNow,
} from '#tests/cli/helpers.ts';

let dataDir: string;
let cycleId: string;

const designTasks = (): TlTask[] =>
  (readState<'task'>(dataDir, 'tasks.json') as TlTask[]).filter(
    (task) => task.cycle_id === cycleId,
  );
const selfTasks = (): TlTask[] => designTasks().filter((task) => task.kind === 'write_self_review');

async function tick(now: string, extra: string[] = []): Promise<TickResult> {
  setNow(now);
  const { data } = await runJson<TickResult>(TICK_SPEC, runTick, ['--cycle', cycleId, ...extra]);
  return data;
}

beforeAll(async () => {
  dataDir = seedDataDir();
  setNow(OPEN_AT);
  const { data } = await runJson<TlCycle>(CYCLE_SPEC, runCycle, [
    'create',
    '--type',
    'review',
    '--name',
    'Design H2 2026',
    '--owner',
    'w_0021',
    '--department',
    'dept_design',
    '--deadline',
    '2026-09-18',
  ]);
  cycleId = data.id;
  await runCli(CYCLE_SPEC, runCycle, ['open', '--cycle', cycleId]);
});

afterAll(() => {
  cleanupDataDirs();
  delete process.env.TL_NOW;
  delete process.env.TL_DATA_DIR;
});

describe('tick cadence', () => {
  it('reminds nobody on the day the tasks fall due', async () => {
    const result = await tick('2026-08-24T16:00:00Z');
    // The only thing the first tick has to do is assemble the packet nothing has assembled yet.
    expect(result.actions.map((action) => action.kind)).toEqual(['refresh_packet']);
    expect(readOutbox(dataDir)).toEqual([]);
  });

  it('sends a first reminder once the self reviews are overdue', async () => {
    const result = await tick('2026-08-26T16:00:00Z');
    expect(result.changed).toBe(true);
    expect(result.escalations).toBe(0);

    const nudges = result.actions.filter((action) => action.kind === 'nudge');
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges.every((action) => action.attempt_n === 1)).toBe(true);
    expect(nudges.every((action) => action.template_id === 'nudge.write_self_review.first')).toBe(
      true,
    );
    expect(readOutbox(dataDir)).toHaveLength(nudges.length);

    // Quiet hours are respected: the Bangalore participants are not reminded at 21:30 local.
    const overdue = selfTasks().length;
    expect(nudges.length).toBeLessThan(overdue);
  });

  it('stays silent until nudge_min_gap_hours has passed', async () => {
    const before = readOutbox(dataDir).length;
    const result = await tick('2026-08-27T16:00:00Z');
    expect(result.actions.filter((action) => action.kind === 'nudge')).toEqual([]);
    expect(readOutbox(dataDir)).toHaveLength(before);
  });

  it('sends a follow-up after the gap, and escalates once attempts are used up', async () => {
    const result = await tick('2026-08-28T16:00:00Z');
    const nudges = result.actions.filter((action) => action.kind === 'nudge');
    expect(nudges.every((action) => action.attempt_n === 2)).toBe(true);
    expect(
      nudges.every((action) => action.template_id === 'nudge.write_self_review.followup'),
    ).toBe(true);

    expect(result.escalations).toBe(1);
    const proposals = (
      readState<'proposed_action'>(dataDir, 'proposed_actions.json') as TlProposedAction[]
    ).filter((proposal) => proposal.cycle_id === cycleId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe('escalate');
    expect(proposals[0]?.status).toBe('proposed');
    expect(proposals[0]?.payload.to_worker_id).toBe('w_0021');

    const escalated = designTasks().filter((task) => task.status === 'escalated');
    expect(escalated.length).toBeGreaterThan(0);
    for (const task of escalated) expect(proposals[0]?.evidence_refs).toContain(task.id);

    const cycle = readState<'cycle'>(dataDir, 'cycles.json').find((row) => row.id === cycleId);
    expect(cycle?.status).toBe('escalated');
  });

  it('raises no second escalation while the first is undecided', async () => {
    const result = await tick('2026-08-31T16:00:00Z');
    expect(result.escalations).toBe(0);
    expect(result.changed).toBe(false);
    const proposals = (
      readState<'proposed_action'>(dataDir, 'proposed_actions.json') as TlProposedAction[]
    ).filter((proposal) => proposal.cycle_id === cycleId);
    expect(proposals).toHaveLength(1);
  });

  it('never exceeds max_attempts on any task', () => {
    const nudges = (readState<'nudge'>(dataDir, 'nudges.json') as TlNudge[]).filter(
      (nudge) => nudge.cycle_id === cycleId,
    );
    const attempts = new Map<string, number>();
    for (const nudge of nudges) {
      attempts.set(nudge.task_id, Math.max(attempts.get(nudge.task_id) ?? 0, nudge.attempt_n));
    }
    for (const [, attempt] of attempts) expect(attempt).toBeLessThanOrEqual(3);
    expect(designTasks().every((task) => task.attempt_n <= 3)).toBe(true);
  });
});

describe('tick guards', () => {
  it('--dry-run reports the plan and writes nothing', async () => {
    // Move the clock far enough forward that the peer reviews are overdue too.
    setNow('2026-09-10T16:00:00Z');
    const outboxBefore = readOutbox(dataDir).length;
    const { data } = await runJson<TickResult>(TICK_SPEC, runTick, [
      '--cycle',
      cycleId,
      '--dry-run',
    ]);
    expect(data.dry_run).toBe(true);
    expect(data.changed).toBe(true);
    expect(data.actions.length).toBeGreaterThan(0);
    expect(readOutbox(dataDir)).toHaveLength(outboxBefore);
    expect(
      designTasks().filter((task) => task.status === 'nudged' && task.attempt_n === 3),
    ).toEqual([]);
  });

  it('refuses to tick a cycle somebody else has locked', async () => {
    setNow('2026-09-10T16:00:00Z');
    // The other holder is on the same frozen clock the tick uses, so it is not stale.
    const lock = acquireLock(dataDir, cycleId, {
      owner: 'another-tick',
      staleMs: 600_000,
      now: () => new Date(Date.parse('2026-09-10T16:00:00Z')),
    });
    try {
      const run = await runCli(TICK_SPEC, runTick, ['--cycle', cycleId]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('is locked by another-tick');
    } finally {
      lock.release();
    }
  });

  it('reports an unknown cycle as a domain failure and releases the lock', async () => {
    setNow('2026-09-10T16:00:00Z');
    const run = await runCli(TICK_SPEC, runTick, ['--cycle', 'tl_cycle_nope']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no cycle with id "tl_cycle_nope"');
    // The lock directory is gone, so a retry is not blocked by the failure.
    const retry = acquireLock(dataDir, 'tl_cycle_nope', {
      staleMs: 600_000,
      now: () => new Date(Date.parse('2026-09-10T16:00:00Z')),
    });
    retry.release();
  });
});
