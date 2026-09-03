/**
 * tests/engine/interview-plan.test.ts — loop 2 on loop 1's engine (block B2.1).
 *
 * Covers the five beats `planInterviewTick` adds and, just as importantly, the two it must
 * never add: there is no `advance_stage` action and no `reject` action anywhere in
 * `PLANNED_ACTION_KINDS`, so the only route from an interview loop to a candidate decision is
 * a `tl_proposed_action` a named human decides (spec §9).
 *
 * Also covers the reuse that makes spec §1 claim 1 true: a `submit_scorecard` task is
 * completed by the *generic* completion rule once its `tl_scorecard` is submitted, and an
 * overdue one is chased by the *generic* nudge rule — there is no `request_scorecard` action.
 *
 * Spec: docs/SPEC.md §7, §8 loop 2, §9, §10; docs/PLAN.md §5 block B2.1.
 */

import { describe, expect, it } from 'vitest';

import { applyPlan } from '#lib/engine/apply.ts';
import { tasksFor } from '#lib/engine/interview-loop.ts';
import { planInterviewTick } from '#lib/engine/interview-plan.ts';
import { planTick } from '#lib/engine/plan.ts';
import { PLANNED_ACTION_KINDS } from '#lib/engine/snapshot.ts';
import {
  STAFF_ENG_DECLINER,
  STAFF_ENG_PANEL,
  STAFF_ENG_SLOT,
  STAFF_ENG_SUBSTITUTE,
} from '#lib/fixtures/gen/calendar.ts';
import { makeCycle, makeSnapshot, policy, tenant, workerMap } from '#tests/engine/helpers.ts';
import type { AvailabilityAnswer, PlannedAction, TickSnapshot } from '#lib/engine/snapshot.ts';
import type { Slot } from '#lib/ports/availability.ts';
import type { TlInterviewSlot, TlScorecard, TlTask } from '#lib/types/engine.ts';
import type { Application, JobRequisition, Level, LevelId, WorkerId } from '#lib/types/tier1.ts';

const bundle = tenant();
const workers = workerMap(bundle.workers);
const levels = new Map<LevelId, Level>(bundle.levels.map((level) => [level.id, level]));
const req = bundle.job_requisitions.find((row) => row.id === 'req_staff_eng') as JobRequisition;
const application = bundle.applications.find((row) => row.id === 'app_0001') as Application;

const NOW = '2026-09-03T16:00:00Z';
const AFTER_SLOT = '2026-09-09T19:00:00Z';
const SLOT_ID = 'tl_interview_slot_0001';
const CYCLE_ID = 'tl_cycle_interview';

const cycle = makeCycle({
  id: CYCLE_ID,
  type: 'interview',
  name: 'Onsite — app_0001',
  scope: { application_id: application.id, requisition_id: req.id },
});

const candidateSlot: Slot = { ...STAFF_ENG_SLOT, worker_ids: [...STAFF_ENG_PANEL].sort() };

/** The panel's tasks, with the stable ids `bin/cycle.mjs open` would have assigned. */
function panelTasks(overrides: Partial<TlTask> = {}): TlTask[] {
  return tasksFor(
    cycle,
    application,
    [...STAFF_ENG_PANEL].map((id) => {
      const worker = workers.get(id);
      if (worker === undefined) throw new Error(`fixture worker ${id} missing`);
      return worker;
    }),
    candidateSlot,
    policy(),
  ).map((task, index) => ({
    ...task,
    id: `tl_task_${String(index + 1).padStart(4, '0')}`,
    created_at: NOW,
    updated_at: NOW,
    created_by: 'w_0114',
    ...overrides,
  }));
}

function heldSlot(overrides: Partial<TlInterviewSlot> = {}): TlInterviewSlot {
  return {
    id: SLOT_ID,
    created_at: NOW,
    updated_at: NOW,
    created_by: 'w_0114',
    shadow: true,
    real_ref: application.id,
    application_id: application.id,
    interviewer_worker_ids: [...STAFF_ENG_PANEL],
    start_at: STAFF_ENG_SLOT.start_at,
    end_at: STAFF_ENG_SLOT.end_at,
    hold_ref: 'hold_0badc0de',
    status: 'held',
    ...overrides,
  };
}

function scorecard(
  interviewer: WorkerId,
  index: number,
  status: TlScorecard['status'],
): TlScorecard {
  return {
    id: `tl_scorecard_${String(index).padStart(4, '0')}`,
    created_at: NOW,
    updated_at: NOW,
    created_by: 'w_0114',
    shadow: true,
    real_ref: application.id,
    application_id: application.id,
    interviewer_worker_id: interviewer,
    status,
    body_ref: `scorecards/${application.id}-${interviewer}.md`,
    ...(status === 'submitted' ? { submitted_at: AFTER_SLOT } : {}),
  };
}

function interviewSnapshot(parts: Partial<TickSnapshot> = {}): TickSnapshot {
  return makeSnapshot({
    cycle,
    tasks: [],
    workers,
    availability: new Map<WorkerId, AvailabilityAnswer>(),
    now: NOW,
    actor_worker_id: 'w_0114',
    application,
    requisition: req,
    levels,
    ...parts,
  });
}

function kinds(actions: readonly PlannedAction[]): string[] {
  return actions.map((action) => action.kind);
}

/* ---------------------------------------------------------------- the seam */

describe('the action vocabulary', () => {
  it('has no advance_stage and no reject, and never will', () => {
    expect(PLANNED_ACTION_KINDS).not.toContain('advance_stage');
    expect(PLANNED_ACTION_KINDS).not.toContain('reject');
  });

  it('has no request_scorecard: chasing one is the ordinary nudge path', () => {
    expect(PLANNED_ACTION_KINDS).not.toContain('request_scorecard');
  });

  it('carries the four interview additions', () => {
    for (const kind of ['place_hold', 'rebook', 'post_change', 'propose_decision']) {
      expect(PLANNED_ACTION_KINDS).toContain(kind);
    }
  });

  it('runs nothing extra for a review cycle', () => {
    const review = interviewSnapshot({ cycle: makeCycle({ id: 'tl_cycle_review' }) });
    expect(planInterviewTick(review)).toEqual([]);
  });
});

/* -------------------------------------------------------------- (i) booking */

describe('no slot on record', () => {
  const snapshot = interviewSnapshot({ slots: [candidateSlot] });
  const plan = planTick(snapshot);

  it('plans one place_hold for the whole panel at the chosen slot', () => {
    expect(kinds(plan.actions)).toEqual(['place_hold']);
    const action = plan.actions[0];
    expect(action?.kind === 'place_hold' && action.application_id).toBe(application.id);
    expect(action?.kind === 'place_hold' && action.slot.start_at).toBe(STAFF_ENG_SLOT.start_at);
    expect(action?.kind === 'place_hold' ? action.attendee_ids : []).toEqual([...STAFF_ENG_PANEL]);
    expect(action?.evidence_refs).toContain(req.id);
  });

  it('plans nothing when the composed Availability port offered no slot', () => {
    expect(planTick(interviewSnapshot({ slots: [] })).actions).toEqual([]);
  });

  it('does not book twice: the second tick is a no-op', () => {
    const after = applyPlan(snapshot, plan);
    expect(planTick(after).actions).toEqual([]);
    expect(after.interview_slots).toHaveLength(1);
    expect(after.interview_slots?.[0]?.status).toBe('held');
  });
});

/* -------------------------------------------------------------- (ii) decline */

describe('an interviewer declines', () => {
  const base = interviewSnapshot({
    tasks: panelTasks(),
    interview_slots: [heldSlot()],
    declines: [{ worker_id: STAFF_ENG_DECLINER, slot_id: SLOT_ID, reason: 'conflict' }],
  });
  const plan = planTick(base);

  it('re-books a same-team, same-rank peer and posts the change', () => {
    expect(kinds(plan.actions)).toEqual(['rebook', 'post_change']);
    const rebook = plan.actions[0];
    expect(rebook?.kind === 'rebook' && rebook.declined_worker_id).toBe(STAFF_ENG_DECLINER);
    expect(rebook?.kind === 'rebook' && rebook.substitute_worker_id).toBe(STAFF_ENG_SUBSTITUTE);
    expect(rebook?.kind === 'rebook' && rebook.slot_id).toBe(SLOT_ID);
  });

  it('posts a change that names ids and no candidate', () => {
    const post = plan.actions[1];
    expect(post?.kind).toBe('post_change');
    const text = post?.kind === 'post_change' ? post.text : '';
    expect(text).toContain(STAFF_ENG_DECLINER);
    expect(text).toContain(STAFF_ENG_SUBSTITUTE);
    expect(text).toContain(application.id);
    expect(text).not.toContain(bundle.candidates[0]?.first_name ?? 'IMPOSSIBLE');
  });

  it('moves the declining interviewer’s tasks to the stand-in and then stops', () => {
    const after = applyPlan(base, plan);
    expect(after.interview_slots?.[0]?.interviewer_worker_ids).toContain(STAFF_ENG_SUBSTITUTE);
    expect(after.interview_slots?.[0]?.interviewer_worker_ids).not.toContain(STAFF_ENG_DECLINER);
    expect(
      after.tasks.filter((task) => task.participant_worker_id === STAFF_ENG_SUBSTITUTE),
    ).toHaveLength(2);
    expect(
      after.tasks.filter((task) => task.participant_worker_id === STAFF_ENG_DECLINER),
    ).toHaveLength(0);
    expect(planTick(after).actions).toEqual([]);
  });

  it('ignores a decline against a slot the interviewer is no longer on', () => {
    const stale = interviewSnapshot({
      tasks: panelTasks(),
      interview_slots: [heldSlot({ interviewer_worker_ids: ['w_0007', 'w_0002', 'w_0025'] })],
      declines: [{ worker_id: STAFF_ENG_DECLINER, slot_id: SLOT_ID }],
    });
    expect(planTick(stale).actions).toEqual([]);
  });
});

describe('a rebook moves the record the work completes against', () => {
  const pending = [...STAFF_ENG_PANEL].map((id, index) => scorecard(id, index + 1, 'pending'));
  const base = interviewSnapshot({
    tasks: panelTasks(),
    interview_slots: [heldSlot()],
    scorecards: pending,
    declines: [{ worker_id: STAFF_ENG_DECLINER, slot_id: SLOT_ID }],
  });

  it('re-keys the decliner’s pending scorecard to the stand-in (D23)', () => {
    const after = applyPlan(base, planTick(base));
    const cards = after.scorecards ?? [];
    expect(cards).toHaveLength(pending.length);
    expect(cards.some((card) => card.interviewer_worker_id === STAFF_ENG_DECLINER)).toBe(false);
    const moved = cards.find((card) => card.interviewer_worker_id === STAFF_ENG_SUBSTITUTE);
    // The same record, re-keyed — not a new one, and still pending.
    expect(moved?.id).toBe(
      pending.find((card) => card.interviewer_worker_id === STAFF_ENG_DECLINER)?.id,
    );
    expect(moved?.status).toBe('pending');
  });

  it('leaves the stand-in a scorecard task that can actually complete', () => {
    const after = applyPlan(base, planTick(base));
    const card = (after.scorecards ?? []).find(
      (row) => row.interviewer_worker_id === STAFF_ENG_SUBSTITUTE,
    );
    const submitted: TickSnapshot = {
      ...after,
      now: AFTER_SLOT,
      scorecards: (after.scorecards ?? []).map((row) =>
        row.id === card?.id ? { ...row, status: 'submitted' as const } : row,
      ),
    };
    const completions = planTick(submitted).actions.filter(
      (action) => action.kind === 'complete_task' && action.submission_id === card?.id,
    );
    expect(completions).toHaveLength(1);
  });

  it('never picks a worker who declined this slot as its stand-in (D23)', () => {
    const after = applyPlan(base, planTick(base));
    // The stand-in now declines too. The first decliner is free, on the team and at the same
    // rank — and has already said they cannot make this hour.
    const twice: TickSnapshot = {
      ...after,
      declines: [
        { worker_id: STAFF_ENG_DECLINER, slot_id: SLOT_ID },
        { worker_id: STAFF_ENG_SUBSTITUTE, slot_id: SLOT_ID },
      ],
    };
    const rebooks = planTick(twice).actions.filter((action) => action.kind === 'rebook');
    expect(rebooks).toHaveLength(1);
    const second = rebooks[0];
    expect(second?.kind === 'rebook' && second.declined_worker_id).toBe(STAFF_ENG_SUBSTITUTE);
    const chosen = second?.kind === 'rebook' ? second.substitute_worker_id : '';
    expect(chosen).not.toBe(STAFF_ENG_DECLINER);
    expect(chosen).not.toBe(STAFF_ENG_SUBSTITUTE);
    expect(STAFF_ENG_PANEL).not.toContain(chosen);
  });
});

describe('an interviewer declines and nobody at that rank is free', () => {
  const everyoneAway = new Map<WorkerId, AvailabilityAnswer>(
    bundle.workers.map((worker) => [
      worker.id,
      { absent: true, quiet: true, source: 'rippling.absence' } as AvailabilityAnswer,
    ]),
  );
  const base = interviewSnapshot({
    tasks: panelTasks(),
    availability: everyoneAway,
    interview_slots: [heldSlot()],
    declines: [{ worker_id: STAFF_ENG_DECLINER, slot_id: SLOT_ID }],
  });
  const plan = planTick(base);

  it('escalates to a human instead of running a thinner panel', () => {
    const escalations = plan.actions.filter((action) => action.kind === 'escalate');
    expect(escalations).toHaveLength(1);
    const escalation = escalations[0];
    expect(escalation?.kind === 'escalate' && escalation.to_worker_id).toBe(cycle.owner_worker_id);
    expect(escalation?.evidence_refs).toContain(STAFF_ENG_DECLINER);
    expect(escalation?.evidence_refs).toContain(SLOT_ID);
    expect(kinds(plan.actions)).not.toContain('rebook');
  });

  it('escalates once: the open proposal covers the next tick', () => {
    const after = applyPlan(base, plan);
    expect(planTick(after).actions.filter((action) => action.kind === 'escalate')).toEqual([]);
  });
});

/* --------------------------------------------------- (iii)/(iv)/(v) the rest */

describe('after the interview', () => {
  it('completes the attendance tasks the held slot evidences, and nudges nobody', () => {
    const base = interviewSnapshot({
      tasks: panelTasks(),
      interview_slots: [heldSlot()],
      now: AFTER_SLOT,
    });
    const plan = planTick(base);
    const completions = plan.actions.filter((action) => action.kind === 'complete_task');
    expect(completions).toHaveLength(STAFF_ENG_PANEL.length);
    for (const action of completions) {
      expect(action.kind === 'complete_task' && action.submission_id).toBe(SLOT_ID);
    }
    // The attendance task fell due at the *start* of the slot, so a tick after it has ended
    // sees it overdue — and still sends nothing, because attendance is never chased (D23).
    expect(kinds(plan.actions)).not.toContain('nudge');
  });

  it('completes attendance through the generic rule, not a loop-2 one', () => {
    // `planInterviewTick` alone plans nothing here: the completion lives in `detect`, which
    // is why it is seen before the nudge rule rather than after it.
    const base = interviewSnapshot({
      tasks: panelTasks(),
      interview_slots: [heldSlot()],
      now: AFTER_SLOT,
    });
    expect(planInterviewTick(base)).toEqual([]);
  });

  it('does not nudge attendance even long after the slot, with scorecards overdue', () => {
    const base = interviewSnapshot({
      tasks: panelTasks(),
      // A slot that was never held: no evidence, so attendance cannot complete either.
      interview_slots: [heldSlot({ hold_ref: null, status: 'proposed' })],
      now: '2026-09-11T17:00:00Z',
    });
    const plan = planTick(base);
    expect(plan.actions.filter((action) => action.kind === 'complete_task')).toHaveLength(0);
    for (const nudge of plan.actions.filter((action) => action.kind === 'nudge')) {
      expect(nudge.kind === 'nudge' && nudge.tasks.map((task) => task.kind)).toEqual([
        'submit_scorecard',
      ]);
    }
  });

  it('completes a scorecard task through the generic rule, not a new one', () => {
    const tasks = panelTasks().map((task) =>
      task.kind === 'attend_interview' ? { ...task, status: 'done' as const } : task,
    );
    const base = interviewSnapshot({
      tasks,
      interview_slots: [heldSlot()],
      scorecards: [scorecard('w_0007', 1, 'submitted')],
      now: AFTER_SLOT,
    });
    const completions = planTick(base).actions.filter((action) => action.kind === 'complete_task');
    expect(completions).toHaveLength(1);
    expect(completions[0]?.kind === 'complete_task' && completions[0].submission_id).toBe(
      'tl_scorecard_0001',
    );
  });

  it('chases an overdue scorecard with an ordinary nudge', () => {
    const tasks = panelTasks().map((task) =>
      task.kind === 'attend_interview' ? { ...task, status: 'done' as const } : task,
    );
    const base = interviewSnapshot({
      tasks,
      interview_slots: [heldSlot()],
      now: '2026-09-11T17:00:00Z',
    });
    const nudges = planTick(base).actions.filter((action) => action.kind === 'nudge');
    expect(nudges).toHaveLength(STAFF_ENG_PANEL.length);
    for (const nudge of nudges) {
      expect(nudge.kind === 'nudge' && nudge.template_id).toContain('submit_scorecard');
    }
  });
});

describe('every scorecard is in', () => {
  const tasks = panelTasks().map((task) => ({ ...task, status: 'done' as const }));
  const scorecards = [...STAFF_ENG_PANEL].map((id, index) => scorecard(id, index + 1, 'submitted'));
  const withPacket = (lastHash?: string): TickSnapshot =>
    interviewSnapshot({
      tasks,
      interview_slots: [heldSlot()],
      scorecards,
      now: AFTER_SLOT,
      debrief_inputs_hash: 'debrief-hash-1',
      ...(lastHash === undefined ? {} : { last_packet_inputs_hash: lastHash }),
    });

  it('assembles the debrief packet first, and holds the cycle open to do it', () => {
    const plan = planTick(withPacket());
    const refreshes = plan.actions.filter((action) => action.kind === 'refresh_packet');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.kind === 'refresh_packet' && refreshes[0].packet_kind).toBe('debrief');
    expect(kinds(plan.actions)).not.toContain('close_cycle');
    expect(kinds(plan.actions)).not.toContain('propose_decision');
  });

  it('then proposes the decision — and only proposes it', () => {
    const plan = planTick(withPacket('debrief-hash-1'));
    const proposals = plan.actions.filter((action) => action.kind === 'propose_decision');
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal?.kind === 'propose_decision' && proposal.decision_kind).toBe('advance_stage');
    expect(proposal?.kind === 'propose_decision' && proposal.application_id).toBe(application.id);
    expect(proposal?.evidence_refs).toContain('tl_scorecard_0001');
    expect(kinds(plan.actions)).not.toContain('close_cycle');
  });

  it('honours a reject intent without ever executing it', () => {
    const snapshot: TickSnapshot = {
      ...withPacket('debrief-hash-1'),
      proposed_decision_kind: 'reject',
    };
    const plan = planTick(snapshot);
    const proposal = plan.actions.find((action) => action.kind === 'propose_decision');
    expect(proposal?.kind === 'propose_decision' && proposal.decision_kind).toBe('reject');

    const after = applyPlan(snapshot, plan);
    const written = after.proposals.at(-1);
    expect(written?.kind).toBe('reject');
    expect(written?.status).toBe('proposed');
    expect(written?.payload.application_id).toBe(application.id);
  });

  it('proposes once, then converges to a no-op', () => {
    const snapshot = withPacket('debrief-hash-1');
    const after = applyPlan(snapshot, planTick(snapshot));
    const second = planTick(after);
    expect(kinds(second.actions)).not.toContain('propose_decision');
    const third = planTick(applyPlan(after, second));
    expect(third.changed).toBe(false);
  });
});

describe('idempotence over the whole loop', () => {
  it('reaches a fixed point from the unbooked state', () => {
    let snapshot = interviewSnapshot({ slots: [candidateSlot] });
    for (let i = 0; i < 5; i += 1) {
      const plan = planTick(snapshot);
      if (!plan.changed) break;
      snapshot = applyPlan(snapshot, plan);
    }
    expect(planTick(snapshot).changed).toBe(false);
  });
});
