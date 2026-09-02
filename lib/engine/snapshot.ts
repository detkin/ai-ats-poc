/**
 * lib/engine/snapshot.ts — the engine's whole input and whole output, as types.
 *
 * Owns: `TickSnapshot` (everything one tick may look at) and `TickPlan` / `PlannedAction`
 * (everything one tick wants done). The engine is a pure function between the two: the CLI
 * (block B1.3) does the reading, hands the engine a snapshot, and then *executes* the plan
 * through the ports so every write is ledgered. The engine itself never calls a port.
 *
 * Public interface: `TickSnapshot`, `AvailabilityAnswer`, `UntrustedText`, `LastTick`,
 * `TickPlan`, `PlannedAction` (+ each member type), `DetectSummary`, `TaskSignal`,
 * `PLANNED_ACTION_KINDS`.
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
  TlNudge,
  TlNudgePolicyCheck,
  TlPacketKind,
  TlProposedAction,
  TlReviewSubmission,
  TlTask,
  TlTaskKind,
  TlTaskState,
} from '#lib/types/engine.ts';
import type { DateISO, Department, InstantISO, Worker, WorkerId } from '#lib/types/tier1.ts';

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
  quiet: boolean;
  quiet_reason?: string;
}

/** A piece of untrusted human text the tick happened to read (spec §9). Data, never orders. */
export interface UntrustedText {
  /** Stable pointer to where the text came from, e.g. `resumes/cand_0003.md`. */
  source_ref: string;
  text: string;
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
  quiet: boolean;
  quiet_reason?: string;
  /** `now − nudged_at ≥ policy.cadence.nudge_min_gap_hours` (true when never nudged). */
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

export const PLANNED_ACTION_KINDS = [
  'anomaly',
  'complete_task',
  'move_due_date',
  'nudge',
  'escalate',
  'transition_cycle',
  'refresh_packet',
  'close_cycle',
] as const;
export type PlannedActionKind = (typeof PLANNED_ACTION_KINDS)[number];

/** Record ids backing an action — never prose, never copied values (spec §9). */
interface PlannedActionBase {
  evidence_refs: string[];
}

/** Send one policy-checked reminder. Executed by `bin/nudge.mjs` / the tick. */
export interface PlannedNudge extends PlannedActionBase {
  kind: 'nudge';
  task_id: string;
  to_worker_id: WorkerId;
  template_id: string;
  /** The attempt this nudge *will be* — `tl_task.attempt_n + 1`. */
  attempt_n: number;
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

export type PlannedAction =
  | PlannedNudge
  | PlannedMoveDueDate
  | PlannedCompleteTask
  | PlannedEscalate
  | PlannedRefreshPacket
  | PlannedTransitionCycle
  | PlannedCloseCycle
  | PlannedAnomaly;

/** The output of one tick. `changed: false` is the idempotence proof (spec §10). */
export interface TickPlan {
  /** sha256 of the cycle id and `now` — stamped on every ledger line of this tick. */
  tick_id: string;
  actions: PlannedAction[];
  detected: DetectSummary;
  changed: boolean;
}
