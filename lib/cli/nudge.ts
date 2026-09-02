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
 * Public interface: `NUDGE_SPEC`, `runNudge`, `deliverNudge`, `recordBlockedNudge`,
 * `NudgeContext`, `DeliveredNudge`.
 *
 * Spec: docs/SPEC.md §7 step 2, §9, §10; docs/PLAN.md §2.9, §4 block B1.3.
 */

import { toInstant } from '#lib/adapters/index.ts';
import type { Runtime } from '#lib/adapters/index.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { fail, ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { CliError, openRuntime } from '#lib/cli/runtime.ts';
import { buildSnapshot } from '#lib/cli/snapshot.ts';
import { nudgeFacts, renderTemplate } from '#lib/cli/templates.ts';
import type { Config } from '#lib/config.ts';
import { detect, nudgeTemplateId, policyCheckFor } from '#lib/engine/index.ts';
import type { TaskSignal } from '#lib/engine/index.ts';
import type { TlCycle, TlNudge, TlNudgePolicyCheck, TlTask } from '#lib/types/engine.ts';
import type { Worker, WorkerId } from '#lib/types/tier1.ts';

export const NUDGE_SPEC: CliSpec = {
  name: 'nudge.mjs',
  summary: 'send and record one policy-checked reminder for a single task',
  usage: ['bin/nudge.mjs --task <id> [--template <id>] [--force-policy-check]'],
  flags: [
    { name: 'task', type: 'string', value: '<id>', description: 'tl_task id to remind about' },
    {
      name: 'template',
      type: 'string',
      value: '<id>',
      description: 'override the template id (default: nudge.<task_kind>.<first|followup>)',
    },
    {
      name: 'force-policy-check',
      type: 'boolean',
      description: 'run the policy check and print it without sending or recording anything',
    },
  ],
  notes: [
    'There is no flag that bypasses the policy check. When it fails, the nudge is not sent,\n' +
      'a tl_nudge is recorded with delivered:false and the failing policy_check, and the\n' +
      'command exits 1.',
  ],
};

/** Everything one nudge needs that is not derivable from the task itself. */
export interface NudgeContext {
  cycle: TlCycle;
  task: TlTask;
  recipient: Worker | undefined;
  subject: Worker | undefined;
  templateId: string;
  attemptN: number;
  policyCheck: TlNudgePolicyCheck;
}

export interface DeliveredNudge {
  nudge: TlNudge;
  task: TlTask;
  message_ref: string;
  text: string;
}

/** The template a signal's nudge uses, unless the caller names one. */
export function templateIdFor(task: TlTask, attemptN: number, override?: string): string {
  return override ?? nudgeTemplateId(task.kind, attemptN);
}

/**
 * Send the DM, record the `tl_nudge`, then move the task to `nudged` with the new
 * `attempt_n`. Every step goes through a ledgered port.
 */
export async function deliverNudge(
  rt: Runtime,
  config: Config,
  context: NudgeContext,
): Promise<DeliveredNudge> {
  const text = renderTemplate(config, context.templateId, {
    ...nudgeFacts({
      task: context.task,
      cycle: context.cycle,
      recipient: context.recipient,
      subject: context.subject,
      attemptN: context.attemptN,
      maxAttempts: rt.policy.cadence.max_attempts,
    }),
  });

  const delivery = await rt.ports.channel.sendDirect({
    to_worker_id: context.task.participant_worker_id,
    text,
    template_id: context.templateId,
  });

  const now = toInstant(rt.now());
  const nudge = await rt.ports.state.create('nudge', {
    task_id: context.task.id,
    cycle_id: context.cycle.id,
    channel: rt.policy.channels.nudge,
    sent_at: now,
    attempt_n: context.attemptN,
    template_id: context.templateId,
    delivered: delivery.delivered,
    message_ref: delivery.message_ref,
    policy_check: context.policyCheck,
  });

  const task = await rt.ports.state.update('task', context.task.id, {
    status: 'nudged',
    attempt_n: context.attemptN,
    nudged_at: now,
  });

  return { nudge, task, message_ref: delivery.message_ref, text };
}

/**
 * Record a nudge that policy refused. The task is left exactly as it was: a blocked reminder
 * consumes no attempt and moves no state — it only explains itself.
 */
export async function recordBlockedNudge(
  rt: Runtime,
  context: Omit<NudgeContext, 'recipient' | 'subject'>,
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

/** Locate the task's signal by ticking `detect` over its cycle. */
async function signalForTask(
  taskId: string,
): Promise<{
  rt: Runtime;
  config: Config;
  cycle: TlCycle;
  task: TlTask;
  signal: TaskSignal;
  workers: Map<WorkerId, Worker>;
}> {
  const probe = openRuntime();
  const task = await probe.rt.ports.state.get('task', taskId);
  if (task === null) {
    throw new CliError('TASK_NOT_FOUND', `no task with id "${taskId}" in the runtime state.`);
  }

  const { snapshot, cycle, workers } = await buildSnapshot(probe.rt, task.cycle_id, probe.now, {
    withLastTick: false,
  });
  const signal = detect(snapshot).by_task.get(task.id);
  if (signal === undefined) {
    throw new CliError('TASK_NOT_IN_CYCLE', `task "${taskId}" is not part of cycle ${cycle.id}.`);
  }
  return { rt: probe.rt, config: probe.config, cycle, task, signal, workers };
}

export async function runNudge(args: Args): Promise<CliOutput> {
  const taskId = args.require('task');
  const { rt, config, cycle, task, signal, workers } = await signalForTask(taskId);

  const check = policyCheckFor(signal);
  const attemptN = task.attempt_n + 1;
  const templateId = templateIdFor(task, attemptN, args.get('template'));

  if (args.bool('force-policy-check')) {
    return ok(
      {
        task_id: task.id,
        cycle_id: cycle.id,
        template_id: templateId,
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
      templateId,
      attemptN,
      policyCheck: check,
    });
    return fail({ ...nudge, sent: false }, [
      `Nudge for ${task.id} was not sent: ${check.reasons.join(', ')}`,
      `  recorded as ${nudge.id} with delivered: false`,
      ...describeCheck(check),
    ]);
  }

  const delivered = await deliverNudge(rt, config, {
    cycle,
    task,
    recipient: workers.get(task.participant_worker_id),
    subject: task.external_ref === null ? undefined : workers.get(task.external_ref),
    templateId,
    attemptN,
    policyCheck: check,
  });

  return ok({ ...delivered.nudge, sent: true }, [
    `Nudged ${task.participant_worker_id} about ${task.id} (${task.kind}).`,
    `  nudge     ${delivered.nudge.id}, attempt ${attemptN} of ${rt.policy.cadence.max_attempts}`,
    `  template  ${templateId}`,
    `  message   ${delivered.message_ref} on ${rt.policy.channels.nudge}`,
  ]);
}
