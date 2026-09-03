/**
 * tests/engine/interview-loop.test.ts — loop 2's pure derivations (block B2.1).
 *
 * Covers, against the committed fixture tenant: the `req_staff_eng` panel is the hiring
 * manager plus three Platform engineers at level rank ≥ 5, deterministically and in id order;
 * `chooseSlot` takes the earliest slot carrying the whole panel and prefers one at least two
 * business days out; `substituteFor` picks a same-team, same-rank, present worker who is not
 * already on the panel, and returns `null` rather than downgrading the panel; and `tasksFor`
 * puts attendance at the start of the slot and the scorecard `scorecard_due_hours` after it.
 *
 * Spec: docs/SPEC.md §6, §8 loop 2; docs/PLAN.md §2.6, §5 block B2.1.
 */

import { describe, expect, it } from 'vitest';

import {
  chooseSlot,
  interviewSlotFor,
  panelFor,
  rankOf,
  scorecardsFor,
  substituteFor,
  tasksFor,
} from '#lib/engine/interview-loop.ts';
import {
  STAFF_ENG_DECLINER,
  STAFF_ENG_PANEL,
  STAFF_ENG_SLOT,
  STAFF_ENG_SUBSTITUTE,
} from '#lib/fixtures/gen/calendar.ts';
import { makeCycle, policy, tenant, workerMap } from '#tests/engine/helpers.ts';
import type { AvailabilityAnswer } from '#lib/engine/snapshot.ts';
import type { Slot } from '#lib/ports/availability.ts';
import type {
  Application,
  JobRequisition,
  Level,
  LevelId,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';

const bundle = tenant();
const workers = workerMap(bundle.workers);
const levels = new Map<LevelId, Level>(bundle.levels.map((level) => [level.id, level]));
const req = bundle.job_requisitions.find((row) => row.id === 'req_staff_eng') as JobRequisition;
const application = bundle.applications.find((row) => row.id === 'app_0001') as Application;
const cycle = makeCycle({ id: 'tl_cycle_interview', type: 'interview' });
const NOW = '2026-09-03T16:00:00Z';

const slot: Slot = { ...STAFF_ENG_SLOT, worker_ids: [...STAFF_ENG_PANEL].sort() };

function noAbsences(): Map<WorkerId, AvailabilityAnswer> {
  return new Map();
}

describe('panelFor', () => {
  const panel = panelFor(req, workers, levels, policy());

  it('is the hiring manager plus panel_size − 1 team-mates, in id order', () => {
    expect(panel).toHaveLength(policy().interview_loop.panel_size);
    expect(panel[0]?.id).toBe(req.hiring_manager_id);
    expect(panel.map((worker) => worker.id)).toEqual([...STAFF_ENG_PANEL]);
    expect(panel.slice(1).map((worker) => worker.id)).toEqual(
      [...panel.slice(1)].sort((a, b) => (a.id < b.id ? -1 : 1)).map((worker) => worker.id),
    );
  });

  it('admits at most one level below the requisition, and never two', () => {
    const reqRank = rankOf(levels, req.level_id) ?? 0;
    for (const member of panel) {
      expect(rankOf(levels, member.level_id) ?? 0).toBeGreaterThanOrEqual(reqRank - 1);
    }
  });

  it('keeps everybody on the hiring manager’s own team, and everybody ACTIVE', () => {
    const manager = workers.get(req.hiring_manager_id);
    expect(manager).toBeDefined();
    for (const member of panel) {
      expect(member.team_id).toBe(manager?.team_id);
      expect(member.status).toBe('ACTIVE');
    }
  });

  it('is deterministic', () => {
    expect(panelFor(req, workers, levels, policy()).map((w) => w.id)).toEqual(
      panel.map((w) => w.id),
    );
  });

  it('returns an empty panel when the hiring manager is not in the snapshot', () => {
    expect(panelFor({ ...req, hiring_manager_id: 'w_nobody' }, workers, levels, policy())).toEqual(
      [],
    );
  });

  it('falls back to the department when the team cannot supply enough people', () => {
    const wide = panelFor(req, workers, levels, {
      ...policy(),
      interview_loop: { ...policy().interview_loop, panel_size: 8 },
    });
    expect(wide.length).toBeGreaterThan(STAFF_ENG_PANEL.length);
    expect(new Set(wide.map((w) => w.id)).size).toBe(wide.length);
    for (const member of wide) expect(member.department_id).toBe('dept_eng');
  });
});

describe('chooseSlot', () => {
  const attendees = [...STAFF_ENG_PANEL];
  const earlier: Slot = {
    start_at: '2026-09-04T17:00:00Z',
    end_at: '2026-09-04T18:00:00Z',
    worker_ids: attendees,
  };
  const later: Slot = {
    start_at: '2026-09-10T17:00:00Z',
    end_at: '2026-09-10T18:00:00Z',
    worker_ids: attendees,
  };

  it('takes the earliest slot that carries the whole panel', () => {
    expect(chooseSlot([later, slot], { attendee_ids: attendees })?.start_at).toBe(slot.start_at);
  });

  it('skips a slot that is missing a required attendee', () => {
    const short: Slot = { ...slot, worker_ids: attendees.slice(0, 2) };
    expect(chooseSlot([short], { attendee_ids: attendees })).toBeNull();
  });

  it('prefers a slot at least two business days out', () => {
    // 2026-09-04 is one business day after the 3rd; the 9th is four (Labor Day is still a day).
    expect(chooseSlot([earlier, slot], { attendee_ids: attendees, now: NOW })?.start_at).toBe(
      slot.start_at,
    );
  });

  it('takes a near slot rather than none when nothing clears the lead time', () => {
    expect(chooseSlot([earlier], { attendee_ids: attendees, now: NOW })?.start_at).toBe(
      earlier.start_at,
    );
  });

  it('returns null for an empty candidate list', () => {
    expect(chooseSlot([], { attendee_ids: attendees })).toBeNull();
  });
});

describe('substituteFor', () => {
  const panel = panelFor(req, workers, levels, policy());
  const declined = workers.get(STAFF_ENG_DECLINER) as Worker;

  it('picks the same team, the same level rank, not already on the panel', () => {
    const substitute = substituteFor(declined, panel, workers, levels, noAbsences());
    expect(substitute?.id).toBe(STAFF_ENG_SUBSTITUTE);
    expect(substitute?.team_id).toBe(declined.team_id);
    expect(rankOf(levels, substitute?.level_id ?? '')).toBe(rankOf(levels, declined.level_id));
  });

  it('never picks somebody already on the panel', () => {
    const substitute = substituteFor(declined, panel, workers, levels, noAbsences());
    expect(panel.map((worker) => worker.id)).not.toContain(substitute?.id);
  });

  it('skips a peer Rippling reports as away', () => {
    const away = new Map<WorkerId, AvailabilityAnswer>([
      [STAFF_ENG_SUBSTITUTE, { absent: true, quiet: false, source: 'rippling.absence' }],
    ]);
    const substitute = substituteFor(declined, panel, workers, levels, away);
    expect(substitute?.id).not.toBe(STAFF_ENG_SUBSTITUTE);
    expect(rankOf(levels, substitute?.level_id ?? '')).toBe(rankOf(levels, declined.level_id));
  });

  it('returns null rather than downgrading the panel when nobody at that rank is free', () => {
    const everyoneAway = new Map<WorkerId, AvailabilityAnswer>(
      bundle.workers.map((worker) => [
        worker.id,
        { absent: true, quiet: false, source: 'rippling.absence' } as AvailabilityAnswer,
      ]),
    );
    expect(substituteFor(declined, panel, workers, levels, everyoneAway)).toBeNull();
  });

  it('is deterministic', () => {
    expect(substituteFor(declined, panel, workers, levels, noAbsences())?.id).toBe(
      substituteFor(declined, panel, workers, levels, noAbsences())?.id,
    );
  });
});

describe('tasksFor', () => {
  const panel = panelFor(req, workers, levels, policy());
  const tasks = tasksFor(cycle, application, panel, slot, policy());

  it('creates one attendance and one scorecard task per interviewer', () => {
    expect(tasks).toHaveLength(panel.length * 2);
    expect(tasks.filter((task) => task.kind === 'attend_interview')).toHaveLength(panel.length);
    expect(tasks.filter((task) => task.kind === 'submit_scorecard')).toHaveLength(panel.length);
  });

  it('keys every task by the application and owns it to the interviewer', () => {
    for (const task of tasks) {
      expect(task.external_ref).toBe(application.id);
      expect(task.cycle_id).toBe(cycle.id);
      expect(task.status).toBe('pending');
      expect(task.attempt_n).toBe(0);
      expect(task.due_at).toBe(task.original_due_at);
    }
    expect(tasks.slice(0, panel.length).map((task) => task.participant_worker_id)).toEqual(
      panel.map((worker) => worker.id),
    );
  });

  it('falls attendance due at the start of the slot', () => {
    for (const task of tasks.filter((t) => t.kind === 'attend_interview')) {
      expect(task.due_at).toBe(STAFF_ENG_SLOT.start_at);
    }
  });

  it('falls the scorecard due scorecard_due_hours after the slot ends', () => {
    // 2026-09-09T18:00:00Z + 24h.
    for (const task of tasks.filter((t) => t.kind === 'submit_scorecard')) {
      expect(task.due_at).toBe('2026-09-10T18:00:00Z');
    }
    expect(policy().interview_loop.scorecard_due_hours).toBe(24);
  });
});

describe('the Tier-3 shadow records', () => {
  const panel = panelFor(req, workers, levels, policy());

  it('creates one pending scorecard per interviewer, with no body inlined', () => {
    const scorecards = scorecardsFor(application, panel);
    expect(scorecards.map((card) => card.interviewer_worker_id)).toEqual(
      panel.map((worker) => worker.id),
    );
    for (const card of scorecards) {
      expect(card.shadow).toBe(true);
      expect(card.application_id).toBe(application.id);
      expect(card.status).toBe('pending');
      expect(card.body_ref).toBeNull();
    }
  });

  it('marks the slot held only once a hold_ref exists', () => {
    expect(interviewSlotFor(application, panel, slot, null).status).toBe('proposed');
    const held = interviewSlotFor(application, panel, slot, 'hold_abcd1234');
    expect(held.status).toBe('held');
    expect(held.hold_ref).toBe('hold_abcd1234');
    expect(held.interviewer_worker_ids).toEqual(panel.map((worker) => worker.id));
    expect(held.real_ref).toBe(application.id);
  });
});
