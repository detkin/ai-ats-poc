/**
 * tests/cli/review-cycle.test.ts — the spec §8 loop-1 demo, end to end on fixtures.
 *
 * One temp `TL_DATA_DIR`, one seeded cycle, and the scenario in order:
 *
 *   open at 2026-08-24 → 479 tasks (120 self / 240 peer / 119 manager) and 479 pending
 *   shadow submissions → tick at the fixture anchor 2026-09-02 → reminders to everybody who
 *   is present and audible, a moved due date and *no* reminder for everybody who is away,
 *   one escalation with evidence instead of a hundred more reminders, an anomaly for a
 *   résumé that tried to give orders → a second tick that changes nothing and appends only
 *   reads → the ledger showing every write, including a `decide.mjs` and a standalone
 *   `nudge.mjs` addressed by record id (docs/DECISIONS.md D19) → `verify-loops` passing, and
 *   then failing when the state file is hand-edited behind the engine's back.
 *
 * The tests share state deliberately: this is one scenario, and vitest runs `it` blocks in
 * a file in order. `TL_NOW` is set explicitly for every step (docs/DECISIONS.md D8).
 *
 * Spec: docs/SPEC.md §7, §8 loop 1, §9, §10; docs/PLAN.md §4 block B1.3 and the M1 tester brief.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUDIT_SPEC, runAudit } from '#lib/cli/audit.ts';
import type { AuditReport } from '#lib/cli/audit.ts';
import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import { DECIDE_SPEC, runDecide } from '#lib/cli/decide.ts';
import { NUDGE_SPEC, runNudge } from '#lib/cli/nudge.ts';
import { TICK_SPEC, runTick } from '#lib/cli/tick.ts';
import type { TickResult } from '#lib/cli/tick.ts';
import { VERIFY_SPEC, runVerify } from '#lib/cli/verify.ts';
import type { VerifyReport } from '#lib/cli/verify.ts';
import type { TlAnomaly, TlNudge, TlProposedAction, TlTask } from '#lib/types/engine.ts';
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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CYCLE = 'tl_cycle_h2_2026';
/** A fixture résumé that contains an instruction aimed at the agent (fixtures/README.md). */
const INJECTED_RESUME = 'resumes/cand_0003.md';

let dataDir: string;
/** Ledger length before the first tick, so "what did tick 2 add" is answerable. */
let ledgerBeforeSecondTick = 0;
let firstTick: TickResult;

const tasks = (): TlTask[] => readState<'task'>(dataDir, 'tasks.json');
const selfTaskOf = (workerId: string): TlTask | undefined =>
  tasks().find(
    (task) =>
      task.cycle_id === CYCLE &&
      task.kind === 'write_self_review' &&
      task.participant_worker_id === workerId,
  );

beforeAll(() => {
  dataDir = seedDataDir();
});

afterAll(() => {
  cleanupDataDirs();
  delete process.env.TL_NOW;
  delete process.env.TL_DATA_DIR;
});

describe('cycle open', () => {
  it('creates 479 tasks and 479 pending submissions for the fixture org', async () => {
    setNow(OPEN_AT);
    const { run, data } = await runJson<{
      participants: number;
      tasks: number;
      submissions: number;
      by_kind: Record<string, number>;
      opened_at: string;
      status: string;
    }>(CYCLE_SPEC, runCycle, ['open', '--cycle', CYCLE]);

    expect(run.code).toBe(0);
    expect(data.participants).toBe(120);
    expect(data.tasks).toBe(479);
    expect(data.submissions).toBe(479);
    expect(data.by_kind).toEqual({
      write_self_review: 120,
      write_peer_review: 240,
      write_manager_review: 119,
    });
    expect(data.opened_at).toBe(OPEN_AT);
    expect(data.status).toBe('running');
  });

  it('refuses to open the same cycle twice', async () => {
    setNow(OPEN_AT);
    const run = await runCli(CYCLE_SPEC, runCycle, ['open', '--cycle', CYCLE]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('was opened at');
    expect(tasks().filter((task) => task.cycle_id === CYCLE)).toHaveLength(479);
  });
});

describe('the first tick', () => {
  it('nudges, moves due dates for the absent, escalates once and records an anomaly', async () => {
    setNow(ANCHOR);
    const { run, data } = await runJson<TickResult>(TICK_SPEC, runTick, [
      '--cycle',
      CYCLE,
      '--scan',
      INJECTED_RESUME,
    ]);
    firstTick = data;
    ledgerBeforeSecondTick = readLedger(dataDir).length;

    expect(run.code).toBe(0);
    expect(data.changed).toBe(true);
    expect(data.escalations).toBe(1);
    expect(data.closed).toBe(false);

    const byKind = new Map<string, number>();
    for (const action of data.actions) byKind.set(action.kind, (byKind.get(action.kind) ?? 0) + 1);
    // One `nudge` action per recipient, covering strictly more tasks than there are people
    // (docs/DECISIONS.md D17).
    expect(byKind.get('nudge') ?? 0).toBe(data.nudges);
    expect(data.nudges).toBeGreaterThan(50);
    expect(data.nudged_tasks).toBeGreaterThan(data.nudges);
    expect(byKind.get('move_due_date') ?? 0).toBeGreaterThan(0);
    expect(byKind.get('anomaly')).toBe(1);
    expect(byKind.get('refresh_packet')).toBe(1);
  });

  it('sends exactly one DM per recipient, and one tl_nudge per bundled task', () => {
    const outbox = readOutbox(dataDir);
    const nudgeLines = outbox.filter((line) => line.template_id.startsWith('nudge.'));
    const recipients = nudgeLines.map((line) => line.to_worker_id);

    // No person appears twice in the outbox: that is the whole point of D17.
    expect(new Set(recipients).size).toBe(nudgeLines.length);
    expect(nudgeLines).toHaveLength(firstTick.nudges);

    const nudges = (readState<'nudge'>(dataDir, 'nudges.json') as TlNudge[]).filter(
      (nudge) => nudge.cycle_id === CYCLE && nudge.delivered,
    );
    expect(nudges).toHaveLength(firstTick.nudged_tasks);

    // Every tl_nudge names a message that is actually in the outbox, addressed to its owner.
    const byRef = new Map(nudgeLines.map((line) => [line.message_ref, line]));
    const tasksById = new Map(tasks().map((task) => [task.id, task]));
    for (const nudge of nudges) {
      expect(nudge.message_ref).toBeDefined();
      const line = byRef.get(nudge.message_ref ?? '');
      expect(line, `no outbox line for ${nudge.id}`).toBeDefined();
      expect(line?.to_worker_id).toBe(tasksById.get(nudge.task_id)?.participant_worker_id);
    }
    // …and the bundles partition the nudged tasks: refs are shared, never duplicated per task.
    expect(new Set(nudges.map((nudge) => nudge.message_ref)).size).toBe(nudgeLines.length);
  });

  it("moves w_0009's self review to two days after the return day, and sends no nudge", () => {
    // abs_0001: approved PTO 2026-08-31 → 2026-09-03, so back on 09-04; +2 grace days.
    const task = selfTaskOf('w_0009');
    expect(task?.due_at).toBe('2026-09-06T23:59:59Z');
    expect(task?.original_due_at).toBe('2026-08-24T23:59:59Z');
    expect(task?.attempt_n).toBe(0);
    expect(task?.status).toBe('pending');
    expect(readOutbox(dataDir).some((line) => line.to_worker_id === 'w_0009')).toBe(false);
  });

  it('moves the parental-leave participant to two days after October', () => {
    // abs_0003: parental leave 2026-07-13 → 2026-10-31, so back on 11-01; +2 grace days.
    expect(selfTaskOf('w_0033')?.due_at).toBe('2026-11-03T23:59:59Z');
    expect(readOutbox(dataDir).some((line) => line.to_worker_id === 'w_0033')).toBe(false);
  });

  it('writes one outbox line per recipient, plus one for the escalation', () => {
    const outbox = readOutbox(dataDir);
    const nudgeLines = outbox.filter((line) => line.template_id.startsWith('nudge.'));
    const escalationLines = outbox.filter((line) => line.template_id === 'escalation');

    expect(nudgeLines).toHaveLength(firstTick.nudges);
    expect(escalationLines).toHaveLength(1);
    expect(escalationLines[0]?.to_worker_id).toBe('w_0021');
    // The rendered text carries injected facts, never an unresolved placeholder.
    expect(nudgeLines[0]?.text).not.toContain('{{');
    expect(escalationLines[0]?.text).toContain('node bin/decide.mjs --proposal');
  });

  it('ledgers one sendDirect per recipient and a state.create per bundled nudge', () => {
    const ledger = readLedger(dataDir).filter((entry) => entry.tick_id === firstTick.tick_id);
    const nudges = (readState<'nudge'>(dataDir, 'nudges.json') as TlNudge[]).filter(
      (nudge) => nudge.delivered,
    );
    const sends = ledger.filter(
      (e) => e.port === 'channel' && e.function === 'sendDirect' && e.result === 'ok',
    );
    const sent = new Set(sends.map((e) => e.result_ref));
    const created = new Set(
      ledger.filter((e) => e.port === 'state' && e.function === 'create').map((e) => e.result_ref),
    );

    expect(nudges.length).toBe(firstTick.nudged_tasks);
    // One send per recipient plus the single escalation DM — not one per task.
    expect(sends).toHaveLength(firstTick.nudges + 1);
    expect(sent.size).toBe(sends.length);
    for (const nudge of nudges) {
      expect(sent.has(nudge.message_ref)).toBe(true);
      expect(created.has(nudge.id)).toBe(true);
    }
    expect(ledger.every((entry) => entry.actor.worker_id === 'w_0021')).toBe(true);
    expect(ledger.every((entry) => entry.permission_context.length > 0)).toBe(true);
  });

  it('records exactly one escalation whose evidence names the offending tasks', () => {
    const proposals = (
      readState<'proposed_action'>(dataDir, 'proposed_actions.json') as TlProposedAction[]
    ).filter((proposal) => proposal.cycle_id === CYCLE && proposal.kind === 'escalate');
    expect(proposals).toHaveLength(1);

    const proposal = proposals[0];
    const escalated = tasks().filter(
      (task) => task.cycle_id === CYCLE && task.status === 'escalated',
    );
    expect(escalated.length).toBeGreaterThan(50);
    expect(proposal?.status).toBe('proposed');
    for (const task of escalated) {
      expect(proposal?.evidence_refs).toContain(task.id);
    }
    // No escalated task belongs to somebody the availability port said was away.
    expect(escalated.some((task) => task.participant_worker_id === 'w_0009')).toBe(false);
  });

  it('moves the cycle to escalated and records the injection attempt as an anomaly', () => {
    const cycles = readState<'cycle'>(dataDir, 'cycles.json');
    expect(cycles.find((cycle) => cycle.id === CYCLE)?.status).toBe('escalated');

    const anomalies = readState<'anomaly'>(dataDir, 'anomalies.json') as TlAnomaly[];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.source_ref).toBe(INJECTED_RESUME);
    expect(anomalies[0]?.rule).toBe('ignore_prior_instructions');
    // The résumé asked for an advance_stage; no such proposal exists.
    const proposals = readState<'proposed_action'>(
      dataDir,
      'proposed_actions.json',
    ) as TlProposedAction[];
    expect(proposals.some((proposal) => proposal.kind === 'advance_stage')).toBe(false);
  });

  it('stores a calibration packet whose citations are record ids', () => {
    const packets = readState<'packet'>(dataDir, 'packets.json');
    expect(packets).toHaveLength(1);
    expect(packets[0]?.kind).toBe('calibration');
    expect(packets[0]?.inputs_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(packets[0]?.citations.length).toBeGreaterThan(0);
    for (const citation of packets[0]?.citations ?? []) {
      expect(citation.record_ids.length).toBeGreaterThan(0);
    }
  });
});

describe('the second tick', () => {
  it('changes nothing and appends only read entries to the ledger', async () => {
    setNow(ANCHOR);
    const outboxBefore = readOutbox(dataDir).length;
    const { run, data } = await runJson<TickResult>(TICK_SPEC, runTick, [
      '--cycle',
      CYCLE,
      '--scan',
      INJECTED_RESUME,
    ]);

    expect(run.code).toBe(0);
    expect(data.changed).toBe(false);
    expect(data.actions).toEqual([]);
    expect(readOutbox(dataDir)).toHaveLength(outboxBefore);

    const added = readLedger(dataDir).slice(ledgerBeforeSecondTick);
    expect(added.length).toBeGreaterThan(0);
    const writeFunctions = added.filter((entry) =>
      ['create', 'update', 'sendDirect', 'postChannel'].includes(entry.function),
    );
    expect(writeFunctions).toEqual([]);
    expect(added.every((entry) => entry.result === 'ok')).toBe(true);
  });

  it('is a real no-op even with --dry-run on a changed clock', async () => {
    setNow('2026-09-03T16:00:00Z');
    const stateBefore = readFileSync(join(dataDir, 'state', 'tasks.json'), 'utf8');
    const { data } = await runJson<TickResult>(TICK_SPEC, runTick, ['--cycle', CYCLE, '--dry-run']);
    expect(data.dry_run).toBe(true);
    expect(readFileSync(join(dataDir, 'state', 'tasks.json'), 'utf8')).toBe(stateBefore);
  });
});

describe('audit', () => {
  it('lists every write with its tick id', async () => {
    setNow(ANCHOR);
    const run = await runCli(AUDIT_SPEC, runAudit, ['--cycle', CYCLE, '--format', 'json']);
    expect(run.code).toBe(0);
    const report = JSON.parse(run.stdout) as AuditReport;

    expect(report.summary.writes).toBeGreaterThan(500);
    expect(report.summary.reads).toBeGreaterThan(0);
    expect(report.summary.rejected).toBe(0);
    expect(report.summary.writes_by_port.state).toBeGreaterThan(0);
    expect(report.summary.writes_by_port.channel).toBeGreaterThan(0);
    expect(report.summary.ticks.length).toBeGreaterThanOrEqual(2);
    expect(report.summary.actors).toEqual(['w_0021']);

    const writes = report.entries.filter((entry) =>
      ['create', 'update', 'sendDirect'].includes(entry.function),
    );
    // Every write made during a tick carries that tick's id.
    const tickWrites = writes.filter((entry) => entry.tick_id !== undefined);
    expect(tickWrites.length).toBeGreaterThan(0);
    expect(tickWrites.every((entry) => entry.tick_id === firstTick.tick_id)).toBe(true);
  });

  it('renders a markdown table by default', async () => {
    const run = await runCli(AUDIT_SPEC, runAudit, ['--cycle', CYCLE, '--limit', '5']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('| ts');
    expect(run.stdout).toContain('port.function');
    expect(run.stdout).toContain('## Summary');
  });

  it("carries the HRBP's decision of record, addressed by proposal id (D19)", async () => {
    const proposal = (
      readState<'proposed_action'>(dataDir, 'proposed_actions.json') as TlProposedAction[]
    ).find((row) => row.cycle_id === CYCLE && row.kind === 'escalate');
    expect(proposal).toBeDefined();

    setNow('2026-09-03T16:00:00Z');
    const decided = await runJson<TlProposedAction>(DECIDE_SPEC, runDecide, [
      '--proposal',
      proposal?.id ?? '',
      '--by',
      'w_0021',
      '--decision',
      'approve',
      '--note',
      'seen',
    ]);
    expect(decided.run.code).toBe(0);
    expect(decided.data.status).toBe('approved');

    const run = await runCli(AUDIT_SPEC, runAudit, ['--cycle', CYCLE, '--format', 'json']);
    const report = JSON.parse(run.stdout) as AuditReport;
    const update = report.entries.find(
      (entry) =>
        entry.port === 'state' &&
        entry.function === 'update' &&
        entry.result_ref === proposal?.id &&
        entry.ts === '2026-09-03T16:00:00Z',
    );
    expect(update, 'the decision of record is missing from audit --cycle').toBeDefined();
  });

  it('carries a standalone nudge.mjs run, addressed by task id (D19)', async () => {
    // 2026-09-07T06:00Z is 11:30 on a Monday in Bangalore, and w_0009's moved due date
    // (2026-09-06) has just passed — the one instant at which the PTO'd manager is finally
    // nudgeable (docs/DECISIONS.md D18). 16:00Z never would be: that is 21:30 IST.
    setNow('2026-09-07T06:00:00Z');
    const task = selfTaskOf('w_0009');
    expect(task?.status).toBe('pending');

    const nudged = await runJson<TlNudge & { sent: boolean }>(NUDGE_SPEC, runNudge, [
      '--task',
      task?.id ?? '',
    ]);
    expect(nudged.run.code).toBe(0);
    expect(nudged.data.sent).toBe(true);

    const run = await runCli(AUDIT_SPEC, runAudit, ['--cycle', CYCLE, '--format', 'json']);
    const report = JSON.parse(run.stdout) as AuditReport;
    expect(
      report.entries.some(
        (entry) =>
          entry.port === 'channel' &&
          entry.function === 'sendDirect' &&
          entry.result_ref === nudged.data.message_ref,
      ),
      'the standalone sendDirect is missing from audit --cycle',
    ).toBe(true);
    expect(
      report.entries.some(
        (entry) =>
          entry.port === 'state' && entry.function === 'update' && entry.result_ref === task?.id,
      ),
      'the task transition is missing from audit --cycle',
    ).toBe(true);
  });

  it('rejects an unknown --format', async () => {
    const run = await runCli(AUDIT_SPEC, runAudit, ['--cycle', CYCLE, '--format', 'yaml']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('must be md or json');
  });
});

describe('verify-loops', () => {
  it('passes after the scenario', async () => {
    setNow(ANCHOR);
    const { run, data } = await runJson<VerifyReport>(VERIFY_SPEC, runVerify, ['--cycle', CYCLE]);
    expect(run.code).toBe(0);
    expect(data.ok).toBe(true);
    expect(data.totals.findings).toBe(0);
    expect(data.totals.checked).toBeGreaterThan(1000);
    expect(data.rules.map((rule) => rule.id)).toEqual([
      'done_task_has_submission',
      'nudged_task_has_nudges',
      'escalated_task_in_proposal',
      'state_records_ledgered',
      'references_resolve',
      'cycle_status_canonical',
      'decisions_by_active_worker',
    ]);
  });

  it('fails and names the task when a state file is hand-edited to done', async () => {
    const path = join(dataDir, 'state', 'tasks.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as TlTask[];
    const victim = rows.find((task) => task.cycle_id === CYCLE && task.status === 'pending');
    expect(victim).toBeDefined();
    writeFileSync(
      path,
      `${JSON.stringify(
        rows.map((task) => (task.id === victim?.id ? { ...task, status: 'done' } : task)),
        null,
        2,
      )}\n`,
      'utf8',
    );

    const { run, data } = await runJson<VerifyReport>(VERIFY_SPEC, runVerify, ['--cycle', CYCLE]);
    expect(run.code).toBe(1);
    expect(data.ok).toBe(false);
    const rule = data.rules.find((entry) => entry.id === 'done_task_has_submission');
    expect(rule?.findings.map((finding) => finding.id)).toEqual([victim?.id]);
    expect(rule?.findings[0]?.detail).toContain('no submitted tl_review_submission');

    // Put it back so nothing after this test inherits the drift.
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  });
});
