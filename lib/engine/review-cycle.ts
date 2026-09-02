/**
 * lib/engine/review-cycle.ts — loop 1 as configuration: who is in the cycle, what they owe.
 *
 * Owns: the pure derivation of a review cycle's participants, its `tl_task` set (self →
 * peer → manager, staggered by policy) and the matching pending `tl_review_submission`
 * shadow records. Nothing here writes: `bin/cycle.mjs open` (block B1.3) takes these
 * `NewRecord<…>` values to `StatePort.create`, which assigns the ids.
 *
 * Public interface:
 *   participantsFor(cycle, workers)                       -> Worker[]           (ACTIVE, in scope)
 *   tasksFor(cycle, participants, workers, policy, openedAt?) -> NewRecord<TlTask>[]
 *   submissionsFor(cycle, tasks)                          -> NewRecord<TlReviewSubmission>[]
 *   peersFor(subject, participants, workers, count)       -> Worker[]
 *   submissionKindOfTask(kind)                            -> 'self'|'peer'|'manager'|null
 *   taskKindOfSubmission(kind), REVIEW_TASK_KINDS, staggerDaysFor(kind, policy)
 *
 * Determinism (spec §10): every list is sorted by worker/task id before it is used, so the
 * same org and the same policy always produce the same tasks in the same order.
 *
 * Peer choice: candidates are the subject's team-mates among the participants, minus the
 * subject and the subject's manager, sorted by id; if that pool is smaller than
 * `peers_per_subject` the department is used instead. Peers are then taken round-robin
 * starting at the subject's own rank in the source list, so the load spreads across the team
 * instead of landing entirely on the two lowest ids — deterministic either way.
 *
 * Convention: `tl_task.external_ref` holds the **subject worker id** for review tasks
 * (see the header of `lib/engine/snapshot.ts`); `participant_worker_id` is the author who
 * owes the work. A manager review is therefore a task on the *manager*, about the report.
 *
 * Spec: docs/SPEC.md §6 (tl_task), §8 loop 1; docs/PLAN.md §2.6 (`review_cycle` policy).
 */

import { dueAtAfter } from '#lib/engine/time.ts';
import type { TenantPolicy } from '#lib/policy/schema.ts';
import type {
  NewRecord,
  TlCycle,
  TlReviewSubmission,
  TlReviewSubmissionKind,
  TlTask,
  TlTaskKind,
} from '#lib/types/engine.ts';
import type { InstantISO, Worker, WorkerId } from '#lib/types/tier1.ts';

/** The three task kinds loop 1 creates, in the order they fall due. */
export const REVIEW_TASK_KINDS = [
  'write_self_review',
  'write_peer_review',
  'write_manager_review',
] as const;
export type ReviewTaskKind = (typeof REVIEW_TASK_KINDS)[number];

const SUBMISSION_KIND_BY_TASK: Record<ReviewTaskKind, TlReviewSubmissionKind> = {
  write_self_review: 'self',
  write_peer_review: 'peer',
  write_manager_review: 'manager',
};

const TASK_KIND_BY_SUBMISSION: Record<TlReviewSubmissionKind, ReviewTaskKind> = {
  self: 'write_self_review',
  peer: 'write_peer_review',
  manager: 'write_manager_review',
};

/** The `tl_review_submission` kind that completes a task, or null for non-review kinds. */
export function submissionKindOfTask(kind: TlTaskKind): TlReviewSubmissionKind | null {
  return (REVIEW_TASK_KINDS as readonly string[]).includes(kind)
    ? SUBMISSION_KIND_BY_TASK[kind as ReviewTaskKind]
    : null;
}

/** The task kind a submission kind belongs to. */
export function taskKindOfSubmission(kind: TlReviewSubmissionKind): ReviewTaskKind {
  return TASK_KIND_BY_SUBMISSION[kind];
}

/** Days after `opened_at` at which a task kind falls due (`review_cycle.stagger_days`). */
export function staggerDaysFor(kind: ReviewTaskKind, policy: TenantPolicy): number {
  const stagger = policy.review_cycle.stagger_days;
  if (kind === 'write_self_review') return stagger.self;
  if (kind === 'write_peer_review') return stagger.peer;
  return stagger.manager;
}

function byId(a: Worker, b: Worker): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * ACTIVE workers inside the cycle's department scope, sorted by id. An empty or missing
 * `scope.department_ids` means the whole company (the seeded H2 2026 cycle lists all six).
 */
export function participantsFor(cycle: TlCycle, workers: Map<WorkerId, Worker>): Worker[] {
  const scope = cycle.scope.department_ids;
  const inScope = (worker: Worker): boolean =>
    scope === undefined || scope.length === 0 || scope.includes(worker.department_id);
  return [...workers.values()].filter((w) => w.status === 'ACTIVE' && inScope(w)).sort(byId);
}

/** Rank of `id` inside a sorted list — the round-robin offset for peer picking. */
function rankOf(list: Worker[], id: WorkerId): number {
  const index = list.findIndex((w) => w.id === id);
  return index < 0 ? 0 : index;
}

/**
 * `count` peers for `subject`: same team if it can supply them, department otherwise.
 * The subject and the subject's manager are never peers. Returns fewer than `count` only
 * when the department itself cannot supply more.
 */
export function peersFor(subject: Worker, participants: Worker[], count: number): Worker[] {
  if (count <= 0) return [];
  const eligible = (candidate: Worker): boolean =>
    candidate.id !== subject.id && candidate.id !== subject.manager_id;

  const team = participants.filter((w) => w.team_id === subject.team_id);
  let source = team;
  let pool = team.filter(eligible);
  if (pool.length < count) {
    source = participants.filter((w) => w.department_id === subject.department_id);
    pool = source.filter(eligible);
  }
  if (pool.length === 0) return [];

  const take = Math.min(count, pool.length);
  const start = rankOf(source, subject.id);
  const picked: Worker[] = [];
  for (let i = 0; i < take; i += 1) {
    const next = pool[(start + i) % pool.length];
    if (next !== undefined) picked.push(next);
  }
  return picked;
}

function newTask(
  cycle: TlCycle,
  kind: ReviewTaskKind,
  author: WorkerId,
  subject: WorkerId,
  policy: TenantPolicy,
  openedAt: InstantISO,
): NewRecord<TlTask> {
  const dueAt = dueAtAfter(openedAt, staggerDaysFor(kind, policy));
  return {
    cycle_id: cycle.id,
    participant_worker_id: author,
    kind,
    external_ref: subject,
    due_at: dueAt,
    original_due_at: dueAt,
    status: 'pending',
    attempt_n: 0,
  };
}

/**
 * Every task the cycle owes: one self review per participant, `peers_per_subject` peer
 * reviews per participant, and one manager review per participant who has a manager.
 * Emitted subject by subject (self, peers, manager) with subjects in id order.
 *
 * `workers` is the full org, not just the participants: a participant's manager may sit
 * outside the cycle's scope and still owes the review.
 *
 * @param openedAt defaults to `cycle.opened_at`; one of the two must be set.
 */
export function tasksFor(
  cycle: TlCycle,
  participants: Worker[],
  workers: Map<WorkerId, Worker>,
  policy: TenantPolicy,
  openedAt?: InstantISO,
): NewRecord<TlTask>[] {
  const opened = openedAt ?? cycle.opened_at;
  if (opened === null || opened === undefined) {
    throw new Error(`cycle ${cycle.id} has no opened_at; pass one to tasksFor()`);
  }
  const sorted = [...participants].sort(byId);
  const tasks: NewRecord<TlTask>[] = [];

  for (const subject of sorted) {
    tasks.push(newTask(cycle, 'write_self_review', subject.id, subject.id, policy, opened));

    for (const peer of peersFor(subject, sorted, policy.review_cycle.peers_per_subject)) {
      tasks.push(newTask(cycle, 'write_peer_review', peer.id, subject.id, policy, opened));
    }

    const manager = subject.manager_id === null ? undefined : workers.get(subject.manager_id);
    if (manager !== undefined && manager.status === 'ACTIVE') {
      tasks.push(newTask(cycle, 'write_manager_review', manager.id, subject.id, policy, opened));
    }
  }
  return tasks;
}

/**
 * The pending Tier-3 shadow record for each review task — the record whose arrival at
 * `status: 'submitted'` is what completes the task (spec §3, §6). One per review task,
 * in the same order.
 */
export function submissionsFor(
  cycle: TlCycle,
  tasks: NewRecord<TlTask>[],
): NewRecord<TlReviewSubmission>[] {
  const submissions: NewRecord<TlReviewSubmission>[] = [];
  for (const task of tasks) {
    const kind = submissionKindOfTask(task.kind);
    if (kind === null || task.external_ref === null) continue;
    submissions.push({
      shadow: true,
      real_ref: task.external_ref,
      cycle_id: cycle.id,
      subject_worker_id: task.external_ref,
      author_worker_id: task.participant_worker_id,
      kind,
      status: 'pending',
      body_ref: null,
    });
  }
  return submissions;
}
