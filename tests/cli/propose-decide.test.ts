/**
 * tests/cli/propose-decide.test.ts — the decision-of-record seam (spec §9).
 *
 * Two claims are under test. First, `propose.mjs` is the only writer of a
 * `tl_proposed_action`, and it validates hard: an unknown kind and a non-object payload are
 * *usage* failures (exit 2), not records. Second, `decide.mjs` will not record a decision
 * signed by somebody who is not an ACTIVE worker, and a decision is a record — approving an
 * escalation does not waive the tasks it bundled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import { DECIDE_SPEC, runDecide } from '#lib/cli/decide.ts';
import { PROPOSE_SPEC, runPropose } from '#lib/cli/propose.ts';
import { TICK_SPEC, runTick } from '#lib/cli/tick.ts';
import type { TickResult } from '#lib/cli/tick.ts';
import type { TlCycle, TlProposedAction, TlTask } from '#lib/types/engine.ts';
import {
  OPEN_AT,
  cleanupDataDirs,
  readState,
  runCli,
  runJson,
  seedDataDir,
  setNow,
} from '#tests/cli/helpers.ts';

let dataDir: string;
let cycleId: string;
let escalation: TlProposedAction;

const proposals = (): TlProposedAction[] =>
  (readState<'proposed_action'>(dataDir, 'proposed_actions.json') as TlProposedAction[]).filter(
    (proposal) => proposal.cycle_id === cycleId,
  );

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

  // Tick far enough forward that the engine raises exactly one escalation.
  setNow('2026-09-02T16:00:00Z');
  const tick = await runJson<TickResult>(TICK_SPEC, runTick, ['--cycle', cycleId]);
  expect(tick.data.escalations).toBe(1);
  const found = proposals().find((proposal) => proposal.kind === 'escalate');
  if (found === undefined) throw new Error('the tick did not record an escalation');
  escalation = found;
});

afterAll(() => {
  cleanupDataDirs();
  delete process.env.TL_NOW;
  delete process.env.TL_DATA_DIR;
});

describe('propose.mjs', () => {
  it('records a proposal in `proposed` with the evidence it was given', async () => {
    setNow('2026-09-02T16:00:00Z');
    const taskId = (readState<'task'>(dataDir, 'tasks.json') as TlTask[]).find(
      (task) => task.cycle_id === cycleId,
    )?.id;
    const { run, data } = await runJson<TlProposedAction>(PROPOSE_SPEC, runPropose, [
      '--cycle',
      cycleId,
      '--kind',
      'reach_out',
      '--payload',
      '{"worker_id":"w_0071"}',
      '--rationale',
      'no reply on two reminders',
      '--evidence',
      `${taskId},${escalation.id}`,
    ]);

    expect(run.code).toBe(0);
    expect(data.id).toMatch(/^tl_proposed_action_[0-9a-f]{8}$/);
    expect(data.status).toBe('proposed');
    expect(data.kind).toBe('reach_out');
    expect(data.payload).toEqual({ worker_id: 'w_0071' });
    expect(data.evidence_refs).toEqual([taskId, escalation.id]);
    expect(data.created_by).toBe('w_0021');
    expect(data.decided_by).toBeUndefined();
  });

  it('attributes the proposal to --by when given', async () => {
    setNow('2026-09-02T16:00:00Z');
    const { data } = await runJson<TlProposedAction>(PROPOSE_SPEC, runPropose, [
      '--cycle',
      cycleId,
      '--kind',
      'move_due_date',
      '--payload',
      '{}',
      '--rationale',
      'requested in standup',
      '--evidence',
      escalation.id,
      '--by',
      'w_0007',
    ]);
    expect(data.created_by).toBe('w_0007');
  });

  it('rejects an unknown kind as a usage error, writing nothing', async () => {
    setNow('2026-09-02T16:00:00Z');
    const before = proposals().length;
    const run = await runCli(PROPOSE_SPEC, runPropose, [
      '--cycle',
      cycleId,
      '--kind',
      'fire_everyone',
      '--payload',
      '{}',
      '--rationale',
      'x',
      '--evidence',
      escalation.id,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('is not a proposal kind');
    expect(proposals()).toHaveLength(before);
  });

  it('rejects a payload that is not a JSON object, and empty evidence', async () => {
    setNow('2026-09-02T16:00:00Z');
    const badPayload = await runCli(PROPOSE_SPEC, runPropose, [
      '--cycle',
      cycleId,
      '--kind',
      'reach_out',
      '--payload',
      '[1,2]',
      '--rationale',
      'x',
      '--evidence',
      escalation.id,
    ]);
    expect(badPayload.code).toBe(2);
    expect(badPayload.stderr).toContain('must be a JSON object');

    const noEvidence = await runCli(PROPOSE_SPEC, runPropose, [
      '--cycle',
      cycleId,
      '--kind',
      'reach_out',
      '--payload',
      '{}',
      '--rationale',
      'x',
    ]);
    expect(noEvidence.code).toBe(2);
    expect(noEvidence.stderr).toContain('--evidence needs at least one record id');
  });

  it('rejects an unknown cycle', async () => {
    setNow('2026-09-02T16:00:00Z');
    const run = await runCli(PROPOSE_SPEC, runPropose, [
      '--cycle',
      'tl_cycle_nope',
      '--kind',
      'reach_out',
      '--payload',
      '{}',
      '--rationale',
      'x',
      '--evidence',
      'tl_task_1',
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no cycle with id "tl_cycle_nope"');
  });
});

describe('decide.mjs', () => {
  it('exits 1 on a proposal id that does not exist', async () => {
    setNow('2026-09-03T16:00:00Z');
    const run = await runCli(DECIDE_SPEC, runDecide, [
      '--proposal',
      'tl_proposed_action_deadbeef',
      '--by',
      'w_0021',
      '--decision',
      'approve',
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no proposal with id');
  });

  it('refuses a decider who is not a worker', async () => {
    setNow('2026-09-03T16:00:00Z');
    const run = await runCli(DECIDE_SPEC, runDecide, [
      '--proposal',
      escalation.id,
      '--by',
      'w_9999',
      '--decision',
      'approve',
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('a decision of record needs a real person');
  });

  it('rejects a decision word it does not know, as usage', async () => {
    setNow('2026-09-03T16:00:00Z');
    const run = await runCli(DECIDE_SPEC, runDecide, [
      '--proposal',
      escalation.id,
      '--by',
      'w_0021',
      '--decision',
      'maybe',
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('must be approve or decline');
  });

  it('records who decided, when, and the note — and nothing else', async () => {
    setNow('2026-09-03T16:00:00Z');
    const escalatedBefore = (readState<'task'>(dataDir, 'tasks.json') as TlTask[]).filter(
      (task) => task.cycle_id === cycleId && task.status === 'escalated',
    );
    expect(escalatedBefore.length).toBeGreaterThan(0);

    const { run, data } = await runJson<TlProposedAction>(DECIDE_SPEC, runDecide, [
      '--proposal',
      escalation.id,
      '--by',
      'w_0021',
      '--decision',
      'approve',
      '--note',
      'chasing in the Monday standup',
    ]);

    expect(run.code).toBe(0);
    expect(data.status).toBe('approved');
    expect(data.decided_by).toBe('w_0021');
    expect(data.decided_at).toBe('2026-09-03T16:00:00Z');
    expect(data.decision_note).toBe('chasing in the Monday standup');

    // A decision is a record: the bundled tasks are untouched by the approval.
    const escalatedAfter = (readState<'task'>(dataDir, 'tasks.json') as TlTask[]).filter(
      (task) => task.cycle_id === cycleId && task.status === 'escalated',
    );
    expect(escalatedAfter.map((task) => task.id).sort()).toEqual(
      escalatedBefore.map((task) => task.id).sort(),
    );
  });

  it('refuses to decide a decided proposal a second time', async () => {
    setNow('2026-09-04T16:00:00Z');
    const run = await runCli(DECIDE_SPEC, runDecide, [
      '--proposal',
      escalation.id,
      '--by',
      'w_0021',
      '--decision',
      'decline',
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/approved/);
  });
});
