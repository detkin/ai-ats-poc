/**
 * lib/engine/snapshot.ts — the engine's whole input and whole output, as types.
 *
 * Owns: `TickSnapshot` (everything one tick may look at) and `TickPlan` / `PlannedAction`
 * (everything one tick wants done). The engine is a pure function between the two: the CLI
 * (block B1.3) does the reading, hands the engine a snapshot, and then *executes* the plan
 * through the ports so every write is ledgered. The engine itself never calls a port.
 *
 * Public interface: `TickSnapshot`, `AvailabilityAnswer`, `UntrustedText`, `LastTick`,
 * `TickPlan`, `PlannedAction` (+ each member type), `PlannedNudgeTask`, `DetectSummary`,
 * `TaskSignal`, `InterviewDecline`, `PLANNED_ACTION_KINDS`.
 *
 * M2 (block B2.1) extends this file **additively**: the interview loop adds optional
 * snapshot fields and four planned-action kinds, and changes nothing that loop 1 reads.
 * Note what is deliberately *not* here: there is no `advance_stage` and no `reject` action.
 * Those are decisions of record, so the only shape they may take is `propose_decision`,
 * which the executor turns into a `tl_proposed_action` for a named human (spec §9).
 *
 * Conventions this block establishes (see also the report to the orchestrator):
 *  - **`tl_task.external_ref` is the review subject's worker id** for the three review task
 *    kinds. Spec §6 calls the column "external_ref (real id)"; a peer review needs both an
 *    author (`participant_worker_id`, who owes the work) and a subject, and the subject is
 *    a real `Worker`. `lib/types/engine.ts` has no `subject_worker_id`, and this block may
 *    not change it — this is the documented type gap.
 *  - **`AvailabilityAnswer.until`** is `AbsenceAnswer.until` from `lib/ports/availability.ts`:
 *    the last day of the absence, inclusive. A moved due date is
 *    `until + policy.absence.move_due_date_days_after_return` days, at 23:59:59Z.
 *  - **`AvailabilityAnswer.source`** separates the two things "absent" can mean. Approved
 *    leave (`rippling.absence`) both silences the person and moves their due dates; a public
 *    holiday only silences the day, because a deadline does not slip for everybody in a
 *    country every time that country has a Monday off.
 *  - **Nothing here holds a Tier-1 value.** Workers arrive by re-read on every tick
 *    (spec §3); the plan carries record *ids* as evidence, never copied attributes.
 *
 * Spec: docs/SPEC.md §7 (tick: detect → do → escalate → close), §9 (safety), §10 (evals);
 * docs/PLAN.md §2.2, §2.5, §2.6, §4 block B1.1.
 */

import type { TenantPolicy } from '#lib/policy/schema.ts';
import type {
  TlAnomaly,
  TlCycle,
  TlCycleState,
  TlInterviewSlot,
  TlNudge,
  TlNudgePolicyCheck,
  TlPacketKind,
  TlProposedAction,
  TlReviewSubmission,
  TlScorecard,
  TlTask,
  TlTaskKind,
  TlTaskState,
} from '#lib/types/engine.ts';
import type { Slot } from '#lib/ports/availability.ts';
import type {
  Application,
  DateISO,
  Department,
  InstantISO,
  JobRequisition,
  Level,
  LevelId,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';

/* ------------------------------------------------------------------ snapshot */

/**
 * The Availability port's two answers for one worker, composed for the tick.
 * `absent` is authoritative (spec §4: never nudge against a calendar alone).
 */
export interface AvailabilityAnswer {
  absent: boolean;
  /** Leave type or holiday name, for the ledger and the moved-due-date reason. */
  reason?: string;
  /** Last day of the absence, inclusive (`AbsenceAnswer.until`). */
  until?: DateISO;
  /**
   * Which authority said "absent" (`AbsenceAnswer.source`). It matters because the two
   * answers earn different treatment: approved leave moves a due date, a public holiday
   * only silences the day. Absent with no source recorded is treated as approved leave.
   */
  source?: 'rippling.absence' | 'holiday';
  quiet: boolean;
  quiet_reason?: string;
}

/** A piece of untrusted human text the tick happened to read (spec §9). Data, never orders. */
export interface UntrustedText {
  /** Stable pointer to where the text came from, e.g. `resumes/cand_0003.md`. */
  source_ref: string;
  text: string;
}

/**
 * An interviewer said no to a booked slot. The CLI reads these from the channel's scripted
 * replies (`inbox.jsonl`) — free human text, so the *text* is data and only the fact of the
 * decline reaches the engine (spec §9).
 */
export interface InterviewDecline {
  worker_id: WorkerId;
  /** The `tl_interview_slot` being declined. */
  slot_id: string;
  reason?: string;
}

/** What the previous tick left behind, for the "diff vs last tick" step (spec §7 step 1). */
export interface LastTick {
  at: InstantISO;
  task_states: Record<string, TlTaskState>;
}

/**
 * Everything one tick is allowed to look at. Built by the CLI from the ports; the engine
 * treats it as immutable and returns a plan rather than mutating it.
 */
export interface TickSnapshot {
  cycle: TlCycle;
  tasks: TlTask[];
  proposals: TlProposedAction[];
  nudges: TlNudge[];
  submissions: TlReviewSubmission[];
  /** Tier-1 re-read, keyed by id (spec §3: values are re-read, never stored). */
  workers: Map<WorkerId, Worker>;
  /** One answer per worker the tick cares about. A missing entry means "present, audible". */
  availability: Map<WorkerId, AvailabilityAnswer>;
  policy: TenantPolicy;
  now: InstantISO;
  /** Who the agent is acting as (spec §9). Defaults to the cycle owner when omitted. */
  actor_worker_id?: WorkerId;
  last_tick?: LastTick;
  /** Departments, only needed when `policy.escalation.escalate_to` is `department_head`. */
  departments?: Map<string, Department>;
  /** Untrusted text read during this tick; screened by `lib/safety/allowlist.ts`. */
  untrusted?: UntrustedText[];
  /** Anomalies already on record, so a repeat read is not recorded twice (idempotence). */
  anomalies?: TlAnomaly[];
  /** `inputs_hash` of the newest calibration packet on record, if any. */
  last_packet_inputs_hash?: string;
  /** `inputs_hash` the calibration packet *would* have now (`calibrationInputsHash`). */
  calibration_inputs_hash?: string;

  /* -------------------------------------------- interview loop (M2, block B2.1) */

  /**
   * The application under interview. Tier-1, re-read every tick — the engine keys the loop
   * by its id and never copies its `stage` (spec §3).
   */
  application?: Application;
  /** The requisition behind it; `panelFor` reads its level and hiring manager. */
  requisition?: JobRequisition;
  /** Levels by id. Panel and substitute rules compare `rank`, never a level *name*. */
  levels?: Map<LevelId, Level>;
  /**
   * Candidate slots the CLI already obtained from the **composed** Availability port
   * (`lib/availability/compose.ts`) — Rippling absence first, calendar second. The engine
   * chooses among them; it never asks a calendar anything itself.
   */
  slots?: Slot[];
  /** Tier-3 shadow slots on record for this application. */
  interview_slots?: TlInterviewSlot[];
  /** Tier-3 shadow scorecards; a `submitted` one completes its `submit_scorecard` task. */
  scorecards?: TlScorecard[];
  /** Declines observed since the last tick. */
  declines?: InterviewDecline[];
  /** `inputs_hash` the debrief packet *would* have now (`debriefInputsHash`). */
  debrief_inputs_hash?: string;
  /**
   * Which decision of record the loop should *propose* once the debrief packet exists.
   * Defaults to `advance_stage`. The engine expresses no view either way: this only picks
   * the shape of the proposal a named human then approves or declines (spec §9).
   */
  proposed_decision_kind?: 'advance_stage' | 'reject';
}

/* -------------------------------------------------------------------- detect */

/** Everything detect concluded about one task. Pure derivation from the snapshot. */
export interface TaskSignal {
  task_id: string;
  kind: TlTaskKind;
  participant_worker_id: WorkerId;
  /** The review subject (`tl_task.external_ref`); null for non-review task kinds. */
  subject_worker_id: WorkerId | null;
  status: TlTaskState;
  due_at: InstantISO;
  terminal: boolean;
  overdue: boolean;
  /** Whole days past `due_at`; 0 when not overdue. */
  overdue_days: number;
  /** Not yet overdue, but due within `policy.escalation.overdue_days`. */
  at_risk: boolean;
  absent: boolean;
  absent_until?: DateISO;
  absent_reason?: string;
  /**
   * `rippling.absence` (approved leave) or `holiday`. Both suppress the nudge; only approved
   * leave moves the due date. Undefined means the snapshot did not say, and is read as leave.
   */
  absent_source?: 'rippling.absence' | 'holiday';
  quiet: boolean;
  quiet_reason?: string;
  /**
   * `now − <the recipient's latest nudged_at in this cycle> ≥
   * policy.cadence.nudge_min_gap_hours` (true when they have never been nudged). The gap is
   * measured **per recipient**, not per task (docs/DECISIONS.md D17): one person, one
   * reminder per cadence window, however many tasks they owe.
   */
  nudge_gap_ok: boolean;
  attempt_n: number;
  attempts_left: number;
  /** Is the recipient a worker inside this cycle's scope? */
  recipient_in_cycle: boolean;
  /** Id of the submitted `tl_review_submission` that completes this task, when present. */
  submission_id?: string;
  /** Task status changed since `last_tick.task_states` (true when there was no last tick). */
  changed_since_last_tick: boolean;
}

/** An instruction attempt found in untrusted text, not yet on record. */
export interface AnomalyFinding {
  source_ref: string;
  excerpt: string;
  rule: string;
}

/** What detect concluded about the whole cycle (spec §7 step 1). */
export interface DetectSummary {
  now: InstantISO;
  cycle_id: string;
  cycle_status: TlCycleState;
  signals: TaskSignal[];
  /** Same signals, by task id. */
  by_task: Map<string, TaskSignal>;
  counts: {
    tasks: number;
    open: number;
    terminal: number;
    overdue: number;
    at_risk: number;
    absent: number;
    quiet: number;
    completable: number;
    nudgeable: number;
  };
  /** Task ids whose status differs from `last_tick.task_states`. */
  changed_task_ids: string[];
  /** Proposals still awaiting a human decision. */
  open_proposal_ids: string[];
  /** `proposed` escalation proposals, and the task ids they already cover. */
  covered_task_ids: Set<string>;
  /** Instruction attempts in untrusted text that are not yet recorded as `tl_anomaly`. */
  anomalies: AnomalyFinding[];
}

/* ---------------------------------------------------------------- the plan */

/**
 * Every kind of thing a tick can decide to do. Note the absentees: `advance_stage` and
 * `reject` are **not** here and never will be — a candidate decision leaves the engine only
 * as `propose_decision`, which becomes a `tl_proposed_action` (spec §9, asserted in
 * `tests/engine/interview-plan.test.ts`). `request_scorecard` is absent too, on purpose:
 * chasing a scorecard is the ordinary `nudge` path over a `submit_scorecard` task, so the
 * interview loop reuses loop 1's nudging, batching, cadence and absence rules unchanged.
 */
export const PLANNED_ACTION_KINDS = [
  'anomaly',
  'complete_task',
  'move_due_date',
  'nudge',
  'escalate',
  'transition_cycle',
  'refresh_packet',
  'close_cycle',
  'place_hold',
  'rebook',
  'post_change',
  'propose_decision',
] as const;
export type PlannedActionKind = (typeof PLANNED_ACTION_KINDS)[number];

/** Record ids backing an action — never prose, never copied values (spec §9). */
interface PlannedActionBase {
  evidence_refs: string[];
}

/** One task inside a bundled nudge. */
export interface PlannedNudgeTask {
  task_id: string;
  kind: TlTaskKind;
  /** The attempt this task's nudge *will be* — `tl_task.attempt_n + 1`. */
  attempt_n: number;
}

/**
 * Send **one** policy-checked reminder to one person, covering every task of theirs that
 * cleared the gate this tick (docs/DECISIONS.md D17). Exactly one `nudge` action per
 * recipient per tick: the executor sends one `channel.sendDirect` and writes one `tl_nudge`
 * per bundled task, all carrying that message's `message_ref` and this `policy_check`.
 *
 * `attempt_n` is the **DM's** attempt number — the maximum across `tasks` — and is what
 * picks `first` vs `followup`; each task's own attempt number lives in `tasks[].attempt_n`,
 * because tasks in one bundle can be at different points on the ladder.
 */
export interface PlannedNudge extends PlannedActionBase {
  kind: 'nudge';
  to_worker_id: WorkerId;
  /** The bundled task ids, in plan order (sorted by task id). */
  task_ids: string[];
  tasks: PlannedNudgeTask[];
  template_id: string;
  /** The highest `attempt_n` in `tasks` — the reminder number the DM prints. */
  attempt_n: number;
  /** Every bundled task passed the same gate; each `tl_nudge` records this check. */
  policy_check: TlNudgePolicyCheck;
}

/**
 * Move a task's `due_at` because its owner is away. An engine write on a `tl_task`
 * (allowlisted `tl_*` state), not a proposal: no human decision of record is involved.
 */
export interface PlannedMoveDueDate extends PlannedActionBase {
  kind: 'move_due_date';
  task_id: string;
  from: InstantISO;
  to: InstantISO;
  reason: string;
}

/** The shadow record that completes a task has appeared (spec §7 step 2). */
export interface PlannedCompleteTask extends PlannedActionBase {
  kind: 'complete_task';
  task_id: string;
  submission_id: string;
}

/**
 * One escalation per cycle per tick, bundling every offender — the spec §8 demo is
 * "one escalation with evidence instead of forty reminders". Becomes a
 * `tl_proposed_action` of kind `escalate` via `bin/propose.mjs`; a human decides.
 */
export interface PlannedEscalate extends PlannedActionBase {
  kind: 'escalate';
  task_ids: string[];
  to_worker_id: WorkerId;
  rationale: string;
}

/** The calibration inputs changed; the packet has to be reassembled (spec §7 step 2). */
export interface PlannedRefreshPacket extends PlannedActionBase {
  kind: 'refresh_packet';
  /** `kind` is the union discriminant, so the packet's own kind is `packet_kind`. */
  packet_kind: TlPacketKind;
  inputs_hash: string;
}

/** Cycle status move, pre-validated against `templates/loop-states.yml`. */
export interface PlannedTransitionCycle extends PlannedActionBase {
  kind: 'transition_cycle';
  from: TlCycleState;
  to: TlCycleState;
  reason: string;
}

/** Everything is terminal and decided — run `bin/cycle.mjs close` (spec §7 step 4). */
export interface PlannedCloseCycle extends PlannedActionBase {
  kind: 'close_cycle';
  cycle_id: string;
}

/** Untrusted text tried to instruct the agent. Recorded, never obeyed (spec §9). */
export interface PlannedAnomaly extends PlannedActionBase {
  kind: 'anomaly';
  source_ref: string;
  excerpt: string;
  rule: string;
}

/* ------------------------------------------- interview loop (M2, block B2.1) */

/**
 * Book the panel. The executor calls `availability.placeHold` on the **composed** port —
 * which refuses if Rippling reports any attendee away, whatever the calendar says — and
 * writes a `tl_interview_slot` carrying the returned `hold_ref` (spec §4, §8 loop 2).
 */
export interface PlannedPlaceHold extends PlannedActionBase {
  kind: 'place_hold';
  application_id: string;
  slot: Slot;
  /** The panel, in panel order: hiring manager first. */
  attendee_ids: WorkerId[];
}

/**
 * An interviewer declined; a same-team, same-level-rank peer takes their place on the same
 * slot. A staffing change, not a decision of record: nobody's candidacy moves (spec §9).
 */
export interface PlannedRebook extends PlannedActionBase {
  kind: 'rebook';
  slot_id: string;
  declined_worker_id: WorkerId;
  substitute_worker_id: WorkerId;
}

/** "The loop posts the change" (spec §8 loop 2) — one message to the summary channel. */
export interface PlannedPostChange extends PlannedActionBase {
  kind: 'post_change';
  text: string;
}

/**
 * The one shape a candidate decision may take. The executor writes a `tl_proposed_action`
 * via `bin/propose.mjs`; a named human decides it in `bin/decide.mjs` and executes the
 * stage move in Rippling. The engine never advances and never rejects (spec §9).
 */
export interface PlannedProposeDecision extends PlannedActionBase {
  kind: 'propose_decision';
  decision_kind: 'advance_stage' | 'reject';
  application_id: string;
  rationale: string;
}

export type PlannedAction =
  | PlannedNudge
  | PlannedMoveDueDate
  | PlannedCompleteTask
  | PlannedEscalate
  | PlannedRefreshPacket
  | PlannedTransitionCycle
  | PlannedCloseCycle
  | PlannedAnomaly
  | PlannedPlaceHold
  | PlannedRebook
  | PlannedPostChange
  | PlannedProposeDecision;

/** The output of one tick. `changed: false` is the idempotence proof (spec §10). */
export interface TickPlan {
  /** sha256 of the cycle id and `now` — stamped on every ledger line of this tick. */
  tick_id: string;
  actions: PlannedAction[];
  detected: DetectSummary;
  changed: boolean;
}
