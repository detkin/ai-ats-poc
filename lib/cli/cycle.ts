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
 * Public interface: `CYCLE_SPEC`, `runCycle`, `createCycle`, `openCycle`, `closeCycle`,
 * `showCycle`, `CreateCycleInput`, `OpenResult`, `CloseResult`, `ShowResult`.
 *
 * Spec: docs/SPEC.md §6, §7, §8 loop 1; docs/PLAN.md §2.9, §4 block B1.3.
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

/** Record a new cycle in `configured`. It owes nothing until `open`. */
export async function createCycle(rt: Runtime, input: CreateCycleInput): Promise<TlCycle> {
  const owner = await rt.ports.graph.lookupPerson(input.owner);
  if (owner === null) {
    throw new CliError('OWNER_NOT_FOUND', `no worker with id "${input.owner}" to own the cycle.`);
  }
  const scope: TlCycleScope = {
    ...(input.departments.length === 0 ? {} : { department_ids: [...input.departments] }),
    ...(input.applicationId === undefined ? {} : { application_id: input.applicationId }),
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
 * Open a review cycle: `opened_at`, `running`, then one `tl_task` and one pending
 * `tl_review_submission` per unit of work.
 */
export async function openCycle(rt: Runtime, cycleId: string, now: string): Promise<OpenResult> {
  const cycle = await loadCycle(rt, cycleId);
  if (cycle.type !== 'review') {
    throw new CliError(
      'CYCLE_TYPE_NOT_YET',
      `opening a ${cycle.type} cycle lands in M2 (block B2.2); M1 opens review cycles.`,
    );
  }
  if (cycle.opened_at !== null) {
    throw new CliError(
      'CYCLE_ALREADY_OPEN',
      `cycle ${cycle.id} was opened at ${cycle.opened_at}; opening it again would duplicate its tasks.`,
    );
  }
  assertTransition('cycle', cycle.status, 'running', rt.states);

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
    `  scope     ${cycle.scope.department_ids?.join(', ') ?? 'whole company'}`,
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
      `  participants  ${result.participants}`,
      `  tasks         ${result.tasks.length}`,
      ...Object.entries(result.by_kind)
        .sort()
        .map(([kind, count]) => `    ${kind.padEnd(22)} ${count}`),
      `  submissions   ${result.submissions} pending shadow record(s)`,
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
    `  scope       ${result.cycle.scope.department_ids?.join(', ') ?? 'whole company'}`,
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
