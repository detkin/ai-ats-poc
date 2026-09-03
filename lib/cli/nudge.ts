/**
 * lib/cli/nudge.ts — send and record one policy-checked reminder (block B1.3).
 *
 * Owns: `deliverNudge` (the send-and-record sequence the tick and this CLI both use) and
 * `recordBlockedNudge` (the record written when the policy gate says no). Both matter:
 * spec §10 wants the ledger to answer "why was this sent?" *and* "why was this not?", so a
 * refused nudge is a `tl_nudge` with `delivered: false` and the failing `policy_check`, not
 * silence.
 *
 * The gate itself is the engine's — `policyCheckFor(signal)` — so `bin/nudge.mjs` and the
 * tick can never disagree about absence, quiet hours, attempts or scope. There is no
 * override flag: `--force-policy-check` *runs* the check and prints it without sending
 * anything. Bypassing an absence check is the one thing the demo promises never happens
 * (spec §4, §8 loop 1).
 *
 * Order of writes, on purpose: send → record the nudge → update the task. A crash between
 * the DM and the record leaves a nudge nobody counted (a duplicate at worst); the reverse
 * order would leave a task claiming a reminder that never arrived.
 *
 * A reminder is addressed to a **person**, not a task (docs/DECISIONS.md D17): `deliverNudge`
 * takes a bundle of that person's tasks, sends one DM, and writes one `tl_nudge` per task
 * carrying the shared `message_ref`.
 *
 * **`--task` names the task, not the message** (block B2.2, fixing the M1 tester's O-1). One
 * DM per person also means one *cadence window* per person: nudging a single task used to
 * spend the recipient's whole `nudge_min_gap_hours` on it and silence everything else they
 * owed for two days. So `--task <id>` now sends the reminder that person is due — every task
 * of theirs in that cycle that clears the same gate — with the named task always in it,
 * whether or not it would have qualified on its own. `--only-this-task` restores the old
 * single-task behaviour for the rare case where that is genuinely what you want, and says so
 * out loud. The named task is what the gate is measured on and what the output reports.
 *
 * Public interface: `NUDGE_SPEC`, `runNudge`, `deliverNudge`, `recordBlockedNudge`,
 * `templateIdFor`, `bundleFor`, `NudgeContext`, `NudgeTargetTask`, `DeliveredNudge`.
 *
 * Spec: docs/SPEC.md §7 step 2, §9, §10; docs/PLAN.md §2.9, §4 block B1.3, §5 block B2.2.
 */

import { toInstant } from '#lib/adapters/index.ts';
import type { Runtime } from '#lib/adapters/index.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { fail, ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { CliError, openRuntimeForRecord } from '#lib/cli/runtime.ts';
import { buildSnapshot } from '#lib/cli/snapshot.ts';
import { nudgeFacts, renderTemplate } from '#lib/cli/templates.ts';
import type { NudgeFactTask } from '#lib/cli/templates.ts';
import type { Config } from '#lib/config.ts';
import { bundleTemplateId, detect, nudgeTemplateId, policyCheckFor } from '#lib/engine/index.ts';
import type { TaskSignal } from '#lib/engine/index.ts';
import type { TlCycle, TlNudge, TlNudgePolicyCheck, TlTask } from '#lib/types/engine.ts';
import type { Worker, WorkerId } from '#lib/types/tier1.ts';

export const NUDGE_SPEC: CliSpec = {
  name: 'nudge.mjs',
  summary: "send and record one policy-checked reminder covering a recipient's eligible tasks",
  usage: ['bin/nudge.mjs --task <id> [--only-this-task] [--template <id>] [--force-policy-check]'],
  flags: [
    {
      name: 'task',
      type: 'string',
      value: '<id>',
      description: 'tl_task id; the reminder covers its owner’s eligible tasks in that cycle',
    },
    {
      name: 'only-this-task',
      type: 'boolean',
      description: 'cover only the named task (it still spends the recipient’s cadence window)',
    },
    {
      name: 'template',
      type: 'string',
      value: '<id>',
      description: 'override the template id (default: nudge.<task_kind|multi>.<first|followup>)',
    },
    {
      name: 'force-policy-check',
      type: 'boolean',
      description: 'run the policy check and print it without sending or recording anything',
    },
  ],
  notes: [
    'One DM per person, so one cadence window per person: --task sends the reminder that\n' +
      'recipient is due, bundling every task of theirs in the cycle that clears the same\n' +
      'gate, with the named task always included. --only-this-task narrows it, and still\n' +
      'consumes the whole nudge_min_gap_hours for everything else they owe.',
    'There is no flag that bypasses the policy check. When it fails, the nudge is not sent,\n' +
      'a tl_nudge is recorded with delivered:false and the failing policy_check, and the\n' +
      'command exits 1.',
  ],
};

/** One task inside a bundled reminder, with the attempt it is about to spend. */
export interface NudgeTargetTask extends NudgeFactTask {
  /** The attempt this task's nudge *will be* — `task.attempt_n + 1`. */
  attemptN: number;
}

/** Everything one bundled reminder needs that is not derivable from the tasks themselves. */
export interface NudgeContext {
  cycle: TlCycle;
  /** Who the single DM goes to. */
  toWorkerId: WorkerId;
  recipient: Worker | undefined;
  /** The bundle — at least one task, all owed by `toWorkerId`. */
  tasks: readonly NudgeTargetTask[];
  templateId: string;
  /** The DM's own attempt number: the highest in the bundle. */
  attemptN: number;
  policyCheck: TlNudgePolicyCheck;
}

export interface DeliveredNudge {
  /** One `tl_nudge` per bundled task, all sharing `message_ref`. */
  nudges: TlNudge[];
  /** The bundled tasks, as the state adapter left them. */
  tasks: TlTask[];
  message_ref: string;
  text: string;
}

/** The template a signal's nudge uses, unless the caller names one. */
export function templateIdFor(task: TlTask, attemptN: number, override?: string): string {
  return override ?? nudgeTemplateId(task.kind, attemptN);
}

/**
 * The tasks one manual reminder covers: the named task, plus every other task the same
 * person owes in the same cycle that the tick itself would have nudged — open, not
 * escalated, overdue, and past the same policy gate. Sorted by task id, named task first,
 * so a run is reproducible and the operator can see what their DM will say.
 */
export function bundleFor(
  named: TaskSignal,
  signals: readonly TaskSignal[],
  onlyThisTask: boolean,
): TaskSignal[] {
  if (onlyThisTask) return [named];
  const others = signals
    .filter(
      (signal) =>
        signal.task_id !== named.task_id &&
        signal.participant_worker_id === named.participant_worker_id &&
        !signal.terminal &&
        signal.status !== 'escalated' &&
        signal.overdue &&
        signal.submission_id === undefined &&
        policyCheckFor(signal).passed,
    )
    .sort((a, b) => (a.task_id < b.task_id ? -1 : 1));
  return [named, ...others];
}

/**
 * Send **one** DM covering the whole bundle, record one `tl_nudge` per bundled task with
 * that message's `message_ref`, then move each task to `nudged` with its own `attempt_n`
 * (docs/DECISIONS.md D17). Every step goes through a ledgered port.
 */
export async function deliverNudge(
  rt: Runtime,
  config: Config,
  context: NudgeContext,
): Promise<DeliveredNudge> {
  const text = renderTemplate(
    config,
    context.templateId,
    nudgeFacts({
      tasks: context.tasks,
      cycle: context.cycle,
      toWorkerId: context.toWorkerId,
      recipient: context.recipient,
      attemptN: context.attemptN,
      maxAttempts: rt.policy.cadence.max_attempts,
    }),
  );

  const delivery = await rt.ports.channel.sendDirect({
    to_worker_id: context.toWorkerId,
    text,
    template_id: context.templateId,
  });

  const now = toInstant(rt.now());
  const nudges: TlNudge[] = [];
  const tasks: TlTask[] = [];
  for (const entry of context.tasks) {
    nudges.push(
      await rt.ports.state.create('nudge', {
        task_id: entry.task.id,
        cycle_id: context.cycle.id,
        channel: rt.policy.channels.nudge,
        sent_at: now,
        attempt_n: entry.attemptN,
        template_id: context.templateId,
        delivered: delivery.delivered,
        message_ref: delivery.message_ref,
        policy_check: context.policyCheck,
      }),
    );
    tasks.push(
      await rt.ports.state.update('task', entry.task.id, {
        status: 'nudged',
        attempt_n: entry.attemptN,
        nudged_at: now,
      }),
    );
  }

  return { nudges, tasks, message_ref: delivery.message_ref, text };
}

/**
 * Record a nudge that policy refused. The task is left exactly as it was: a blocked reminder
 * consumes no attempt and moves no state — it only explains itself.
 */
export async function recordBlockedNudge(
  rt: Runtime,
  context: {
    cycle: TlCycle;
    task: TlTask;
    templateId: string;
    attemptN: number;
    policyCheck: TlNudgePolicyCheck;
  },
): Promise<TlNudge> {
  return rt.ports.state.create('nudge', {
    task_id: context.task.id,
    cycle_id: context.cycle.id,
    channel: rt.policy.channels.nudge,
    sent_at: null,
    attempt_n: context.attemptN,
    template_id: context.templateId,
    delivered: false,
    policy_check: context.policyCheck,
  });
}

function describeCheck(check: TlNudgePolicyCheck): string[] {
  return [
    `  passed            ${check.passed}`,
    `  absent            ${check.absent}`,
    `  quiet_hours       ${check.quiet_hours}`,
    `  attempts_ok       ${check.attempts_ok}`,
    `  recipient_in_cycle ${check.recipient_in_cycle}`,
    ...(check.reasons.length === 0 ? [] : [`  reasons           ${check.reasons.join(', ')}`]),
  ];
}

/**
 * Locate the task's signal by ticking `detect` over its cycle.
 *
 * The task is resolved through `openRuntimeForRecord`, so the runtime this returns is
 * already scoped to the task's cycle and every ledger line it writes carries `cycle_id`
 * (docs/DECISIONS.md D19) — `audit.mjs --cycle` sees a standalone nudge.
 */
async function signalForTask(taskId: string): Promise<{
  rt: Runtime;
  config: Config;
  cycle: TlCycle;
  task: TlTask;
  signal: TaskSignal;
  signals: TaskSignal[];
  tasksById: Map<string, TlTask>;
  workers: Map<WorkerId, Worker>;
}> {
  const { opened, record } = await openRuntimeForRecord('task', taskId);
  if (record === null) {
    throw new CliError('TASK_NOT_FOUND', `no task with id "${taskId}" in the runtime state.`);
  }

  const { snapshot, cycle, workers } = await buildSnapshot(opened.rt, record.cycle_id, opened.now, {
    withLastTick: false,
  });
  const task = snapshot.tasks.find((row) => row.id === record.id) ?? record;
  const detected = detect(snapshot);
  const signal = detected.by_task.get(task.id);
  if (signal === undefined) {
    throw new CliError('TASK_NOT_IN_CYCLE', `task "${taskId}" is not part of cycle ${cycle.id}.`);
  }
  return {
    rt: opened.rt,
    config: opened.config,
    cycle,
    task,
    signal,
    signals: detected.signals,
    tasksById: new Map(snapshot.tasks.map((row) => [row.id, row])),
    workers,
  };
}

export async function runNudge(args: Args): Promise<CliOutput> {
  const taskId = args.require('task');
  const onlyThisTask = args.bool('only-this-task');
  const { rt, config, cycle, task, signal, signals, tasksById, workers } =
    await signalForTask(taskId);

  const check = policyCheckFor(signal);
  const attemptN = task.attempt_n + 1;
  const override = args.get('template');

  if (args.bool('force-policy-check')) {
    return ok(
      {
        task_id: task.id,
        cycle_id: cycle.id,
        template_id: templateIdFor(task, attemptN, override),
        policy_check: check,
        sent: false,
      },
      [`Policy check for ${task.id} (${task.kind}), nothing sent:`, ...describeCheck(check)],
    );
  }

  if (!check.passed) {
    const nudge = await recordBlockedNudge(rt, {
      cycle,
      task,
      templateId: templateIdFor(task, attemptN, override),
      attemptN,
      policyCheck: check,
    });
    return fail({ ...nudge, sent: false }, [
      `Nudge for ${task.id} was not sent: ${check.reasons.join(', ')}`,
      `  recorded as ${nudge.id} with delivered: false`,
      ...describeCheck(check),
    ]);
  }

  // One DM per person (docs/DECISIONS.md D17), so the bundle is the reminder this recipient
  // is due — not only the task the operator happened to name.
  const bundleSignals = bundleFor(signal, signals, onlyThisTask);
  const bundle: NudgeTargetTask[] = bundleSignals.flatMap((entry) => {
    const row = tasksById.get(entry.task_id);
    if (row === undefined) return [];
    return [
      {
        task: row,
        attemptN: row.attempt_n + 1,
        subject: row.external_ref === null ? undefined : workers.get(row.external_ref),
      },
    ];
  });
  const dmAttempt = bundle.reduce((max, entry) => Math.max(max, entry.attemptN), 1);
  const templateId =
    override ??
    bundleTemplateId(
      bundle.map((entry) => entry.task.kind),
      dmAttempt,
    );

  const delivered = await deliverNudge(rt, config, {
    cycle,
    toWorkerId: task.participant_worker_id,
    recipient: workers.get(task.participant_worker_id),
    tasks: bundle,
    templateId,
    attemptN: dmAttempt,
    policyCheck: check,
  });

  // The named task is what was asked about, so it is what the output reports.
  const nudge =
    delivered.nudges.find((entry) => entry.task_id === task.id) ?? (delivered.nudges[0] as TlNudge);
  return ok(
    {
      ...nudge,
      sent: true,
      bundled_task_ids: bundle.map((entry) => entry.task.id),
      nudge_ids: delivered.nudges.map((entry) => entry.id),
    },
    [
      `Nudged ${task.participant_worker_id} about ${task.id} (${task.kind})` +
        (bundle.length > 1 ? ` and ${bundle.length - 1} other task(s) they owe.` : '.'),
      `  nudge     ${nudge.id}, attempt ${nudge.attempt_n} of ${rt.policy.cadence.max_attempts}`,
      `  bundled   ${bundle.map((entry) => entry.task.id).join(', ')}`,
      `  template  ${templateId}`,
      `  message   ${delivered.message_ref} on ${rt.policy.channels.nudge}`,
      ...(onlyThisTask
        ? [
            '  note      --only-this-task: the rest of this person’s work is silent for ' +
              `${rt.policy.cadence.nudge_min_gap_hours}h all the same.`,
          ]
        : []),
    ],
  );
}
