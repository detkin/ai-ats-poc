/**
 * tests/engine/helpers.ts — snapshot builders shared by the engine tests (block B1.1).
 *
 * Not a test file (vitest only collects `*.test.ts`). Two things live here: tiny synthetic
 * records for the rule tests, and the fixture-tenant snapshot the idempotence and packet
 * tests run against. Both are deterministic: `now` is always passed in, never read.
 */

import { loadTenant } from '#lib/fixtures/index.ts';
import { loadPolicy } from '#lib/policy/index.ts';
import { participantsFor, submissionsFor, tasksFor } from '#lib/engine/review-cycle.ts';
import type { TenantBundle } from '#lib/fixtures/index.ts';
import type { TenantPolicy } from '#lib/policy/schema.ts';
import type { AvailabilityAnswer, TickSnapshot } from '#lib/engine/snapshot.ts';
import type {
  NewRecord,
  TlCycle,
  TlRecordBase,
  TlNudge,
  TlProposedAction,
  TlReviewSubmission,
  TlTask,
  TlTaskState,
} from '#lib/types/engine.ts';
import type { DateISO, InstantISO, Worker, WorkerId } from '#lib/types/tier1.ts';

/** The instant every engine test calls "now": the day after the fixture anchor. */
export const TEST_NOW: InstantISO = '2026-09-03T16:00:00Z';
/** The day `bin/cycle.mjs open` is pretended to have run (docs/PLAN.md §3 B0.4). */
export const OPENED_AT: InstantISO = '2026-08-24T17:00:00Z';

let cachedTenant: TenantBundle | undefined;
let cachedPolicy: TenantPolicy | undefined;

export function tenant(): TenantBundle {
  cachedTenant ??= loadTenant();
  return cachedTenant;
}

export function policy(): TenantPolicy {
  cachedPolicy ??= loadPolicy();
  return cachedPolicy;
}

export function workerMap(workers: Worker[]): Map<WorkerId, Worker> {
  return new Map(workers.map((w) => [w.id, w]));
}

/* ------------------------------------------------------------- tiny records */

export function makeWorker(id: WorkerId, overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    first_name: 'Test',
    last_name: id,
    work_email: `${id}@example.invalid`,
    title: 'Engineer',
    level_id: 'lvl_L4',
    job_function: 'engineering',
    department_id: 'dept_eng',
    team_id: 'team_platform',
    manager_id: null,
    location_id: 'loc_sf',
    employment_type: 'full_time',
    start_date: '2024-01-08',
    status: 'ACTIVE',
    slack_user_id: `U${id}`,
    timezone: 'America/Los_Angeles',
    compensation: { base_annual: 200_000, currency: 'USD' },
    ...overrides,
  };
}

export function makeCycle(overrides: Partial<TlCycle> = {}): TlCycle {
  return {
    id: 'tl_cycle_test',
    created_at: OPENED_AT,
    updated_at: OPENED_AT,
    created_by: 'w_0021',
    type: 'review',
    name: 'Test cycle',
    status: 'running',
    owner_worker_id: 'w_0021',
    deadline: '2026-09-18T23:59:59Z',
    policy_ref: 'tenant/policy.yml',
    opened_at: OPENED_AT,
    scope: {},
    ...overrides,
  };
}

export function makeTask(id: string, overrides: Partial<TlTask> = {}): TlTask {
  const dueAt = overrides.due_at ?? '2026-08-24T23:59:59Z';
  return {
    id,
    created_at: OPENED_AT,
    updated_at: OPENED_AT,
    created_by: 'w_0021',
    cycle_id: 'tl_cycle_test',
    participant_worker_id: 'w_0001',
    kind: 'write_self_review',
    external_ref: 'w_0001',
    due_at: dueAt,
    original_due_at: dueAt,
    status: 'pending' as TlTaskState,
    attempt_n: 0,
    ...overrides,
  };
}

export function makeSubmission(
  id: string,
  overrides: Partial<TlReviewSubmission> = {},
): TlReviewSubmission {
  return {
    id,
    created_at: OPENED_AT,
    updated_at: OPENED_AT,
    created_by: 'w_0021',
    shadow: true,
    real_ref: 'w_0001',
    cycle_id: 'tl_cycle_test',
    subject_worker_id: 'w_0001',
    author_worker_id: 'w_0001',
    kind: 'self',
    status: 'pending',
    body_ref: null,
    ...overrides,
  };
}

export function makeProposal(
  id: string,
  overrides: Partial<TlProposedAction> = {},
): TlProposedAction {
  return {
    id,
    created_at: OPENED_AT,
    updated_at: OPENED_AT,
    created_by: 'w_0021',
    cycle_id: 'tl_cycle_test',
    kind: 'escalate',
    payload: {},
    rationale: 'test',
    evidence_refs: [],
    status: 'proposed',
    ...overrides,
  };
}

/** A snapshot over hand-built records; everything not given defaults to "nothing there". */
export function makeSnapshot(parts: Partial<TickSnapshot> = {}): TickSnapshot {
  const tasks = parts.tasks ?? [];
  const workers =
    parts.workers ??
    workerMap([...new Set(tasks.map((t) => t.participant_worker_id))].map((id) => makeWorker(id)));
  return {
    cycle: parts.cycle ?? makeCycle(),
    tasks,
    proposals: parts.proposals ?? [],
    nudges: parts.nudges ?? [],
    submissions: parts.submissions ?? [],
    workers,
    availability: parts.availability ?? new Map<WorkerId, AvailabilityAnswer>(),
    policy: parts.policy ?? policy(),
    now: parts.now ?? TEST_NOW,
    ...parts,
  };
}

/* ------------------------------------------------------- fixture-org snapshot */

/** APPROVED absence covering `date`, as the Availability adapter would answer it. */
export function availabilityFor(
  bundle: TenantBundle,
  date: DateISO,
  quiet: (workerId: WorkerId) => boolean = () => false,
): Map<WorkerId, AvailabilityAnswer> {
  const leaveName = new Map(bundle.leave_types.map((t) => [t.id, t.name]));
  const answers = new Map<WorkerId, AvailabilityAnswer>();
  for (const worker of bundle.workers) {
    answers.set(worker.id, { absent: false, quiet: quiet(worker.id) });
  }
  for (const absence of bundle.absences) {
    if (absence.status !== 'APPROVED') continue;
    if (absence.start_date > date || absence.end_date < date) continue;
    answers.set(absence.worker_id, {
      absent: true,
      reason: leaveName.get(absence.leave_type_id) ?? 'absence',
      until: absence.end_date,
      quiet: quiet(absence.worker_id),
    });
  }
  return answers;
}

function withIds<T extends TlRecordBase>(
  records: NewRecord<T>[],
  prefix: string,
  actor: WorkerId,
): T[] {
  return records.map(
    (record, index) =>
      ({
        ...record,
        id: `${prefix}_${String(index + 1).padStart(4, '0')}`,
        created_at: OPENED_AT,
        updated_at: OPENED_AT,
        created_by: actor,
      }) as unknown as T,
  );
}

export interface OpenedCycle {
  bundle: TenantBundle;
  cycle: TlCycle;
  participants: Worker[];
  tasks: TlTask[];
  submissions: TlReviewSubmission[];
}

/**
 * The seeded review cycle as `bin/cycle.mjs open` would leave it: status `running`,
 * `opened_at` set, every task and pending submission created with stable ids.
 */
export function openedFixtureCycle(): OpenedCycle {
  const bundle = tenant();
  const seeded = bundle.state.cycles[0];
  if (seeded === undefined) throw new Error('fixture tenant has no seeded cycle');
  const cycle: TlCycle = { ...seeded, status: 'running', opened_at: OPENED_AT };
  const workers = workerMap(bundle.workers);
  const participants = participantsFor(cycle, workers);
  const newTasks = tasksFor(cycle, participants, workers, policy(), OPENED_AT);
  const tasks = withIds<TlTask>(newTasks, 'tl_task', cycle.owner_worker_id);
  const submissions = withIds<TlReviewSubmission>(
    submissionsFor(cycle, newTasks),
    'tl_review_submission',
    cycle.owner_worker_id,
  );
  return { bundle, cycle, participants, tasks, submissions };
}

/** The full fixture-org snapshot the idempotence test ticks. */
export function fixtureSnapshot(
  overrides: Partial<TickSnapshot> = {},
  opened: OpenedCycle = openedFixtureCycle(),
): TickSnapshot {
  const now = overrides.now ?? TEST_NOW;
  return makeSnapshot({
    cycle: opened.cycle,
    tasks: opened.tasks,
    workers: workerMap(opened.bundle.workers),
    availability: availabilityFor(opened.bundle, now.slice(0, 10)),
    departments: new Map(opened.bundle.departments.map((d) => [d.id, d])),
    now,
    ...overrides,
  });
}

/** Nudge record as the executor would write it (only used to seed "already nudged" state). */
export function makeNudge(id: string, overrides: Partial<TlNudge> = {}): TlNudge {
  return {
    id,
    created_at: OPENED_AT,
    updated_at: OPENED_AT,
    created_by: 'w_0021',
    task_id: 'tl_task_0001',
    cycle_id: 'tl_cycle_test',
    channel: 'slack_dm',
    sent_at: OPENED_AT,
    attempt_n: 1,
    template_id: 'nudge.write_self_review.first',
    delivered: true,
    policy_check: {
      recipient_in_cycle: true,
      absent: false,
      quiet_hours: false,
      attempts_ok: true,
      passed: true,
      reasons: [],
    },
    ...overrides,
  };
}
