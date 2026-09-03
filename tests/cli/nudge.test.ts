/**
 * tests/cli/nudge.test.ts — the policy gate, on one task at a time.
 *
 * The rule this file exists for: **there is no way to nudge somebody who is away.** The gate
 * is the engine's `policyCheckFor`, `bin/nudge.mjs` cannot bypass it, and a refusal is
 * recorded as a `tl_nudge` with `delivered: false` and the failing check rather than
 * disappearing (spec §4, §10).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import { NUDGE_SPEC, runNudge } from '#lib/cli/nudge.ts';
import type { TlNudge, TlNudgePolicyCheck, TlTask } from '#lib/types/engine.ts';
import {
  ANCHOR,
  OPEN_AT,
  cleanupDataDirs,
  readLedger,
  readOutbox,
  readState,
  runCli,
  runJson,
  seedDataDir,
  setNow,
} from '#tests/cli/helpers.ts';

/** The whole-company cycle: it is the one that contains the absent participants. */
const CYCLE = 'tl_cycle_h2_2026';

let dataDir: string;

const selfTaskOf = (workerId: string): TlTask => {
  const task = (readState<'task'>(dataDir, 'tasks.json') as TlTask[]).find(
    (row) =>
      row.cycle_id === CYCLE &&
      row.kind === 'write_self_review' &&
      row.participant_worker_id === workerId,
  );
  if (task === undefined) throw new Error(`no self-review task for ${workerId}`);
  return task;
};

/** Some other overdue task the same person owes — used to prove the gap is per person. */
const peerTaskOf = (workerId: string): string => {
  const task = (readState<'task'>(dataDir, 'tasks.json') as TlTask[]).find(
    (row) =>
      row.cycle_id === CYCLE &&
      row.kind === 'write_peer_review' &&
      row.participant_worker_id === workerId,
  );
  if (task === undefined) throw new Error(`no peer-review task for ${workerId}`);
  return task.id;
};

beforeAll(async () => {
  dataDir = seedDataDir();
  setNow(OPEN_AT);
  await runCli(CYCLE_SPEC, runCycle, ['open', '--cycle', CYCLE]);
});

afterAll(() => {
  cleanupDataDirs();
  delete process.env.TL_NOW;
  delete process.env.TL_DATA_DIR;
});

describe('nudge.mjs on an absent participant', () => {
  it('refuses, records the refusal, and leaves the task untouched', async () => {
    setNow(ANCHOR);
    const before = selfTaskOf('w_0009'); // abs_0001: approved PTO covering the anchor date
    const { run, data } = await runJson<TlNudge & { sent: boolean }>(NUDGE_SPEC, runNudge, [
      '--task',
      before.id,
    ]);

    expect(run.code).toBe(1);
    expect(data.sent).toBe(false);
    expect(data.delivered).toBe(false);
    expect(data.sent_at).toBeNull();
    expect(data.policy_check.absent).toBe(true);
    expect(data.policy_check.passed).toBe(false);
    expect(data.policy_check.reasons.some((reason) => reason.startsWith('absent'))).toBe(true);

    // Nothing was sent, and the task did not spend an attempt.
    expect(readOutbox(dataDir).some((line) => line.to_worker_id === 'w_0009')).toBe(false);
    const after = selfTaskOf('w_0009');
    expect(after.status).toBe('pending');
    expect(after.attempt_n).toBe(0);
    expect(after.due_at).toBe(before.due_at);
  });

  it('has no flag that bypasses the check', async () => {
    setNow(ANCHOR);
    const task = selfTaskOf('w_0009');
    const { run, data } = await runJson<{ policy_check: TlNudgePolicyCheck; sent: boolean }>(
      NUDGE_SPEC,
      runNudge,
      ['--task', task.id, '--force-policy-check'],
    );
    // --force-policy-check runs the gate and reports it; it never sends.
    expect(run.code).toBe(0);
    expect(data.sent).toBe(false);
    expect(data.policy_check.absent).toBe(true);
    expect(readOutbox(dataDir).some((line) => line.to_worker_id === 'w_0009')).toBe(false);
  });
});

describe('nudge.mjs on a present participant', () => {
  it('sends one DM covering everything the recipient owes, and moves those tasks', async () => {
    setNow(ANCHOR);
    // w_0021 is the HRBP in San Francisco: present, and 09:00 local at the anchor. At the
    // anchor they owe an overdue self review *and* overdue peer reviews, and one DM covers
    // the lot — one reminder per person, one cadence window per person (block B2.2).
    const before = selfTaskOf('w_0021');
    const { run, data } = await runJson<
      TlNudge & { sent: boolean; bundled_task_ids: string[]; nudge_ids: string[] }
    >(NUDGE_SPEC, runNudge, ['--task', before.id]);

    expect(run.code).toBe(0);
    expect(data.sent).toBe(true);
    expect(data.delivered).toBe(true);
    // The record reported is the one for the task that was named.
    expect(data.task_id).toBe(before.id);
    expect(data.attempt_n).toBe(before.attempt_n + 1);
    expect(data.channel).toBe('slack_dm');
    expect(data.policy_check.passed).toBe(true);

    // More than one task, so the bundle template; every bundled nudge shares the one DM.
    expect(data.bundled_task_ids).toContain(before.id);
    expect(data.bundled_task_ids.length).toBeGreaterThan(1);
    expect(data.template_id).toBe('nudge.multi.first');
    expect(data.nudge_ids.length).toBe(data.bundled_task_ids.length);
    expect(
      readOutbox(dataDir).filter((line) => line.message_ref === data.message_ref),
    ).toHaveLength(1);

    const after = selfTaskOf('w_0021');
    expect(after.status).toBe('nudged');
    expect(after.attempt_n).toBe(1);
    expect(after.nudged_at).toBe(ANCHOR);

    const line = readOutbox(dataDir).find((entry) => entry.message_ref === data.message_ref);
    expect(line?.to_worker_id).toBe('w_0021');
    expect(line?.text).toContain('H2 2026 Mid-Year Review');
    expect(line?.text).not.toContain('{{');

    const ledger = readLedger(dataDir);
    expect(
      ledger.some(
        (entry) =>
          entry.port === 'channel' &&
          entry.function === 'sendDirect' &&
          entry.result_ref === data.message_ref,
      ),
    ).toBe(true);
    expect(ledger.some((entry) => entry.result_ref === data.id)).toBe(true);
  });

  it('honours --template', async () => {
    // 2026-09-08 is a Tuesday: past nudge_min_gap_hours, not a weekend, not Labor Day.
    setNow('2026-09-08T16:00:00Z');
    const task = selfTaskOf('w_0021');
    const { run, data } = await runJson<TlNudge>(NUDGE_SPEC, runNudge, [
      '--task',
      task.id,
      '--template',
      'nudge.write_self_review.followup',
    ]);
    expect(run.code).toBe(0);
    expect(data.template_id).toBe('nudge.write_self_review.followup');
    expect(data.attempt_n).toBe(2);
  });

  it('reports a missing template as a domain failure rather than sending blank text', async () => {
    // Thursday 2026-09-10, 48 h past the previous reminder: the gate passes and the render
    // is what fails — nothing is sent, and no attempt is spent.
    setNow('2026-09-10T16:00:00Z');
    const task = selfTaskOf('w_0021');
    const outboxBefore = readOutbox(dataDir).length;
    const run = await runCli(NUDGE_SPEC, runNudge, [
      '--task',
      task.id,
      '--template',
      'nudge.does_not_exist',
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no message template at');
    expect(readOutbox(dataDir)).toHaveLength(outboxBefore);
  });

  it('reports an unknown task id', async () => {
    setNow(ANCHOR);
    const run = await runCli(NUDGE_SPEC, runNudge, ['--task', 'tl_task_nope']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no task with id "tl_task_nope"');
  });

  it('narrows to one task with --only-this-task', async () => {
    // Friday 2026-09-11, 09:00 in San Francisco — three days past the last reminder.
    setNow('2026-09-11T16:00:00Z');
    const task = selfTaskOf('w_0021');
    const { run, data } = await runJson<
      TlNudge & { bundled_task_ids: string[]; nudge_ids: string[] }
    >(NUDGE_SPEC, runNudge, ['--task', task.id, '--only-this-task']);

    expect(run.code).toBe(0);
    expect(data.bundled_task_ids).toEqual([task.id]);
    expect(data.nudge_ids).toHaveLength(1);
    expect(data.template_id).toBe('nudge.write_self_review.followup');
    // And the rest of w_0021's work is silent for the whole cadence window all the same:
    // the gap is measured per person (docs/DECISIONS.md D17).
    const blocked = await runJson<TlNudge>(NUDGE_SPEC, runNudge, ['--task', peerTaskOf('w_0021')]);
    expect(blocked.run.code).toBe(1);
    expect(blocked.data.policy_check.reasons).toContain('nudge_gap_not_elapsed');
  });
});

describe('nudge.mjs and quiet hours', () => {
  it('refuses outside the recipient location work hours', async () => {
    // 2026-09-11T04:00Z is 21:00 on Thursday 2026-09-10 in San Francisco.
    setNow('2026-09-11T04:00:00Z');
    const task = selfTaskOf('w_0021');
    const { run, data } = await runJson<TlNudge>(NUDGE_SPEC, runNudge, ['--task', task.id]);
    expect(run.code).toBe(1);
    expect(data.delivered).toBe(false);
    expect(data.policy_check.quiet_hours).toBe(true);
    expect(data.policy_check.reasons.some((reason) => reason.startsWith('quiet_hours'))).toBe(true);
  });
});

describe('cycle records after the refusals', () => {
  it('keeps every refusal on record with its own policy_check', () => {
    const nudges = (readState<'nudge'>(dataDir, 'nudges.json') as TlNudge[]).filter(
      (nudge) => nudge.cycle_id === CYCLE,
    );
    const refused = nudges.filter((nudge) => !nudge.delivered);
    expect(refused.length).toBeGreaterThanOrEqual(2);
    for (const nudge of refused) {
      expect(nudge.sent_at).toBeNull();
      expect(nudge.policy_check.passed).toBe(false);
      expect(nudge.policy_check.reasons.length).toBeGreaterThan(0);
    }
  });
});
