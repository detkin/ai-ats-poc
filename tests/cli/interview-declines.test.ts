/**
 * tests/cli/interview-declines.test.ts — what happens when the panel keeps saying no
 * (block B2.4, defects M2-D1 / M2-D2 / M2-D3 from docs/testing/M2-report.md).
 *
 * `interview-loop.test.ts` walks the demo ladder, where exactly one interviewer declines.
 * This file walks the two paths the M2 tester found broken past that point, both end to end
 * through the real CLIs on the fixture tenant:
 *
 *  1. **Two declines, two ticks** (M2-D1). The stand-in also declines. The loop must not
 *     re-book the first decliner — they have already said they cannot make that hour
 *     (docs/DECISIONS.md D23). The bug was in the *snapshot*: a decliner swapped off the
 *     panel vanished from `snapshot.declines`, so the engine's exclusion set never saw them.
 *  2. **Two declines, one tick** (M2-D2). Both re-books write the slot's whole interviewer
 *     list, so the tick has to compose them. The bug left `tl_interview_slot` naming one set
 *     of people and the tasks and scorecards keyed to another.
 *  3. **The reconciliation rule** (M2-D3). `verify-loops` must fail on exactly that drift, so
 *     the state is hand-corrupted here in the shape the tester observed — a worker holding
 *     the work for a slot they are not on, a panellist on the slot holding none of it.
 *
 * Each scenario gets its own application (`app_0003`, `app_0004`) so the ladders cannot
 * perturb each other, and every command sets `TL_NOW` (docs/DECISIONS.md D8).
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import { TICK_SPEC, runTick } from '#lib/cli/tick.ts';
import type { TickResult } from '#lib/cli/tick.ts';
import { VERIFY_SPEC, runVerify } from '#lib/cli/verify.ts';
import type { VerifyReport } from '#lib/cli/verify.ts';
import type { TlCycle, TlInterviewSlot, TlScorecard, TlTask } from '#lib/types/engine.ts';
import type { WorkerId } from '#lib/types/tier1.ts';
import {
  cleanupDataDirs,
  readState,
  runCli,
  runJson,
  seedDataDir,
  setNow,
} from '#tests/cli/helpers.ts';

const RECRUITER = 'w_0114';
/** The panel `panelFor` builds for `req_staff_eng`, in panel order. */
const PANEL = ['w_0007', 'w_0002', 'w_0024', 'w_0025'];
const OPEN_AT = '2026-09-02T16:00:00Z';

let dataDir: string;

/** One scripted Slack reply on the hold's thread. The `message_ref` names its author. */
function reply(threadRef: string, messageRef: string, text: string, ts: string): void {
  appendFileSync(
    join(dataDir, 'inbox.jsonl'),
    `${JSON.stringify({ ts, thread_ref: threadRef, message_ref: messageRef, text })}\n`,
    'utf8',
  );
}

const DECLINE_TEXT = "Sorry — I can't make that hour, I'm double-booked all afternoon.";

const slotFor = (applicationId: string): TlInterviewSlot =>
  (readState<'interview_slot'>(dataDir, 'interview_slots.json') as TlInterviewSlot[]).find(
    (row) => row.application_id === applicationId,
  ) as TlInterviewSlot;

const tasksFor = (applicationId: string): TlTask[] =>
  (readState<'task'>(dataDir, 'tasks.json') as TlTask[]).filter(
    (row) => row.external_ref === applicationId,
  );

const cardsFor = (applicationId: string): TlScorecard[] =>
  (readState<'scorecard'>(dataDir, 'scorecards.json') as TlScorecard[]).filter(
    (row) => row.application_id === applicationId,
  );

/** Open an interview cycle on one application and book its panel. Returns cycle and hold. */
async function bookPanel(applicationId: string): Promise<{ cycleId: string; holdRef: string }> {
  setNow(OPEN_AT);
  const { data } = await runJson<TlCycle>(CYCLE_SPEC, runCycle, [
    'create',
    '--type',
    'interview',
    '--name',
    `Onsite — Staff Engineer (${applicationId})`,
    '--owner',
    RECRUITER,
    '--application',
    applicationId,
    '--deadline',
    '2026-09-25',
  ]);
  await runCli(CYCLE_SPEC, runCycle, ['open', '--cycle', data.id]);
  await runJson<TickResult>(TICK_SPEC, runTick, ['--cycle', data.id]);
  const booked = slotFor(applicationId);
  expect(booked.interviewer_worker_ids).toEqual(PANEL);
  return { cycleId: data.id, holdRef: booked.hold_ref ?? '' };
}

async function tick(cycleId: string, now: string): Promise<TickResult> {
  setNow(now);
  const { data } = await runJson<TickResult>(TICK_SPEC, runTick, ['--cycle', cycleId]);
  return data;
}

/**
 * The invariant `verify-loops`' eleventh rule now checks, asserted directly so a failure
 * here says *what* drifted rather than "the health check went red".
 */
function expectPanelHoldsItsOwnWork(applicationId: string): void {
  const panel = slotFor(applicationId).interviewer_worker_ids;
  const attend = tasksFor(applicationId).filter((task) => task.kind === 'attend_interview');
  const write = tasksFor(applicationId).filter((task) => task.kind === 'submit_scorecard');
  const cards = cardsFor(applicationId);
  const owners = (rows: { participant_worker_id?: WorkerId; interviewer_worker_id?: WorkerId }[]) =>
    rows.map((row) => row.participant_worker_id ?? row.interviewer_worker_id).sort();

  expect(panel).toHaveLength(PANEL.length);
  expect(new Set(panel).size).toBe(PANEL.length);
  expect(owners(attend)).toEqual([...panel].sort());
  expect(owners(write)).toEqual([...panel].sort());
  expect(owners(cards)).toEqual([...panel].sort());
  expect(cards.every((card) => card.status === 'pending')).toBe(true);
}

beforeAll(() => {
  dataDir = seedDataDir();
  process.env.TL_ACTOR = RECRUITER;
});

afterAll(() => {
  cleanupDataDirs();
  delete process.env.TL_NOW;
  delete process.env.TL_DATA_DIR;
  delete process.env.TL_ACTOR;
});

describe('the stand-in declines too (M2-D1)', () => {
  const APPLICATION = 'app_0003';
  let cycleId: string;
  let holdRef: string;
  let first: WorkerId;
  let second: WorkerId;

  beforeAll(async () => {
    ({ cycleId, holdRef } = await bookPanel(APPLICATION));
  });

  it('re-books the first decliner to a same-rank peer', async () => {
    reply(holdRef, 'reply_w_0024_decline', DECLINE_TEXT, '2026-09-02T18:00:00Z');
    const result = await tick(cycleId, '2026-09-03T16:00:00Z');
    expect(result.rebooks).toBe(1);

    const panel = slotFor(APPLICATION).interviewer_worker_ids;
    expect(panel).not.toContain('w_0024');
    first = panel.find((id) => !PANEL.includes(id)) as WorkerId;
    expect(first).toBeDefined();
    expectPanelHoldsItsOwnWork(APPLICATION);
  });

  it('never re-books the worker who already declined this slot (D23)', async () => {
    reply(holdRef, `reply_${first}_decline`, DECLINE_TEXT, '2026-09-03T17:00:00Z');
    const result = await tick(cycleId, '2026-09-03T18:00:00Z');
    expect(result.rebooks).toBe(1);

    const panel = slotFor(APPLICATION).interviewer_worker_ids;
    second = panel.find((id) => !PANEL.includes(id) && id !== first) as WorkerId;
    expect(second, 'no second stand-in was chosen').toBeDefined();
    // The whole point: neither the original decliner nor the stand-in who just declined.
    expect(panel).not.toContain('w_0024');
    expect(panel).not.toContain(first);
    expect(second).not.toBe('w_0024');
    expectPanelHoldsItsOwnWork(APPLICATION);
  });

  it('leaves the run reconciled, and a third tick is a no-op', async () => {
    const again = await tick(cycleId, '2026-09-03T18:00:00Z');
    expect(again.changed).toBe(false);
    const { run, data } = await runJson<VerifyReport>(VERIFY_SPEC, runVerify, ['--cycle', cycleId]);
    expect(run.code).toBe(0);
    expect(data.ok).toBe(true);
  });
});

describe('two declines land in one tick (M2-D2)', () => {
  const APPLICATION = 'app_0004';
  let cycleId: string;
  let holdRef: string;

  beforeAll(async () => {
    ({ cycleId, holdRef } = await bookPanel(APPLICATION));
  });

  it('composes both re-books instead of letting the second undo the first', async () => {
    reply(holdRef, 'reply_w_0024_decline', DECLINE_TEXT, '2026-09-02T18:00:00Z');
    reply(holdRef, 'reply_w_0025_decline', DECLINE_TEXT, '2026-09-02T18:05:00Z');
    const result = await tick(cycleId, '2026-09-03T16:00:00Z');
    expect(result.rebooks).toBe(2);
    expect(result.actions.filter((action) => action.kind === 'rebook')).toHaveLength(2);
    expect(result.actions.filter((action) => action.kind === 'post_change')).toHaveLength(2);

    const panel = slotFor(APPLICATION).interviewer_worker_ids;
    // Both declines are honoured — neither swap was overwritten by the other.
    expect(panel).toContain('w_0007');
    expect(panel).toContain('w_0002');
    expect(panel).not.toContain('w_0024');
    expect(panel).not.toContain('w_0025');
    // …and the work follows the people on the slot, all of it and only theirs.
    expectPanelHoldsItsOwnWork(APPLICATION);
    expect(tasksFor(APPLICATION)).toHaveLength(2 * PANEL.length);
    expect(cardsFor(APPLICATION)).toHaveLength(PANEL.length);
  });

  it('converges: the next tick has nothing left to do', async () => {
    const result = await tick(cycleId, '2026-09-03T16:30:00Z');
    expect(result.changed).toBe(false);
    const { run } = await runJson<VerifyReport>(VERIFY_SPEC, runVerify, ['--cycle', cycleId]);
    expect(run.code).toBe(0);
  });

  it('fails verify-loops when the slot and its work name different people (M2-D3)', async () => {
    const slot = slotFor(APPLICATION);
    const stranded = slot.interviewer_worker_ids[0] as WorkerId;
    // The corruption the tester observed, reproduced by hand: a worker who is *not* on the
    // slot holding its tasks and scorecard, and a panellist holding none of them.
    const offSlot: WorkerId = 'w_0024';
    expect(slot.interviewer_worker_ids).not.toContain(offSlot);

    const allTasks = readState<'task'>(dataDir, 'tasks.json') as TlTask[];
    const allCards = readState<'scorecard'>(dataDir, 'scorecards.json') as TlScorecard[];
    const corruptTasks = allTasks.map((task) =>
      task.external_ref === APPLICATION && task.participant_worker_id === stranded
        ? { ...task, participant_worker_id: offSlot }
        : task,
    );
    const corruptCards = allCards.map((card) =>
      card.application_id === APPLICATION && card.interviewer_worker_id === stranded
        ? { ...card, interviewer_worker_id: offSlot }
        : card,
    );
    const tasksPath = join(dataDir, 'state', 'tasks.json');
    const cardsPath = join(dataDir, 'state', 'scorecards.json');
    writeFileSync(tasksPath, `${JSON.stringify(corruptTasks, null, 2)}\n`, 'utf8');
    writeFileSync(cardsPath, `${JSON.stringify(corruptCards, null, 2)}\n`, 'utf8');

    const { run, data } = await runJson<VerifyReport>(VERIFY_SPEC, runVerify, ['--cycle', cycleId]);
    expect(run.code).toBe(1);
    expect(data.ok).toBe(false);
    const panelRule = data.rules.find((entry) => entry.id === 'interview_panel_reconciles');
    expect(panelRule?.checked).toBe(1);
    const details = (panelRule?.findings ?? []).map((finding) => finding.detail).join('\n');
    expect(panelRule?.findings.every((finding) => finding.id === slot.id)).toBe(true);
    // Both halves of the drift are named, and both workers are named.
    expect(details).toContain(offSlot);
    expect(details).toContain(stranded);
    expect(details).toContain('not on the slot');
    expect(details).toContain('holds no');

    // Put it back, and the rule goes quiet again — the finding was the corruption, not the run.
    writeFileSync(tasksPath, `${JSON.stringify(allTasks, null, 2)}\n`, 'utf8');
    writeFileSync(cardsPath, `${JSON.stringify(allCards, null, 2)}\n`, 'utf8');
    const after = await runJson<VerifyReport>(VERIFY_SPEC, runVerify, ['--cycle', cycleId]);
    expect(after.run.code).toBe(0);
    expect(after.data.ok).toBe(true);
  });
});
