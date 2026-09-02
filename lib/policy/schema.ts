/**
 * Tenant policy types (block B0.3).
 *
 * Owns: the TypeScript shape of `tenant/policy.yml` — the machine-readable tenant
 * layer the engine reads instead of parsing prose (spec §5 "policy is data, not
 * prompt", §7 cadence/escalation, §8 loops 1 and 2; plan §2.6; DECISIONS D3).
 *
 * Public interface:
 *   types    TenantPolicy, TenantIdentity, CadencePolicy, QuietHoursPolicy,
 *            ChannelsPolicy, EscalationPolicy, AbsencePolicy, StaggerDays,
 *            ReviewCyclePolicy, InterviewLoopPolicy, ChannelKind, EscalationTarget
 *   consts   CHANNEL_KINDS, ESCALATION_TARGETS, POLICY_SECTIONS, POLICY_TOP_LEVEL_KEYS
 *
 * This module is types + literal unions only: no I/O, no validation logic
 * (that is `lib/policy/load.ts`).
 */

/** Delivery surfaces a nudge/escalation/summary may use. */
export const CHANNEL_KINDS = ['slack_dm', 'slack_channel'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Who an escalation is addressed to. */
export const ESCALATION_TARGETS = ['cycle_owner', 'department_head'] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

/** Tenant identity: display name and which seeded identity acts by default. */
export interface TenantIdentity {
  name: string;
  acting_identity_default: string;
}

/** Tick and nudge rhythm (spec §7 step 2). */
export interface CadencePolicy {
  tick_interval_hours: number;
  nudge_min_gap_hours: number;
  max_attempts: number;
}

/** When the engine must stay silent (spec §7 step 1). */
export interface QuietHoursPolicy {
  respect_location_hours: boolean;
  weekends: boolean;
  holidays: boolean;
}

/** Where messages go (spec §7 step 2, "channel by policy"). */
export interface ChannelsPolicy {
  nudge: ChannelKind;
  escalation: ChannelKind;
  summary: ChannelKind;
  /** Slack channel name, including the leading '#'. */
  summary_channel: string;
}

/** Escalation thresholds (spec §7 step 3). */
export interface EscalationPolicy {
  overdue_days: number;
  after_attempts: number;
  escalate_to: EscalationTarget;
}

/** Absence handling — Rippling absence is authoritative (spec §4, §8 loop 1). */
export interface AbsencePolicy {
  move_due_date_days_after_return: number;
  skip_nudge: boolean;
}

/** Days after `opened_at` at which each review kind falls due. */
export interface StaggerDays {
  self: number;
  peer: number;
  manager: number;
}

/** Review-cycle shape (spec §8 loop 1). */
export interface ReviewCyclePolicy {
  stagger_days: StaggerDays;
  peers_per_subject: number;
}

/** Interview-loop shape (spec §8 loop 2). */
export interface InterviewLoopPolicy {
  panel_size: number;
  scorecard_due_hours: number;
  substitute_same_level: boolean;
}

/** The whole of `tenant/policy.yml`. */
export interface TenantPolicy {
  /** `true` in `policy.template.yml`; doctor refuses to tick while it is true. */
  template: boolean;
  tenant: TenantIdentity;
  cadence: CadencePolicy;
  quiet_hours: QuietHoursPolicy;
  channels: ChannelsPolicy;
  escalation: EscalationPolicy;
  absence: AbsencePolicy;
  review_cycle: ReviewCyclePolicy;
  interview_loop: InterviewLoopPolicy;
}

/** Required object sections, in the order the validator reports them. */
export const POLICY_SECTIONS = [
  'tenant',
  'cadence',
  'quiet_hours',
  'channels',
  'escalation',
  'absence',
  'review_cycle',
  'interview_loop',
] as const;
export type PolicySection = (typeof POLICY_SECTIONS)[number];

/** Every key allowed at the top level. Anything else is a typo. */
export const POLICY_TOP_LEVEL_KEYS = ['template', ...POLICY_SECTIONS] as const;
