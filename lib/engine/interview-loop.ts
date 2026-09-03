/**
 * lib/engine/interview-loop.ts — loop 2 as configuration: who interviews, when, and who
 * stands in when somebody cannot.
 *
 * Owns: the pure derivations the interview loop needs — the panel from the requisition and
 * the org chart, the slot chosen from candidates the composed Availability port produced,
 * the substitute interviewer on a decline, and the `tl_task` / `tl_scorecard` set the loop
 * chases. Nothing here writes and nothing here reads the world: `bin/cycle.mjs` and
 * `bin/tick.mjs` (block B2.2) take these `NewRecord<…>` values to `StatePort.create`, which
 * assigns the ids and ledgers the call.
 *
 * Public interface:
 *   panelFor(req, workers, levels, policy)                      -> Worker[]  (HM first)
 *   chooseSlot(slots, prefs?)                                   -> Slot | null
 *   substituteFor(declined, panel, workers, levels, availability) -> Worker | null
 *   tasksFor(cycle, application, panel, slot, policy)           -> NewRecord<TlTask>[]
 *   scorecardsFor(application, panel)                          -> NewRecord<TlScorecard>[]
 *   interviewSlotFor(application, panel, slot, holdRef)        -> NewRecord<TlInterviewSlot>
 *   rankOf(levels, levelId), businessDaysBetween(from, to), MIN_BUSINESS_DAYS_OUT
 *
 * Conventions this block establishes:
 *  - **`tl_task.external_ref` is the application id** for `attend_interview` and
 *    `submit_scorecard`, and `participant_worker_id` is the interviewer who owes the work.
 *    (Loop 1 puts the review *subject* there; both readings are "the real id this task is
 *    about", which is what spec §6 asks for.)
 *  - **Levels are compared by `rank`, never by name.** `L6` and `M2` are both rank 6, and a
 *    Director standing in for a Staff engineer is a legitimate panel, so the rule is
 *    arithmetic on `Level.rank` (docs/PLAN.md §2.1).
 *  - **Chasing a scorecard is not a new mechanism.** A `submit_scorecard` task falls due and
 *    the ordinary nudge path chases it, with loop 1's cadence, batching, attempt cap,
 *    absence and quiet-hours rules unchanged. There is no `request_scorecard` action, and
 *    that absence is the point: one engine, two loops (spec §1 claim 1).
 *
 * Determinism (spec §10): every candidate list is sorted by worker id before it is cut, so
 * the same org and the same policy always produce the same panel and the same substitute.
 *
 * Spec: docs/SPEC.md §3 (Tier 3), §4, §6, §8 loop 2, §9; docs/PLAN.md §2.6
 * (`interview_loop` policy), §5 block B2.1.
 */

import { parseInstant } from '#lib/engine/time.ts';
import type { AvailabilityAnswer } from '#lib/engine/snapshot.ts';
import type { TenantPolicy } from '#lib/policy/schema.ts';
import type { Slot } from '#lib/ports/availability.ts';
import type {
  NewRecord,
  TlCycle,
  TlInterviewSlot,
  TlScorecard,
  TlTask,
} from '#lib/types/engine.ts';
import type {
  Application,
  InstantISO,
  JobRequisition,
  Level,
  LevelId,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';

/** Default lead time: a booked panel should not land tomorrow morning. */
export const MIN_BUSINESS_DAYS_OUT = 2;

const MS_PER_HOUR = 3_600_000;

/** `YYYY-MM-DDTHH:MM:SSZ`, the second-precision instant shape used across the project. */
function instantOf(ms: number): InstantISO {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function byId(a: Worker, b: Worker): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A level's comparable rank, or `null` when the level is unknown to this snapshot. */
export function rankOf(levels: Map<LevelId, Level>, levelId: LevelId): number | null {
  return levels.get(levelId)?.rank ?? null;
}

/** Whole Mon–Fri days in `(fromDate, toDate]`, both `YYYY-MM-DD`. Negative ranges give 0. */
export function businessDaysBetween(fromDate: string, toDate: string): number {
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  let count = 0;
  for (let day = start + 86_400_000; day <= end; day += 86_400_000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/* --------------------------------------------------------------------- panel */

/**
 * The interview panel for a requisition: the hiring manager, then `panel_size − 1` of their
 * team-mates who are ACTIVE and at a level rank of at least `req level rank − 1` — one level
 * down is still a credible interviewer for the role, two is not. Candidates are taken in id
 * order, so the panel is reproducible. When the team cannot supply enough people the
 * department is used instead, on the same rank rule.
 *
 * The hiring manager leads the panel when they are ACTIVE; if they are not, the panel is
 * filled entirely from the team, and the caller sees a short panel rather than a fabricated
 * one. An empty result means the requisition's hiring manager is not in this snapshot at all.
 */
export function panelFor(
  req: JobRequisition,
  workers: Map<WorkerId, Worker>,
  levels: Map<LevelId, Level>,
  policy: TenantPolicy,
): Worker[] {
  const manager = workers.get(req.hiring_manager_id);
  if (manager === undefined) return [];

  const size = Math.max(1, policy.interview_loop.panel_size);
  const reqRank = rankOf(levels, req.level_id);
  const minRank = reqRank === null ? Number.NEGATIVE_INFINITY : reqRank - 1;

  const panel: Worker[] = manager.status === 'ACTIVE' ? [manager] : [];
  const taken = new Set<WorkerId>([manager.id]);

  const eligible = (worker: Worker): boolean => {
    if (taken.has(worker.id) || worker.status !== 'ACTIVE') return false;
    const rank = rankOf(levels, worker.level_id);
    return rank !== null && rank >= minRank;
  };

  const all = [...workers.values()].sort(byId);
  const pools = [
    all.filter((w) => w.team_id === manager.team_id),
    all.filter((w) => w.department_id === manager.department_id),
  ];
  for (const pool of pools) {
    for (const worker of pool) {
      if (panel.length >= size) break;
      if (!eligible(worker)) continue;
      panel.push(worker);
      taken.add(worker.id);
    }
  }
  return panel;
}

/* ---------------------------------------------------------------------- slot */

export interface SlotPreferences {
  /** Everybody who must be on the slot. A slot missing one of them is not a candidate. */
  attendee_ids?: readonly WorkerId[];
  /** The tick's `now`; only used to measure lead time. */
  now?: InstantISO;
  /** Lead time in business days. Defaults to `MIN_BUSINESS_DAYS_OUT`. */
  min_business_days?: number;
}

/**
 * The slot to book: the earliest candidate that carries every required attendee and sits at
 * least `min_business_days` business days out. If nothing clears the lead time — a panel
 * whose only shared hour is tomorrow — the earliest qualifying slot is returned anyway,
 * because a soon interview beats no interview, and the lead time is a preference rather than
 * a policy gate. `null` means no candidate carried the whole panel.
 *
 * The candidates themselves come from the **composed** Availability port, so absence and
 * quiet hours have already been applied and no slot here can land on somebody's leave.
 */
export function chooseSlot(slots: readonly Slot[], prefs: SlotPreferences = {}): Slot | null {
  const required = prefs.attendee_ids ?? [];
  const qualifying = [...slots]
    .filter((slot) => required.every((id) => slot.worker_ids.includes(id)))
    .sort((a, b) => parseInstant(a.start_at) - parseInstant(b.start_at));
  if (qualifying.length === 0) return null;

  const minDays = prefs.min_business_days ?? MIN_BUSINESS_DAYS_OUT;
  if (prefs.now === undefined || minDays <= 0) return qualifying[0] ?? null;

  const today = prefs.now.slice(0, 10);
  const preferred = qualifying.find(
    (slot) => businessDaysBetween(today, slot.start_at.slice(0, 10)) >= minDays,
  );
  return preferred ?? qualifying[0] ?? null;
}

/* --------------------------------------------------------------- substitute */

/**
 * Who takes a declining interviewer's place: an ACTIVE worker on the same team at the **same
 * level rank**, not already on the panel and not absent per Rippling; failing that, the same
 * rank anywhere in the declining interviewer's department. Lowest id wins, so the answer is
 * reproducible.
 *
 * `null` is a real answer, not a failure to try: it means the org has nobody at that rank who
 * is free, and the loop escalates to a human rather than quietly downgrading the panel
 * (spec §8 loop 2, `substitute_same_level: true` in `tenant/policy.yml`).
 */
export function substituteFor(
  declined: Worker,
  panel: readonly Worker[],
  workers: Map<WorkerId, Worker>,
  levels: Map<LevelId, Level>,
  availability: Map<WorkerId, AvailabilityAnswer>,
): Worker | null {
  const rank = rankOf(levels, declined.level_id);
  if (rank === null) return null;
  const onPanel = new Set(panel.map((worker) => worker.id));

  const eligible = (worker: Worker): boolean =>
    worker.id !== declined.id &&
    worker.status === 'ACTIVE' &&
    !onPanel.has(worker.id) &&
    rankOf(levels, worker.level_id) === rank &&
    availability.get(worker.id)?.absent !== true;

  const all = [...workers.values()].sort(byId);
  const sameTeam = all.find((w) => w.team_id === declined.team_id && eligible(w));
  if (sameTeam !== undefined) return sameTeam;
  return all.find((w) => w.department_id === declined.department_id && eligible(w)) ?? null;
}

/* ---------------------------------------------------------------- task set */

/**
 * What the panel owes: one `attend_interview` task per interviewer due at the start of the
 * slot, and one `submit_scorecard` task per interviewer due `scorecard_due_hours` after it
 * ends. `external_ref` is the application id on both, so the completing record — the slot for
 * attendance, the scorecard for the write-up — is findable from the task alone.
 *
 * Emitted attendance-first, then scorecards, each in panel order (hiring manager first).
 */
export function tasksFor(
  cycle: TlCycle,
  application: Application,
  panel: readonly Worker[],
  slot: Slot,
  policy: TenantPolicy,
): NewRecord<TlTask>[] {
  const scorecardDue = instantOf(
    parseInstant(slot.end_at) + policy.interview_loop.scorecard_due_hours * MS_PER_HOUR,
  );

  const make = (
    kind: 'attend_interview' | 'submit_scorecard',
    worker: Worker,
    dueAt: InstantISO,
  ): NewRecord<TlTask> => ({
    cycle_id: cycle.id,
    participant_worker_id: worker.id,
    kind,
    external_ref: application.id,
    due_at: dueAt,
    original_due_at: dueAt,
    status: 'pending',
    attempt_n: 0,
  });

  return [
    ...panel.map((worker) => make('attend_interview', worker, slot.start_at)),
    ...panel.map((worker) => make('submit_scorecard', worker, scorecardDue)),
  ];
}

/**
 * The pending Tier-3 scorecard for each interviewer — the record whose arrival at
 * `status: 'submitted'` completes the matching `submit_scorecard` task (spec §3, §6). The
 * body itself is never inlined into state: `body_ref` points at untrusted free text.
 */
export function scorecardsFor(
  application: Application,
  panel: readonly Worker[],
): NewRecord<TlScorecard>[] {
  return panel.map((worker) => ({
    shadow: true,
    real_ref: application.id,
    application_id: application.id,
    interviewer_worker_id: worker.id,
    status: 'pending',
    body_ref: null,
  }));
}

/**
 * The Tier-3 slot record for a booked panel. `hold_ref` is what the composed Availability
 * port returned — the engine holds the handle, never the calendar event itself.
 */
export function interviewSlotFor(
  application: Application,
  panel: readonly Worker[],
  slot: Slot,
  holdRef: string | null,
): NewRecord<TlInterviewSlot> {
  return {
    shadow: true,
    real_ref: application.id,
    application_id: application.id,
    interviewer_worker_ids: panel.map((worker) => worker.id),
    start_at: slot.start_at,
    end_at: slot.end_at,
    hold_ref: holdRef,
    status: holdRef === null ? 'proposed' : 'held',
  };
}
