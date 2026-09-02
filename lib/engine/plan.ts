/**
 * lib/engine/plan.ts — steps 2–4 of the tick: what the policy says to do (spec §7).
 *
 * Owns: `planTick`, the one function that turns a `TickSnapshot` into a `TickPlan`. It is
 * pure — no ports, no clock, no environment — so a tick is reproducible and testable, and
 * so the *decision* to write is separable from the write itself. Executing the plan (and
 * ledgering every call) belongs to `bin/tick.mjs`, block B1.3.
 *
 * Public interface:
 *   planTick(snapshot: TickSnapshot): TickPlan
 *   policyCheckFor(signal): TlNudgePolicyCheck        // also used by bin/nudge.mjs
 *   nudgeTemplateId(kind, attemptN): string
 *   tickId(cycleId, now): string
 *
 * The rules, applied in this order (docs/PLAN.md §4 block B1.1):
 *   a. instruction attempts in untrusted text become `anomaly` actions and nothing else;
 *   b. a task whose `tl_review_submission` has been submitted → `complete_task`;
 *   c. an absent participant is never nudged; the due date moves once, to
 *      `until + policy.absence.move_due_date_days_after_return` days;
 *   d. overdue, present, audible, gap elapsed, attempts left → `nudge`;
 *   e. overdue past `after_attempts` or `overdue_days` → **one** `escalate` for the whole
 *      cycle, bundling every offender with evidence (spec §8: one escalation, not forty);
 *   f. running + an outstanding escalation → `escalated`; escalated + none → `running`;
 *   g. every task terminal and every proposal decided → `closing` + `close_cycle`;
 *   h. calibration inputs hash moved → `refresh_packet`.
 *
 * Idempotence (spec §10): `planTick(applyPlan(s, planTick(s)))` has zero actions.
 *
 * Spec: docs/SPEC.md §7, §8 loop 1, §9, §10; docs/PLAN.md §2.5, §2.6.
 */

import { detect } from '#lib/engine/detect.ts';
import { sha256Hex } from '#lib/engine/hash.ts';
import { addDays, endOfDay, parseInstant } from '#lib/engine/time.ts';
import { assertTransition } from '#lib/states/index.ts';
import type {
  DetectSummary,
  PlannedAction,
  PlannedEscalate,
  TaskSignal,
  TickPlan,
  TickSnapshot,
} from '#lib/engine/snapshot.ts';
import type { TlCycleState, TlNudge, TlNudgePolicyCheck, TlTaskKind } from '#lib/types/engine.ts';
import type { WorkerId } from '#lib/types/tier1.ts';

/** Deterministic tick id: sha256 over the cycle id and the frozen `now`. */
export function tickId(cycleId: string, now: string): string {
  return sha256Hex(`${cycleId}|${now}`);
}

/**
 * Template a nudge is rendered from (docs/DECISIONS.md D7: templates with injected facts,
 * no LLM on the tick path). Block B1.4 ships the matching files under `templates/nudges/`.
 */
export function nudgeTemplateId(kind: TlTaskKind, attemptN: number): string {
  return `nudge.${kind}.${attemptN <= 1 ? 'first' : 'followup'}`;
}

/**
 * The full policy check for one task, pass or fail — recorded on every `tl_nudge` so the
 * ledger can answer "why was this sent?" and "why was this not?" (spec §10).
 */
export function policyCheckFor(signal: TaskSignal): TlNudgePolicyCheck {
  const reasons: string[] = [];
  if (!signal.recipient_in_cycle) reasons.push('recipient_not_in_cycle');
  if (signal.absent)
    reasons.push(`absent${signal.absent_reason ? `:${signal.absent_reason}` : ''}`);
  if (signal.quiet)
    reasons.push(`quiet_hours${signal.quiet_reason ? `:${signal.quiet_reason}` : ''}`);
  if (signal.attempts_left <= 0) reasons.push('max_attempts_reached');
  if (!signal.nudge_gap_ok) reasons.push('nudge_gap_not_elapsed');
  if (signal.terminal) reasons.push('task_terminal');

  return {
    recipient_in_cycle: signal.recipient_in_cycle,
    absent: signal.absent,
    quiet_hours: signal.quiet,
    attempts_ok: signal.attempts_left > 0,
    passed: reasons.length === 0,
    reasons,
  };
}

/** Nudge ids already recorded against a task, sorted — evidence for nudges and escalations. */
function nudgeRefsByTask(nudges: TlNudge[]): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  for (const nudge of [...nudges].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const list = byTask.get(nudge.task_id);
    if (list === undefined) byTask.set(nudge.task_id, [nudge.id]);
    else list.push(nudge.id);
  }
  return byTask;
}

/**
 * Where a moved due date lands. `until` is the **last day of the absence**, inclusive, so the
 * day the person is actually back is `until + 1`; the policy's grace days are counted from
 * there. A PTO block ending on a Thursday with `move_due_date_days_after_return: 2` therefore
 * lands on the Sunday two days after the Friday return, at 23:59:59Z — not on the Saturday,
 * which would spend one of the grace days on a day the person was still away.
 */
function movedDueAt(until: string, daysAfter: number): string {
  return endOfDay(addDays(until, daysAfter + 1));
}

/** Who hears about an escalation (`escalation.escalate_to`), with a safe fallback. */
function escalationRecipient(
  snapshot: TickSnapshot,
  offenders: TaskSignal[],
): { worker_id: WorkerId; note: string } {
  const owner = snapshot.cycle.owner_worker_id;
  if (snapshot.policy.escalation.escalate_to !== 'department_head') {
    return { worker_id: owner, note: 'cycle owner' };
  }
  const departments = new Set<string>();
  for (const signal of offenders) {
    const worker = snapshot.workers.get(signal.participant_worker_id);
    if (worker !== undefined) departments.add(worker.department_id);
  }
  const only = departments.size === 1 ? [...departments][0] : undefined;
  const head = only === undefined ? undefined : snapshot.departments?.get(only)?.head_worker_id;
  if (head !== undefined) return { worker_id: head, note: `head of ${only ?? 'department'}` };
  return { worker_id: owner, note: 'cycle owner (offenders span departments)' };
}

/** True when a signal is an escalation offender under `policy.escalation`. */
function isOffender(signal: TaskSignal, snapshot: TickSnapshot): boolean {
  const { escalation } = snapshot.policy;
  if (signal.terminal || signal.submission_id !== undefined) return false;
  if (!signal.overdue || signal.absent) return false;
  return (
    signal.attempt_n >= escalation.after_attempts || signal.overdue_days >= escalation.overdue_days
  );
}

/** Rule (e): one escalation for the cycle, or none. */
function planEscalation(
  snapshot: TickSnapshot,
  detected: DetectSummary,
  nudgeRefs: Map<string, string[]>,
): PlannedEscalate | undefined {
  const offenders = detected.signals.filter(
    (s) => isOffender(s, snapshot) && !detected.covered_task_ids.has(s.task_id),
  );
  if (offenders.length === 0) return undefined;

  const taskIds = offenders.map((s) => s.task_id);
  const evidence = [...taskIds];
  for (const id of taskIds) evidence.push(...(nudgeRefs.get(id) ?? []));

  const { escalation } = snapshot.policy;
  const recipient = escalationRecipient(snapshot, offenders);
  const worst = offenders.reduce((acc, s) => Math.max(acc, s.overdue_days), 0);
  const rationale =
    `${offenders.length} task(s) in cycle ${snapshot.cycle.id} are past due ` +
    `(worst: ${worst} day(s)) or past ${escalation.after_attempts} nudge attempt(s). ` +
    `Threshold: ${escalation.overdue_days} day(s) overdue or ${escalation.after_attempts} ` +
    `attempts. Routed to ${recipient.note}. Evidence: ${evidence.length} record id(s).`;

  return {
    kind: 'escalate',
    task_ids: taskIds,
    to_worker_id: recipient.worker_id,
    rationale,
    evidence_refs: evidence,
  };
}

/** Rules (f) and (g): the single cycle-status move this tick warrants, if any. */
function nextCycleStatus(
  current: TlCycleState,
  closable: boolean,
  escalationOutstanding: boolean,
): TlCycleState | undefined {
  if (current === 'closed' || current === 'configured') return undefined;
  if (closable) return current === 'closing' ? undefined : 'closing';
  if (current === 'running' && escalationOutstanding) return 'escalated';
  if (current === 'escalated' && !escalationOutstanding) return 'running';
  return undefined;
}

/**
 * One tick, as a plan. Deterministic and side-effect free: the same snapshot always
 * produces the same actions in the same order.
 */
export function planTick(snapshot: TickSnapshot): TickPlan {
  const detected = detect(snapshot);
  const { policy } = snapshot;
  const nudgeRefs = nudgeRefsByTask(snapshot.nudges);
  const actions: PlannedAction[] = [];

  // (a) Untrusted text that tried to give orders: recorded, never acted on.
  for (const finding of detected.anomalies) {
    actions.push({
      kind: 'anomaly',
      source_ref: finding.source_ref,
      excerpt: finding.excerpt,
      rule: finding.rule,
      evidence_refs: [finding.source_ref],
    });
  }

  const completedTaskIds = new Set<string>();

  for (const signal of detected.signals) {
    // (b) The shadow record appeared — the task is done, whatever else is true of it.
    if (!signal.terminal && signal.submission_id !== undefined) {
      completedTaskIds.add(signal.task_id);
      actions.push({
        kind: 'complete_task',
        task_id: signal.task_id,
        submission_id: signal.submission_id,
        evidence_refs: [signal.task_id, signal.submission_id],
      });
      continue;
    }
    if (signal.terminal) continue;

    // (c) Absent: never a nudge; the due date moves once, then stays put.
    if (signal.absent) {
      if (signal.absent_until === undefined) continue;
      const to = movedDueAt(signal.absent_until, policy.absence.move_due_date_days_after_return);
      if (parseInstant(to) <= parseInstant(signal.due_at)) continue;
      const reason =
        `participant absent until ${signal.absent_until}` +
        `${signal.absent_reason === undefined ? '' : ` (${signal.absent_reason})`}; ` +
        `+${policy.absence.move_due_date_days_after_return} day(s) per policy`;
      actions.push({
        kind: 'move_due_date',
        task_id: signal.task_id,
        from: signal.due_at,
        to,
        reason,
        evidence_refs: [signal.task_id],
      });
      continue;
    }

    // (d) Nudge, only when every policy gate passes.
    const check = policyCheckFor(signal);
    if (check.passed && signal.overdue && signal.status !== 'escalated') {
      actions.push({
        kind: 'nudge',
        task_id: signal.task_id,
        to_worker_id: signal.participant_worker_id,
        template_id: nudgeTemplateId(signal.kind, signal.attempt_n + 1),
        attempt_n: signal.attempt_n + 1,
        policy_check: check,
        evidence_refs: [signal.task_id, ...(nudgeRefs.get(signal.task_id) ?? [])],
      });
    }
  }

  // (e) One escalation per cycle per tick, bundling every offender.
  const escalation = planEscalation(snapshot, detected, nudgeRefs);
  if (escalation !== undefined) actions.push(escalation);

  // (f)/(g) Cycle status. "Terminal" counts tasks this tick just completed.
  const openAfterTick = detected.signals.filter(
    (s) => !s.terminal && !completedTaskIds.has(s.task_id),
  );
  const escalationOutstanding =
    escalation !== undefined ||
    snapshot.proposals.some((p) => p.status === 'proposed' && p.kind === 'escalate');
  const closable =
    detected.signals.length > 0 &&
    openAfterTick.length === 0 &&
    detected.open_proposal_ids.length === 0 &&
    escalation === undefined;

  const target = nextCycleStatus(snapshot.cycle.status, closable, escalationOutstanding);
  if (target !== undefined) {
    assertTransition('cycle', snapshot.cycle.status, target);
    actions.push({
      kind: 'transition_cycle',
      from: snapshot.cycle.status,
      to: target,
      reason: closable
        ? 'all tasks terminal and all proposals decided'
        : target === 'escalated'
          ? 'an escalation is awaiting a decision'
          : 'no escalation outstanding',
      evidence_refs: [snapshot.cycle.id, ...detected.open_proposal_ids],
    });
  }
  if (closable && snapshot.cycle.status !== 'closed') {
    actions.push({
      kind: 'close_cycle',
      cycle_id: snapshot.cycle.id,
      evidence_refs: [snapshot.cycle.id],
    });
  }

  // (h) The calibration packet's inputs moved.
  const current = snapshot.calibration_inputs_hash;
  if (current !== undefined && current !== snapshot.last_packet_inputs_hash) {
    actions.push({
      kind: 'refresh_packet',
      packet_kind: 'calibration',
      inputs_hash: current,
      evidence_refs: [snapshot.cycle.id],
    });
  }

  return {
    tick_id: tickId(snapshot.cycle.id, snapshot.now),
    actions,
    detected,
    changed: actions.length > 0,
  };
}
