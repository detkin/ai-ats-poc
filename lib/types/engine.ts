/**
 * lib/types/engine.ts — Tier-2 engine state and Tier-3 shadow objects (`tl_*`).
 *
 * Owns: the shape of every record the engine itself creates. Tier 2 (`tl_cycle`, `tl_task`,
 * `tl_nudge`, `tl_packet`, `tl_proposed_action`, `tl_match`, `tl_anomaly`) models concepts
 * Rippling has no object for. Tier 3 (`tl_interview_slot`, `tl_scorecard`,
 * `tl_review_submission`) are the labelled, temporary shadows for the two API gaps.
 * `tl_agent_action` is the append-only ledger entry and is NOT state.
 *
 * Public interface: the record types below, `STATE_KINDS` / `StateKind`, the
 * `StateRecordMap` kind→record map used by `StatePort`, `NewRecord`/`RecordPatch`, and
 * `Tier1ValueField` / `NoTier1Values` which encode the "never hold a real object's value" rule.
 *
 * Spec: docs/SPEC.md §3 (three tiers), §6 (data model), §7 (states), §9 (safety);
 * docs/PLAN.md §2.2.
 *
 * Naming note: spec §6 names reference columns bare ("cycle", "task", "participant").
 * This module normalizes them to `<thing>_id` / `<thing>_worker_id` so adapters and CLIs
 * agree on one spelling. Semantics are unchanged.
 */

import type { AdapterMode } from '#lib/ports/context.ts';
import type {
  ApplicationId,
  CandidateId,
  DepartmentId,
  InstantISO,
  JobRequisitionId,
  WorkerId,
} from '#lib/types/tier1.ts';

/** Canonical JSON value — payloads, criteria scores, args summaries. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type TlCycleId = string;
export type TlTaskId = string;
export type TlNudgeId = string;
export type TlPacketId = string;
export type TlProposedActionId = string;
export type TlMatchId = string;
export type TlAnomalyId = string;
export type TlInterviewSlotId = string;
export type TlScorecardId = string;
export type TlReviewSubmissionId = string;
export type TlAgentActionId = string;

/** Every tl_* state record carries these. Ids are assigned by the State adapter. */
export interface TlRecordBase {
  /** `tl_<kind>_<8 hex>`. */
  id: string;
  created_at: InstantISO;
  updated_at: InstantISO;
  /** Acting worker at creation time (spec §9: agent acts as a user). */
  created_by: WorkerId;
}

/* ------------------------------------------------------------------ tl_cycle */

export const CYCLE_TYPES = ['review', 'interview', 'approval', 'rediscovery'] as const;
export type TlCycleType = (typeof CYCLE_TYPES)[number];

/**
 * Canonical cycle states (spec §7). `templates/loop-states.yml` (block B0.2) is the
 * enforcing source of truth; this union exists so the compiler catches typos in code paths.
 */
export const CYCLE_STATES = ['configured', 'running', 'escalated', 'closing', 'closed'] as const;
export type TlCycleState = (typeof CYCLE_STATES)[number];

export interface TlCycleScope {
  department_ids?: DepartmentId[];
  application_id?: ApplicationId;
  requisition_id?: JobRequisitionId;
}

export interface TlCycle extends TlRecordBase {
  type: TlCycleType;
  name: string;
  status: TlCycleState;
  owner_worker_id: WorkerId;
  /** Deadline for the cycle as a whole. */
  deadline: InstantISO;
  /** Which tenant policy produced this cycle, e.g. `tenant/policy.yml@<sha>`. */
  policy_ref: string;
  opened_at: InstantISO | null;
  closed_at?: InstantISO;
  scope: TlCycleScope;
}

/* -------------------------------------------------------------------- tl_task */

export const TASK_KINDS = [
  'write_self_review',
  'write_peer_review',
  'write_manager_review',
  'submit_scorecard',
  'approve_req',
  'enter_comp',
  'attend_interview',
] as const;
export type TlTaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATES = ['pending', 'nudged', 'done', 'waived', 'escalated'] as const;
export type TlTaskState = (typeof TASK_STATES)[number];

export interface TlTask extends TlRecordBase {
  cycle_id: TlCycleId;
  participant_worker_id: WorkerId;
  kind: TlTaskKind;
  /** Id of the real (or shadow) record whose appearance completes this task. */
  external_ref: string | null;
  /** May be moved by policy (e.g. absence → return + N days). */
  due_at: InstantISO;
  /** Set once at creation and never changed; the audit answer to "was this moved?". */
  original_due_at: InstantISO;
  status: TlTaskState;
  attempt_n: number;
  nudged_at?: InstantISO;
}

/* ------------------------------------------------------------------- tl_nudge */

export const NUDGE_CHANNELS = ['slack_dm', 'slack_channel', 'email'] as const;
export type TlNudgeChannel = (typeof NUDGE_CHANNELS)[number];

/** Why a nudge was or was not allowed. Every field is recorded, pass or fail (spec §10). */
export interface TlNudgePolicyCheck {
  absent: boolean;
  quiet_hours: boolean;
  attempts_ok: boolean;
  recipient_in_cycle: boolean;
  passed: boolean;
  reasons: string[];
}

export interface TlNudge extends TlRecordBase {
  task_id: TlTaskId;
  cycle_id: TlCycleId;
  channel: TlNudgeChannel;
  sent_at: InstantISO | null;
  attempt_n: number;
  template_id: string;
  delivered: boolean;
  /** Adapter's handle on the sent message, when delivered. */
  message_ref?: string;
  policy_check: TlNudgePolicyCheck;
}

/* ------------------------------------------------------------------ tl_packet */

export const PACKET_KINDS = ['calibration', 'debrief', 'approval_summary', 'match_list'] as const;
export type TlPacketKind = (typeof PACKET_KINDS)[number];

/**
 * Provenance for one claim in a packet body (spec §5 "story-bank provenance", §10).
 * `source` = a value read straight off records; `derived` = an LLM/engine join over them.
 */
export interface TlCitation {
  claim_id: string;
  record_ids: string[];
  kind: 'source' | 'derived';
}

export interface TlPacket extends TlRecordBase {
  cycle_id: TlCycleId;
  kind: TlPacketKind;
  /** sha256 of the canonical inputs; a changed hash is what triggers a refresh. */
  inputs_hash: string;
  body: string;
  citations: TlCitation[];
  judged_score?: number;
  reviewed_by?: WorkerId;
}

/* ---------------------------------------------------------- tl_proposed_action */

export const PROPOSED_ACTION_KINDS = [
  'advance_stage',
  'reject',
  'set_rating',
  'set_comp',
  'open_req',
  'send_offer',
  'reach_out',
  'escalate',
  'move_due_date',
] as const;
export type TlProposedActionKind = (typeof PROPOSED_ACTION_KINDS)[number];

export const PROPOSAL_STATES = ['proposed', 'approved', 'declined'] as const;
export type TlProposalState = (typeof PROPOSAL_STATES)[number];

/**
 * The only way a decision of record enters the system (spec §9). Written by
 * `bin/propose.mjs`, decided by a named human via `bin/decide.mjs`.
 */
export interface TlProposedAction extends TlRecordBase {
  cycle_id: TlCycleId;
  kind: TlProposedActionKind;
  payload: Record<string, JsonValue>;
  rationale: string;
  /** Record ids backing the rationale — never prose. */
  evidence_refs: string[];
  status: TlProposalState;
  decided_by?: WorkerId;
  decided_at?: InstantISO;
  decision_note?: string;
}

/* ------------------------------------------------------------------- tl_match */

export const MATCH_SOURCES = ['silver_medalist', 'alumni', 'internal', 'referral'] as const;
export type TlMatchSource = (typeof MATCH_SOURCES)[number];

export const MATCH_STATES = ['suggested', 'shortlisted', 'dismissed'] as const;
export type TlMatchState = (typeof MATCH_STATES)[number];

export interface TlMatch extends TlRecordBase {
  requisition_id: JobRequisitionId;
  /** Exactly one of these is set; both are ids, never copied attributes. */
  subject_worker_id: WorkerId | null;
  subject_candidate_id: CandidateId | null;
  source: TlMatchSource;
  criteria_scores: Record<string, number>;
  explanation: string;
  citations: TlCitation[];
  status: TlMatchState;
}

/* ----------------------------------------------------------------- tl_anomaly */

/**
 * A record that untrusted content tried to instruct the agent (spec §9). Written, never obeyed.
 * `excerpt` is capped at 200 characters by `lib/safety/allowlist.ts`.
 */
export interface TlAnomaly extends TlRecordBase {
  cycle_id: TlCycleId | null;
  ts: InstantISO;
  source_ref: string;
  excerpt: string;
  rule: string;
}

/* ------------------------------------------------ Tier 3 — shadow objects */

/** Marker every Tier-3 object carries so a grep finds the whole seam (spec §3). */
export interface TlShadowBase extends TlRecordBase {
  shadow: true;
  /** The real application/worker id this shadow hangs off. */
  real_ref: string;
}

export interface TlInterviewSlot extends TlShadowBase {
  application_id: ApplicationId;
  interviewer_worker_ids: WorkerId[];
  start_at: InstantISO;
  end_at: InstantISO;
  /** Handle returned by the Availability port when the hold was placed. */
  hold_ref: string | null;
  status: 'proposed' | 'held' | 'declined' | 'cancelled' | 'completed';
}

export interface TlScorecard extends TlShadowBase {
  application_id: ApplicationId;
  interviewer_worker_id: WorkerId;
  status: 'pending' | 'submitted' | 'waived';
  /** Pointer to untrusted free text; the body is never inlined into state. */
  body_ref: string | null;
  submitted_at?: InstantISO;
}

export const REVIEW_SUBMISSION_KINDS = ['self', 'peer', 'manager'] as const;
export type TlReviewSubmissionKind = (typeof REVIEW_SUBMISSION_KINDS)[number];

export interface TlReviewSubmission extends TlShadowBase {
  cycle_id: TlCycleId;
  subject_worker_id: WorkerId;
  author_worker_id: WorkerId;
  kind: TlReviewSubmissionKind;
  status: 'pending' | 'submitted' | 'waived';
  body_ref: string | null;
  submitted_at?: InstantISO;
}

/* -------------------------------------------------- tl_agent_action (ledger) */

export const LEDGER_RESULTS = ['ok', 'rejected', 'error'] as const;
export type TlLedgerResult = (typeof LEDGER_RESULTS)[number];

export interface TlActor {
  worker_id: WorkerId;
  email: string;
  /** Which port family produced the call: `fixture`, `rippling` or `bridge`. */
  adapter: AdapterMode;
}

export interface TlTokenUsage {
  input: number;
  output: number;
}

/**
 * One append-only ledger line per port call (spec §7 step 5). Not a state record:
 * it has no `updated_at` and `LedgerPort` exposes no update or delete.
 */
export interface TlAgentAction {
  id: TlAgentActionId;
  cycle_id: TlCycleId | null;
  ts: InstantISO;
  actor: TlActor;
  /** Port name, e.g. `state`, `channel`. */
  port: string;
  /** Method name on that port, e.g. `create`, `sendDirect`. */
  function: string;
  /** sha256 hex of the canonical JSON of the args. */
  args_hash: string;
  /** Short, PII-free description of the args. */
  args_summary: string;
  result: TlLedgerResult;
  /** Id created by the call, when it created something. */
  result_ref?: string;
  permission_context: string[];
  tick_id?: string;
  tokens?: TlTokenUsage;
}

/* ------------------------------------------------------- State kind registry */

/** The `kind` discriminator accepted by `StatePort`. */
export const STATE_KINDS = [
  'cycle',
  'task',
  'nudge',
  'packet',
  'proposed_action',
  'match',
  'interview_slot',
  'scorecard',
  'review_submission',
  'anomaly',
] as const;
export type StateKind = (typeof STATE_KINDS)[number];

/** kind → record type. `StatePort` is generic over this map. */
export interface StateRecordMap {
  cycle: TlCycle;
  task: TlTask;
  nudge: TlNudge;
  packet: TlPacket;
  proposed_action: TlProposedAction;
  match: TlMatch;
  interview_slot: TlInterviewSlot;
  scorecard: TlScorecard;
  review_submission: TlReviewSubmission;
  anomaly: TlAnomaly;
}

export type TlStateRecord = StateRecordMap[StateKind];

/** Input to `StatePort.create` — the adapter assigns id, timestamps, and the actor. */
export type NewRecord<T extends TlRecordBase> = Omit<
  T,
  'id' | 'created_at' | 'updated_at' | 'created_by'
> & { created_by?: WorkerId };

/** Input to `StatePort.update`. Identity and provenance are immutable. */
export type RecordPatch<T extends TlRecordBase> = Partial<
  Omit<T, 'id' | 'created_at' | 'created_by'>
>;

/** Input to `LedgerPort.append`. */
export type NewLedgerEntry = Omit<TlAgentAction, 'id'>;

/* --------------------------------------- the "never hold a real value" rule */

/**
 * Value fields that belong to Tier-1 objects. Spec §3: the engine stores their *ids* and
 * re-reads their values every tick. A tl_* record that declared one of these would be a
 * shadow pipeline. `tests/types/engine-shapes.test.ts` asserts none of them do.
 */
export const TIER1_VALUE_FIELDS = [
  'rating',
  'base_annual',
  'compensation',
  'stage',
  'min',
  'mid',
  'max',
  'first_name',
  'last_name',
  'work_email',
  'title',
  'resume_ref',
] as const;
export type Tier1ValueField = (typeof TIER1_VALUE_FIELDS)[number];

/**
 * Compile-time guard: `NoTier1Values<T>` is `T` when `T` declares no Tier-1 value field,
 * and `never` otherwise — so `x satisfies NoTier1Values<TlTask>` fails to compile on a breach.
 */
export type NoTier1Values<T> = Extract<keyof T, Tier1ValueField> extends never ? T : never;
