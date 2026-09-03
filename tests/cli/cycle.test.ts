/**
 * tests/cli/cycle.test.ts — create, open, show and close, on a department-scoped cycle.
 *
 * The whole-company scenario lives in `review-cycle.test.ts`; this file covers the
 * lifecycle rules that are cheaper to state on eight people than on a hundred and twenty:
 * scoping, the refusal to close early, the refusal to open an interview cycle before M2, and
 * the argument validation that has to fail as *usage* rather than as a domain error.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import type { CloseResult, ShowResult } from '#lib/cli/cycle.ts';
import type { TlCycle, TlTask } from '#lib/types/engine.ts';
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
let designCycle: string;

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
  designCycle = data.id;
});

afterAll(() => {
  cleanupDataDirs();
  delete process.env.TL_NOW;
  delete process.env.TL_DATA_DIR;
});

describe('cycle create', () => {
  it('records a configured cycle with an adapter-assigned id and no opened_at', () => {
    const cycle = readState<'cycle'>(dataDir, 'cycles.json').find((row) => row.id === designCycle);
    expect(cycle?.id).toMatch(/^tl_cycle_[0-9a-f]{8}$/);
    expect(cycle?.status).toBe('configured');
    expect(cycle?.opened_at).toBeNull();
    expect(cycle?.owner_worker_id).toBe('w_0021');
    expect(cycle?.policy_ref).toBe('tenant/policy.yml');
    expect(cycle?.scope.department_ids).toEqual(['dept_design']);
    expect(cycle?.deadline).toBe('2026-09-18T23:59:59Z');
  });

  it('rejects an unknown type and a nonsense deadline as usage errors', async () => {
    setNow(OPEN_AT);
    const badType = await runCli(CYCLE_SPEC, runCycle, [
      'create',
      '--type',
      'performance',
      '--name',
      'x',
      '--owner',
      'w_0021',
      '--deadline',
      '2026-09-18',
    ]);
    expect(badType.code).toBe(2);
    expect(badType.stderr).toContain('is not a cycle type');

    const badDate = await runCli(CYCLE_SPEC, runCycle, [
      'create',
      '--type',
      'review',
      '--name',
      'x',
      '--owner',
      'w_0021',
      '--deadline',
      'next tuesday',
    ]);
    expect(badDate.code).toBe(2);
    expect(badDate.stderr).toContain('is not a date');
  });

  it('rejects an owner who is not a worker', async () => {
    setNow(OPEN_AT);
    const run = await runCli(CYCLE_SPEC, runCycle, [
      'create',
      '--type',
      'review',
      '--name',
      'x',
      '--owner',
      'w_9999',
      '--deadline',
      '2026-09-18',
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no worker with id "w_9999"');
  });
});

describe('cycle open', () => {
  it('creates tasks only for the scoped department', async () => {
    setNow(OPEN_AT);
    const { run, data } = await runJson<{
      participants: number;
      tasks: number;
      by_kind: Record<string, number>;
    }>(CYCLE_SPEC, runCycle, ['open', '--cycle', designCycle]);

    expect(run.code).toBe(0);
    expect(data.participants).toBe(8);
    expect(data.tasks).toBe(32);
    expect(data.by_kind).toEqual({
      write_self_review: 8,
      write_peer_review: 16,
      write_manager_review: 8,
    });

    const tasks = readState<'task'>(dataDir, 'tasks.json').filter(
      (task) => task.cycle_id === designCycle,
    ) as TlTask[];
    // Stagger comes from tenant/policy.yml: self 0, peer 7, manager 14 days after open.
    const dueByKind = new Map(tasks.map((task) => [task.kind, task.due_at]));
    expect(dueByKind.get('write_self_review')).toBe('2026-08-24T23:59:59Z');
    expect(dueByKind.get('write_peer_review')).toBe('2026-08-31T23:59:59Z');
    expect(dueByKind.get('write_manager_review')).toBe('2026-09-07T23:59:59Z');
    // Every task starts pending with its original due date recorded.
    expect(tasks.every((task) => task.status === 'pending' && task.attempt_n === 0)).toBe(true);
    expect(tasks.every((task) => task.original_due_at === task.due_at)).toBe(true);
  });

  it('records the application and its requisition in an interview cycle scope', async () => {
    setNow(OPEN_AT);
    const { data } = await runJson<TlCycle>(CYCLE_SPEC, runCycle, [
      'create',
      '--type',
      'interview',
      '--name',
      'Onsite — Staff Engineer',
      '--owner',
      'w_0114',
      '--application',
      'app_0001',
      '--deadline',
      '2026-09-30',
    ]);
    // The requisition is read off the real application, never taken from the caller.
    expect(data.scope.application_id).toBe('app_0001');
    expect(data.scope.requisition_id).toBe('req_staff_eng');
    expect(data.status).toBe('configured');
  });

  it('refuses --type interview without an application', async () => {
    setNow(OPEN_AT);
    const run = await runCli(
      CYCLE_SPEC,
      runCycle,
      [
        'create',
        '--type',
        'interview',
        '--name',
        'Onsite — nobody',
        '--owner',
        'w_0114',
        '--deadline',
        '2026-09-30',
      ],
      2,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--application');
  });

  it('refuses to open an interview cycle whose application is not ACTIVE at Onsite', async () => {
    setNow(OPEN_AT);
    // app_0033 is a silver medalist: REJECTED on a closed requisition.
    const { data } = await runJson<TlCycle>(CYCLE_SPEC, runCycle, [
      'create',
      '--type',
      'interview',
      '--name',
      'Onsite — silver medalist',
      '--owner',
      'w_0114',
      '--application',
      'app_0033',
      '--deadline',
      '2026-09-30',
    ]);
    const run = await runCli(CYCLE_SPEC, runCycle, ['open', '--cycle', data.id]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('REJECTED');
    expect(run.stderr).toContain('decision of record');
  });

  it('reports an unknown cycle id as a domain failure', async () => {
    const run = await runCli(CYCLE_SPEC, runCycle, ['open', '--cycle', 'tl_cycle_nope']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no cycle with id "tl_cycle_nope"');
  });
});

describe('cycle show', () => {
  it('counts tasks by status and lists open proposals', async () => {
    setNow(OPEN_AT);
    const { run, data } = await runJson<ShowResult>(CYCLE_SPEC, runCycle, [
      'show',
      '--cycle',
      designCycle,
    ]);
    expect(run.code).toBe(0);
    expect(data.task_total).toBe(32);
    expect(data.tasks.pending).toBe(32);
    expect(data.open_proposals).toEqual([]);
    expect(data.cycle.status).toBe('running');
  });
});

describe('cycle close', () => {
  it('refuses while tasks are outstanding, and says what is outstanding', async () => {
    setNow(OPEN_AT);
    const { run, data } = await runJson<CloseResult>(CYCLE_SPEC, runCycle, [
      'close',
      '--cycle',
      designCycle,
    ]);
    expect(run.code).toBe(1);
    expect(data.closed).toBe(false);
    expect(data.outstanding.tasks).toHaveLength(32);
    expect(
      readState<'cycle'>(dataDir, 'cycles.json').find((c) => c.id === designCycle)?.status,
    ).toBe('running');
  });

  it('closes once every task is terminal', async () => {
    // Waive the lot by hand — the point under test is the close condition, not how a task
    // reaches a terminal state.
    const path = 'tasks.json';
    const rows = readState<'task'>(dataDir, path) as TlTask[];
    writeFileSync(
      join(dataDir, 'state', path),
      `${JSON.stringify(
        rows.map((task) => (task.cycle_id === designCycle ? { ...task, status: 'waived' } : task)),
        null,
        2,
      )}\n`,
      'utf8',
    );

    setNow('2026-09-20T16:00:00Z');
    const { run, data } = await runJson<CloseResult>(CYCLE_SPEC, runCycle, [
      'close',
      '--cycle',
      designCycle,
    ]);
    expect(run.code).toBe(0);
    expect(data.closed).toBe(true);
    expect(data.cycle.status).toBe('closed');
    expect(data.cycle.closed_at).toBe('2026-09-20T16:00:00Z');
  });

  it('says so when the cycle is already closed', async () => {
    setNow('2026-09-20T16:00:00Z');
    const run = await runCli(CYCLE_SPEC, runCycle, ['close', '--cycle', designCycle]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('already closed');
  });
});
