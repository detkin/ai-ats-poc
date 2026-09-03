/**
 * lib/cli/cycle.ts — create, open, close and show a cycle (block B1.3).
 *
 * Owns the four cycle-lifecycle operations. The interesting one is `open`: it is where a
 * cycle stops being configuration and becomes work. Opening
 *
 *   1. stamps `opened_at` with the frozen clock (docs/DECISIONS.md D9: the fixture ships
 *      `opened_at: null`, because opening is a ledgered write and belongs to the CLI),
 *   2. moves the status `configured → running` through the states contract, and
 *   3. creates the `tl_task` set from `tasksFor` and the matching pending
 *      `tl_review_submission` shadow records from `submissionsFor` — the engine decides
 *      *what* is owed, this decides *when* and records it.
 *
 * Every task and submission is an individual `state.create`, so every one gets an
 * adapter-assigned id and its own ledger line. That is slower than one bulk write and it is
 * the point: `verify-loops.mjs` reconciles state against the ledger, and a bulk write would
 * make 479 records share one line.
 *
 * `close` refuses unless the engine's own close condition holds — every task terminal and
 * every proposal decided — and lists what is outstanding when it does not.
 *
 * **An interview cycle opens differently, and the difference is the point** (block B2.2).
 * `create --type interview --application <app_id>` resolves the application's requisition and
 * records both ids in `scope`, so the cycle is keyed to real ATS records and copies no value
 * off them (spec §3). `open` then checks one thing only — that the application is still
 * `ACTIVE` at stage `Onsite` when it is re-read — flips the cycle to `running`, and creates
 * **no tasks at all**. There is nothing to owe until a time exists: the first tick books the
 * panel and the hold is what brings the attendance and scorecard tasks into being. A review
 * cycle knows its work from the org chart; an interview cycle learns it from a calendar.
 *
 * Public interface: `CYCLE_SPEC`, `runCycle`, `createCycle`, `openCycle`, `closeCycle`,
 * `showCycle`, `ONSITE_STAGE`, `CreateCycleInput`, `OpenResult`, `CloseResult`, `ShowResult`.
 *
 * Spec: docs/SPEC.md §6, §7, §8 loop 1, §8 loop 2; docs/PLAN.md §2.9, §4 block B1.3,
 * §5 block B2.2.
 */

import type { Runtime } from '#lib/adapters/index.ts';
import { UsageError } from '#lib/cli/args.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { fail, ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { CliError, openRuntime } from '#lib/cli/runtime.ts';
import { buildSnapshot, loadCycle, readWorkers } from '#lib/cli/snapshot.ts';
import { endOfDay, participantsFor, submissionsFor, tasksFor } from '#lib/engine/index.ts';
import { assertTransition } from '#lib/states/index.ts';
import { CYCLE_TYPES } from '#lib/types/engine.ts';
import type {
  TlCycle,
  TlCycleScope,
  TlCycleType,
  TlProposedAction,
  TlTask,
  TlTaskState,
} from '#lib/types/engine.ts';

/** Where the cycle's policy came from; the tenant layer's own path (docs/DECISIONS.md D3). */
export const POLICY_REF = 'tenant/policy.yml';

/** The one application stage an interview loop may be opened on (spec §8 loop 2). */
export const ONSITE_STAGE = 'Onsite';

export const CYCLE_SPEC: CliSpec = {
  name: 'cycle.mjs',
  summary: 'create, open, close or inspect a cycle',
  usage: [
    'bin/cycle.mjs create --type review|interview --name <n> --owner <w_id> [--department <id>] [--application <app_id>] --deadline <date>',
    'bin/cycle.mjs open --cycle <id>',
    'bin/cycle.mjs close --cycle <id>',
    'bin/cycle.mjs show --cycle <id>',
  ],
  subcommands: [
    { name: 'create', description: 'record a new tl_cycle in status `configured`' },
    { name: 'open', description: 'set opened_at, run the cycle, create its tasks' },
    { name: 'close', description: 'close a cycle whose work is finished' },
    { name: 'show', description: 'cycle summary: task counts by status, open proposals' },
  ],
  flags: [
    {
      name: 'type',
      type: 'string',
      value: '<t>',
      description: `cycle type (${CYCLE_TYPES.join(' | ')})`,
    },
    { name: 'name', type: 'string', value: '<n>', description: 'human name for the cycle' },
    { name: 'owner', type: 'string', value: '<w_id>', description: 'worker who owns the cycle' },
    {
      name: 'department',
      type: 'string',
      value: '<id>',
      description: 'department in scope; omit for the whole company',
      repeated: true,
    },
    {
      name: 'application',
      type: 'string',
      value: '<app_id>',
      description: 'application in scope (interview cycles)',
    },
    {
      name: 'deadline',
      type: 'string',
      value: '<date>',
      description: 'YYYY-MM-DD (or an ISO instant) the cycle must finish by',
    },
    { name: 'cycle', type: 'string', value: '<id>', description: 'cycle id, for open/close/show' },
  ],
};

export interface CreateCycleInput {
  type: TlCycleType;
  name: string;
  owner: string;
  deadline: string;
  departments: string[];
  applicationId?: string;
}

export interface OpenResult {
  cycle: TlCycle;
  participants: number;
  tasks: TlTask[];
  submissions: number;
  by_kind: Record<string, number>;
}

export interface CloseResult {
  cycle: TlCycle;
  closed: boolean;
  outstanding: { tasks: string[]; proposals: string[] };
}

export interface ShowResult {
  cycle: TlCycle;
  tasks: Record<string, number>;
  task_total: number;
  open_proposals: TlProposedAction[];
  packets: number;
}

/** Validate `--type`. */
export function parseCycleType(raw: string): TlCycleType {
  const found = CYCLE_TYPES.find((type) => type === raw);
  if (found === undefined) {
    throw new UsageError(
      `cycle.mjs: --type "${raw}" is not a cycle type (${CYCLE_TYPES.join(' | ')})`,
    );
  }
  return found;
}

/** A date becomes the last second of that day; an instant is used as given. */
export function parseDeadline(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return endOfDay(raw);
  if (Number.isNaN(Date.parse(raw))) {
    throw new UsageError(`cycle.mjs: --deadline "${raw}" is not a date (YYYY-MM-DD) or an instant`);
  }
  return raw;
}

/**
 * The scope an interview cycle is keyed by: the application, and the requisition it is on.
 * Both are read from the real ATS records rather than taken on the caller's word, and both
 * are stored as **ids only** — the stage, the status and the candidate stay where they live
 * and are re-read on every tick (spec §3).
 */
async function interviewScopeFor(rt: Runtime, applicationId: string): Promise<TlCycleScope> {
  const application = await rt.ports.ats.getApplication(applicationId);
  if (application === null) {
    throw new CliError(
      'APPLICATION_NOT_FOUND',
      `no application with id "${applicationId}" to run an interview loop on.`,
    );
  }
  return { application_id: application.id, requisition_id: application.job_id };
}

/** Record a new cycle in `configured`. It owes nothing until `open`. */
export async function createCycle(rt: Runtime, input: CreateCycleInput): Promise<TlCycle> {
  const owner = await rt.ports.graph.lookupPerson(input.owner);
  if (owner === null) {
    throw new CliError('OWNER_NOT_FOUND', `no worker with id "${input.owner}" to own the cycle.`);
  }
  if (input.type === 'interview' && input.applicationId === undefined) {
    throw new UsageError(
      'cycle.mjs: --type interview needs --application <app_id> — an interview loop is about ' +
        'one real application.',
    );
  }
  const scope: TlCycleScope = {
    ...(input.departments.length === 0 ? {} : { department_ids: [...input.departments] }),
    ...(input.applicationId === undefined
      ? {}
      : input.type === 'interview'
        ? await interviewScopeFor(rt, input.applicationId)
        : { application_id: input.applicationId }),
  };

  return rt.ports.state.create('cycle', {
    type: input.type,
    name: input.name,
    status: 'configured',
    owner_worker_id: owner.id,
    deadline: input.deadline,
    policy_ref: POLICY_REF,
    opened_at: null,
    scope,
  });
}

/**
 * Open an interview loop. Two things happen and no more: the trigger is re-checked against
 * the **real** application (spec §8 loop 2: "trigger on a real application reaching stage
 * Onsite, re-read from REST"), and the cycle starts running.
 *
 * No tasks are created. Attendance and scorecards are owed *at a time*, and no time exists
 * until the first tick has looked at the panel's calendars and placed a hold — so the tick
 * creates them, as `place_hold`, and the hold is the evidence that they are real.
 */
async function openInterviewCycle(rt: Runtime, cycle: TlCycle, now: string): Promise<OpenResult> {
  const applicationId = cycle.scope.application_id;
  if (applicationId === undefined) {
    throw new CliError(
      'CYCLE_HAS_NO_APPLICATION',
      `interview cycle ${cycle.id} has no application in scope; it cannot be opened.`,
    );
  }
  const application = await rt.ports.ats.getApplication(applicationId);
  if (application === null) {
    throw new CliError('APPLICATION_NOT_FOUND', `no application with id "${applicationId}".`);
  }
  if (application.status !== 'ACTIVE' || application.stage !== ONSITE_STAGE) {
    throw new CliError(
      'APPLICATION_NOT_AT_ONSITE',
      `application ${application.id} is ${application.status} at stage "${application.stage}"; ` +
        `the interview loop opens on an ACTIVE application at stage "${ONSITE_STAGE}". ` +
        'Moving it there is a decision of record a named human makes in the ATS.',
    );
  }

  const opened = await rt.ports.state.update('cycle', cycle.id, {
    opened_at: now,
    status: 'running',
  });
  return { cycle: opened, participants: 0, tasks: [], submissions: 0, by_kind: {} };
}

/**
 * Open a review cycle: `opened_at`, `running`, then one `tl_task` and one pending
 * `tl_review_submission` per unit of work.
 */
export async function openCycle(rt: Runtime, cycleId: string, now: string): Promise<OpenResult> {
  const cycle = await loadCycle(rt, cycleId);
  if (cycle.type !== 'review' && cycle.type !== 'interview') {
    throw new CliError(
      'CYCLE_TYPE_NOT_YET',
      `opening a ${cycle.type} cycle lands in M3; M2 opens review and interview cycles.`,
    );
  }
  if (cycle.opened_at !== null) {
    throw new CliError(
      'CYCLE_ALREADY_OPEN',
      `cycle ${cycle.id} was opened at ${cycle.opened_at}; opening it again would duplicate its tasks.`,
    );
  }
  assertTransition('cycle', cycle.status, 'running', rt.states);
  if (cycle.type === 'interview') return openInterviewCycle(rt, cycle, now);

  const workers = await readWorkers(rt);
  const participants = participantsFor(cycle, workers);
  if (participants.length === 0) {
    throw new CliError(
      'CYCLE_HAS_NO_PARTICIPANTS',
      `cycle ${cycle.id} has no ACTIVE workers in scope ` +
        `(${cycle.scope.department_ids?.join(', ') ?? 'whole company'}).`,
    );
  }

  const opened = await rt.ports.state.update('cycle', cycle.id, {
    opened_at: now,
    status: 'running',
  });

  const newTasks = tasksFor(opened, participants, workers, rt.policy, now);
  const newSubmissions = submissionsFor(opened, newTasks);

  const tasks: TlTask[] = [];
  for (const task of newTasks) tasks.push(await rt.ports.state.create('task', task));
  let submissions = 0;
  for (const submission of newSubmissions) {
    await rt.ports.state.create('review_submission', submission);
    submissions += 1;
  }

  const byKind: Record<string, number> = {};
  for (const task of tasks) byKind[task.kind] = (byKind[task.kind] ?? 0) + 1;

  return { cycle: opened, participants: participants.length, tasks, submissions, by_kind: byKind };
}

/**
 * Close the cycle, but only when the engine's close condition holds: every task terminal and
 * every proposal decided. A cycle that is still `running` or `escalated` is walked through
 * `closing` first, so the states contract sees a legal path.
 */
export async function closeCycle(rt: Runtime, cycleId: string, now: string): Promise<CloseResult> {
  const { snapshot } = await buildSnapshot(rt, cycleId, now, { withLastTick: false });
  const cycle = snapshot.cycle;
  if (cycle.status === 'closed') {
    return { cycle, closed: false, outstanding: { tasks: [], proposals: [] } };
  }

  const openTasks = snapshot.tasks
    .filter((task) => task.status !== 'done' && task.status !== 'waived')
    .map((task) => task.id);
  const openProposals = snapshot.proposals
    .filter((proposal) => proposal.status === 'proposed')
    .map((proposal) => proposal.id);

  if (openTasks.length > 0 || openProposals.length > 0) {
    return { cycle, closed: false, outstanding: { tasks: openTasks, proposals: openProposals } };
  }

  let current = cycle;
  if (current.status !== 'closing') {
    assertTransition('cycle', current.status, 'closing', rt.states);
    current = await rt.ports.state.update('cycle', current.id, { status: 'closing' });
  }
  const closed = await rt.ports.state.update('cycle', current.id, {
    status: 'closed',
    closed_at: now,
  });
  return { cycle: closed, closed: true, outstanding: { tasks: [], proposals: [] } };
}

/** Cycle summary: task counts by status, open proposals, packet count. */
export async function showCycle(rt: Runtime, cycleId: string): Promise<ShowResult> {
  const cycle = await loadCycle(rt, cycleId);
  const filter = { cycle_id: cycleId } as const;
  const tasks: TlTask[] = await rt.ports.state.list('task', filter);
  const proposals: TlProposedAction[] = await rt.ports.state.list('proposed_action', filter);
  const packets = await rt.ports.state.list('packet', filter);

  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;

  return {
    cycle,
    tasks: counts,
    task_total: tasks.length,
    open_proposals: proposals.filter((proposal) => proposal.status === 'proposed'),
    packets: packets.length,
  };
}

/* ------------------------------------------------------------------- the CLI */

/** One line naming what the cycle is about: departments, or the application it follows. */
function describeScope(cycle: TlCycle): string {
  const { application_id, requisition_id, department_ids } = cycle.scope;
  if (application_id !== undefined) {
    return `application ${application_id}${
      requisition_id === undefined ? '' : ` on requisition ${requisition_id}`
    }`;
  }
  return department_ids?.join(', ') ?? 'whole company';
}

async function runCreate(args: Args): Promise<CliOutput> {
  const type = parseCycleType(args.require('type'));
  const deadline = parseDeadline(args.require('deadline'));
  const application = args.get('application');
  const { rt } = openRuntime();

  const cycle = await createCycle(rt, {
    type,
    name: args.require('name'),
    owner: args.require('owner'),
    deadline,
    departments: args.all('department'),
    ...(application === undefined ? {} : { applicationId: application }),
  });

  return ok(cycle, [
    `Created ${cycle.type} cycle ${cycle.id} — ${cycle.name} (${cycle.status})`,
    `  owner     ${cycle.owner_worker_id}`,
    `  deadline  ${cycle.deadline}`,
    `  scope     ${describeScope(cycle)}`,
    `  open it   node bin/cycle.mjs open --cycle ${cycle.id}`,
  ]);
}

async function runOpen(args: Args): Promise<CliOutput> {
  const cycleId = args.require('cycle');
  const { rt, now } = openRuntime({ cycleId });
  const result = await openCycle(rt, cycleId, now);

  return ok(
    {
      cycle_id: result.cycle.id,
      status: result.cycle.status,
      opened_at: result.cycle.opened_at,
      participants: result.participants,
      tasks: result.tasks.length,
      submissions: result.submissions,
      by_kind: result.by_kind,
    },
    [
      `Opened ${result.cycle.id} at ${result.cycle.opened_at} (${result.cycle.status})`,
      `  scope         ${describeScope(result.cycle)}`,
      ...(result.cycle.type === 'interview'
        ? ['  tasks         0 — the first tick books the panel; the hold creates the work']
        : [
            `  participants  ${result.participants}`,
            `  tasks         ${result.tasks.length}`,
            ...Object.entries(result.by_kind)
              .sort()
              .map(([kind, count]) => `    ${kind.padEnd(22)} ${count}`),
            `  submissions   ${result.submissions} pending shadow record(s)`,
          ]),
      `  tick it       node bin/tick.mjs --cycle ${result.cycle.id}`,
    ],
  );
}

async function runClose(args: Args): Promise<CliOutput> {
  const cycleId = args.require('cycle');
  const { rt, now } = openRuntime({ cycleId });
  const result = await closeCycle(rt, cycleId, now);

  if (result.closed) {
    return ok(result, [`Closed ${result.cycle.id} at ${result.cycle.closed_at ?? now}.`]);
  }
  if (result.cycle.status === 'closed') {
    return fail(result, [`Cycle ${result.cycle.id} is already closed.`]);
  }
  return fail(result, [
    `Cycle ${result.cycle.id} cannot close yet:`,
    `  ${result.outstanding.tasks.length} task(s) not done or waived` +
      (result.outstanding.tasks.length === 0
        ? ''
        : `: ${result.outstanding.tasks.slice(0, 5).join(', ')}${
            result.outstanding.tasks.length > 5 ? ', …' : ''
          }`),
    `  ${result.outstanding.proposals.length} proposal(s) awaiting a decision` +
      (result.outstanding.proposals.length === 0
        ? ''
        : `: ${result.outstanding.proposals.join(', ')}`),
  ]);
}

async function runShow(args: Args): Promise<CliOutput> {
  const cycleId = args.require('cycle');
  const { rt } = openRuntime({ cycleId });
  const result = await showCycle(rt, cycleId);
  const statuses: TlTaskState[] = ['pending', 'nudged', 'escalated', 'done', 'waived'];

  return ok(result, [
    `${result.cycle.id} — ${result.cycle.name} (${result.cycle.type}, ${result.cycle.status})`,
    `  owner       ${result.cycle.owner_worker_id}`,
    `  opened_at   ${result.cycle.opened_at ?? '(not opened)'}`,
    `  deadline    ${result.cycle.deadline}`,
    `  scope       ${describeScope(result.cycle)}`,
    `  tasks       ${result.task_total}` +
      (result.task_total === 0
        ? ''
        : ` — ${statuses
            .filter((status) => (result.tasks[status] ?? 0) > 0)
            .map((status) => `${status} ${result.tasks[status]}`)
            .join(', ')}`),
    `  packets     ${result.packets}`,
    `  proposals   ${result.open_proposals.length} awaiting a decision`,
    ...result.open_proposals.map(
      (proposal) =>
        `    ${proposal.id}  ${proposal.kind}  ${proposal.evidence_refs.length} evidence ref(s)`,
    ),
  ]);
}

export async function runCycle(args: Args): Promise<CliOutput> {
  const command = args.requireSubcommand();
  if (command === 'create') return runCreate(args);
  if (command === 'open') return runOpen(args);
  if (command === 'close') return runClose(args);
  return runShow(args);
}
