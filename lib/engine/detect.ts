/**
 * lib/engine/detect.ts — step 1 of the tick: what is true right now (spec §7).
 *
 * Owns: the derivation of `DetectSummary` from a `TickSnapshot`. Detect answers questions;
 * it never decides anything and never returns an action. Overdue, at-risk, absence, quiet
 * hours, nudge gap, attempts left, "has the shadow record appeared", and the diff against
 * the previous tick all live here so `plan.ts` reads as a list of policy rules.
 *
 * Public interface:
 *   detect(snapshot: TickSnapshot): DetectSummary
 *   isRecipientInCycle(snapshot, workerId): boolean
 *   types re-exported: DetectSummary, TaskSignal, AnomalyFinding
 *
 * Pure: no I/O, no clock (`snapshot.now` is the only "now"), no environment.
 *
 * Spec: docs/SPEC.md §7 step 1, §9 (untrusted content), §10 (deterministic evals);
 * docs/PLAN.md §2.6 (policy keys), §4 block B1.1.
 */

import { detectInstructionText } from '#lib/safety/allowlist.ts';
import { isTerminal } from '#lib/states/index.ts';
import { submissionKindOfTask } from '#lib/engine/review-cycle.ts';
import { fullDaysBetween, hoursBetween, parseInstant } from '#lib/engine/time.ts';
import type {
  AnomalyFinding,
  AvailabilityAnswer,
  DetectSummary,
  TaskSignal,
  TickSnapshot,
} from '#lib/engine/snapshot.ts';
import type { TlReviewSubmission, TlTask } from '#lib/types/engine.ts';
import type { WorkerId } from '#lib/types/tier1.ts';

export type { AnomalyFinding, DetectSummary, TaskSignal } from '#lib/engine/snapshot.ts';

const NO_ANSWER: AvailabilityAnswer = { absent: false, quiet: false };

/**
 * A worker is "in the cycle" when the tick can still see them as an active worker inside
 * the cycle's scope. A recipient who is not is never nudged (spec §10, first eval).
 */
export function isRecipientInCycle(snapshot: TickSnapshot, workerId: WorkerId): boolean {
  const worker = snapshot.workers.get(workerId);
  if (worker === undefined || worker.status !== 'ACTIVE') return false;
  const scope = snapshot.cycle.scope.department_ids;
  if (scope === undefined || scope.length === 0) return true;
  return scope.includes(worker.department_id);
}

/** Index submissions by `cycle|subject|author|kind` so task matching is one lookup. */
function indexSubmissions(submissions: TlReviewSubmission[]): Map<string, TlReviewSubmission> {
  const index = new Map<string, TlReviewSubmission>();
  for (const submission of submissions) {
    if (submission.status !== 'submitted') continue;
    const key = [
      submission.cycle_id,
      submission.subject_worker_id,
      submission.author_worker_id,
      submission.kind,
    ].join('|');
    // First writer wins, so a duplicate cannot change the plan between two equal snapshots.
    if (!index.has(key)) index.set(key, submission);
  }
  return index;
}

/** The submitted shadow record that completes this task, if it exists. */
function submissionFor(
  task: TlTask,
  index: Map<string, TlReviewSubmission>,
): TlReviewSubmission | undefined {
  const kind = submissionKindOfTask(task.kind);
  if (kind === null || task.external_ref === null) return undefined;
  return index.get([task.cycle_id, task.external_ref, task.participant_worker_id, kind].join('|'));
}

function signalFor(
  snapshot: TickSnapshot,
  task: TlTask,
  submissionIndex: Map<string, TlReviewSubmission>,
): TaskSignal {
  const { policy, now } = snapshot;
  const availability = snapshot.availability.get(task.participant_worker_id) ?? NO_ANSWER;
  const terminal = isTerminal('task', task.status);
  const daysPastDue = fullDaysBetween(task.due_at, now);
  const overdue = parseInstant(task.due_at) < parseInstant(now);
  const daysUntilDue = fullDaysBetween(now, task.due_at);
  const submission = submissionFor(task, submissionIndex);
  const previous = snapshot.last_tick?.task_states[task.id];

  const signal: TaskSignal = {
    task_id: task.id,
    kind: task.kind,
    participant_worker_id: task.participant_worker_id,
    subject_worker_id: task.external_ref,
    status: task.status,
    due_at: task.due_at,
    terminal,
    overdue,
    overdue_days: overdue ? Math.max(0, daysPastDue) : 0,
    at_risk: !overdue && daysUntilDue <= policy.escalation.overdue_days,
    absent: availability.absent,
    quiet: availability.quiet,
    nudge_gap_ok:
      task.nudged_at === undefined ||
      hoursBetween(task.nudged_at, now) >= policy.cadence.nudge_min_gap_hours,
    attempt_n: task.attempt_n,
    attempts_left: Math.max(0, policy.cadence.max_attempts - task.attempt_n),
    recipient_in_cycle: isRecipientInCycle(snapshot, task.participant_worker_id),
    changed_since_last_tick: previous === undefined ? true : previous !== task.status,
  };

  // exactOptionalPropertyTypes: optional keys are omitted, never set to `undefined`.
  if (availability.until !== undefined) signal.absent_until = availability.until;
  if (availability.reason !== undefined) signal.absent_reason = availability.reason;
  if (availability.quiet_reason !== undefined) signal.quiet_reason = availability.quiet_reason;
  if (submission !== undefined) signal.submission_id = submission.id;
  return signal;
}

/** Screen untrusted text; drop anything already on record so a re-read is not re-recorded. */
function findAnomalies(snapshot: TickSnapshot): AnomalyFinding[] {
  const texts = snapshot.untrusted ?? [];
  if (texts.length === 0) return [];
  const known = new Set((snapshot.anomalies ?? []).map((a) => `${a.source_ref}|${a.rule}`));
  const found: AnomalyFinding[] = [];
  const seen = new Set<string>();
  for (const item of [...texts].sort((a, b) => (a.source_ref < b.source_ref ? -1 : 1))) {
    const finding = detectInstructionText(item.text);
    if (!finding.anomalous) continue;
    const rule = finding.rule ?? 'unknown';
    const key = `${item.source_ref}|${rule}`;
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    found.push({ source_ref: item.source_ref, excerpt: finding.excerpt ?? '', rule });
  }
  return found;
}

/**
 * Everything the tick knows before it decides anything. Deterministic: the same snapshot
 * always produces the same summary, and signals come back sorted by task id.
 */
export function detect(snapshot: TickSnapshot): DetectSummary {
  const submissionIndex = indexSubmissions(snapshot.submissions);
  const tasks = [...snapshot.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const signals = tasks.map((task) => signalFor(snapshot, task, submissionIndex));

  const byTask = new Map<string, TaskSignal>();
  for (const signal of signals) byTask.set(signal.task_id, signal);

  const openProposals = snapshot.proposals.filter((p) => p.status === 'proposed');
  const covered = new Set<string>();
  for (const proposal of openProposals) {
    if (proposal.kind !== 'escalate') continue;
    for (const ref of proposal.evidence_refs) covered.add(ref);
  }

  const counts = {
    tasks: signals.length,
    open: signals.filter((s) => !s.terminal).length,
    terminal: signals.filter((s) => s.terminal).length,
    overdue: signals.filter((s) => !s.terminal && s.overdue).length,
    at_risk: signals.filter((s) => !s.terminal && s.at_risk).length,
    absent: signals.filter((s) => !s.terminal && s.absent).length,
    quiet: signals.filter((s) => !s.terminal && s.quiet).length,
    completable: signals.filter((s) => !s.terminal && s.submission_id !== undefined).length,
    nudgeable: signals.filter(
      (s) =>
        !s.terminal &&
        s.status !== 'escalated' &&
        s.overdue &&
        !s.absent &&
        !s.quiet &&
        s.nudge_gap_ok &&
        s.attempts_left > 0 &&
        s.recipient_in_cycle &&
        s.submission_id === undefined,
    ).length,
  };

  return {
    now: snapshot.now,
    cycle_id: snapshot.cycle.id,
    cycle_status: snapshot.cycle.status,
    signals,
    by_task: byTask,
    counts,
    changed_task_ids: signals.filter((s) => s.changed_since_last_tick).map((s) => s.task_id),
    open_proposal_ids: openProposals.map((p) => p.id).sort(),
    covered_task_ids: covered,
    anomalies: findAnomalies(snapshot),
  };
}
