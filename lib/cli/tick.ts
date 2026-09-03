/**
 * lib/cli/tick.ts — one tick of a cycle: detect, do, escalate, close (block B1.3).
 *
 * Owns: `runTick` / `tickCycle`, the whole of spec §7 wired together —
 *
 *   lock the cycle → build the snapshot through the ports → `planTick` (pure) →
 *   execute the plan through the ports → record the tick's task states → report.
 *
 * Three properties this file is responsible for:
 *
 *  - **One lock per cycle.** A scheduled tick and a manual run must not double-nudge the same
 *    person (spec §5); `withLock` releases in a `finally`, and a held lock is exit 1, not a
 *    queue.
 *  - **One `tick_id` per run.** It is derived from the cycle and the frozen `now`
 *    (`tickId(cycleId, now)`) *before* the runtime is built, so every ledger line the tick
 *    writes — reads included — carries it and `audit.mjs` can group them.
 *  - **A second tick changes nothing.** `--json` reports `changed: false` with an empty
 *    `actions` list, and the only ledger lines added are reads (spec §10, idempotence).
 *
 * `--dry-run` plans and reports without executing and without recording the tick, so it can
 * be run against a live cycle safely.
 *
 * Public interface: `TICK_SPEC`, `runTick`, `tickCycle`, `TickResult`.
 *
 * Spec: docs/SPEC.md §7, §8 loop 1, §10; docs/PLAN.md §2.9, §4 block B1.3.
 */

import type { Args, CliSpec } from '#lib/cli/args.ts';
import { executePlan } from '#lib/cli/execute.ts';
import type { ExecutedAction } from '#lib/cli/execute.ts';
import { ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { openRuntime } from '#lib/cli/runtime.ts';
import { buildSnapshot, writeLastTick } from '#lib/cli/snapshot.ts';
import { loadConfig, now as clockNow } from '#lib/config.ts';
import { toInstant } from '#lib/adapters/index.ts';
import { planTick, tickId as makeTickId } from '#lib/engine/index.ts';
import type { DetectSummary } from '#lib/engine/index.ts';
import { withLock } from '#lib/lock.ts';
import type { TlTaskState } from '#lib/types/engine.ts';

export const TICK_SPEC: CliSpec = {
  name: 'tick.mjs',
  summary: 'run one tick for a cycle: detect, do, escalate, close — under a per-cycle lock',
  usage: ['bin/tick.mjs --cycle <id> [--dry-run] [--scan <ref>] [--json]'],
  flags: [
    { name: 'cycle', type: 'string', value: '<id>', description: 'cycle to tick' },
    {
      name: 'dry-run',
      type: 'boolean',
      description: 'plan and report without writing anything',
    },
    {
      name: 'scan',
      type: 'string',
      value: '<ref>',
      description: 'extra untrusted document to screen this tick (e.g. resumes/cand_0003.md)',
      repeated: true,
    },
  ],
  notes: [
    'A second tick with nothing new reports changed: false and adds only read lines to the\n' +
      'ledger. Last-tick state lives in <TL_DATA_DIR>/ticks/<cycle_id>.json, outside state/.',
  ],
};

export interface TickResult {
  tick_id: string;
  cycle_id: string;
  now: string;
  dry_run: boolean;
  changed: boolean;
  detected: DetectSummary['counts'] & { cycle_status: string; anomalies: number };
  actions: ExecutedAction[];
  /** Reminders sent — one per **recipient**, which is one `nudge` action (D17). */
  nudges: number;
  /** Tasks those reminders covered; one `tl_nudge` each. */
  nudged_tasks: number;
  escalations: number;
  closed: boolean;
}

/** Plan and (unless `dryRun`) execute one tick. Assumes the caller holds the cycle lock. */
export async function tickCycle(options: {
  cycleId: string;
  dryRun: boolean;
  scan: readonly string[];
}): Promise<TickResult> {
  const config = loadConfig();
  const now = toInstant(clockNow(config));
  const tick = makeTickId(options.cycleId, now);
  const { rt } = openRuntime({ cycleId: options.cycleId, tickId: tick });

  const { snapshot, workers } = await buildSnapshot(rt, options.cycleId, now, {
    scan: options.scan,
  });
  const plan = planTick(snapshot);

  const actions: ExecutedAction[] = options.dryRun
    ? plan.actions.map((action) => ({
        kind: action.kind,
        ...('task_id' in action ? { task_id: action.task_id } : {}),
        ...('task_ids' in action ? { task_ids: [...action.task_ids] } : {}),
        ...('to_worker_id' in action ? { to_worker_id: action.to_worker_id } : {}),
        ...('template_id' in action ? { template_id: action.template_id } : {}),
        ...('attempt_n' in action ? { attempt_n: action.attempt_n } : {}),
        ...('from' in action ? { from: action.from } : {}),
        ...('to' in action ? { to: action.to } : {}),
      }))
    : await executePlan(rt, config, { snapshot, plan, workers });

  if (!options.dryRun) {
    const taskStates: Record<string, TlTaskState> = {};
    for (const signal of plan.detected.signals) taskStates[signal.task_id] = signal.status;
    for (const action of plan.actions) {
      if (action.kind === 'complete_task') taskStates[action.task_id] = 'done';
      if (action.kind === 'nudge') {
        for (const entry of action.tasks) taskStates[entry.task_id] = 'nudged';
      }
      if (action.kind === 'escalate') {
        for (const id of action.task_ids) taskStates[id] = 'escalated';
      }
    }
    writeLastTick(config, options.cycleId, { at: now, task_states: taskStates, tick_id: tick });
  }

  return {
    tick_id: plan.tick_id,
    cycle_id: options.cycleId,
    now,
    dry_run: options.dryRun,
    changed: plan.changed,
    detected: {
      ...plan.detected.counts,
      cycle_status: plan.detected.cycle_status,
      anomalies: plan.detected.anomalies.length,
    },
    actions,
    nudges: plan.actions.filter((action) => action.kind === 'nudge').length,
    nudged_tasks: plan.actions.reduce(
      (sum, action) => (action.kind === 'nudge' ? sum + action.tasks.length : sum),
      0,
    ),
    escalations: plan.actions.filter((action) => action.kind === 'escalate').length,
    closed: plan.actions.some((action) => action.kind === 'close_cycle'),
  };
}

function summarize(result: TickResult): string[] {
  const byKind = new Map<string, number>();
  for (const action of result.actions) {
    byKind.set(action.kind, (byKind.get(action.kind) ?? 0) + 1);
  }
  const counts = result.detected;
  const lines = [
    `Tick ${result.tick_id.slice(0, 12)} on ${result.cycle_id} at ${result.now}` +
      `${result.dry_run ? ' (dry run — nothing written)' : ''}`,
    `  detected  ${counts.tasks} task(s): ${counts.open} open, ${counts.overdue} overdue, ` +
      `${counts.absent} absent, ${counts.quiet} in quiet hours, ${counts.terminal} terminal`,
    `  changed   ${result.changed}`,
  ];
  if (byKind.size === 0) {
    lines.push('  actions   none — nothing to do this tick');
  } else {
    lines.push('  actions:');
    for (const [kind, count] of [...byKind].sort()) lines.push(`    ${kind.padEnd(16)} ${count}`);
  }
  if (result.nudges > 0) {
    lines.push(
      `  nudges    ${result.nudges} recipient(s), ${result.nudged_tasks} task(s) — ` +
        'one reminder per person, not per task',
    );
  }
  if (result.escalations > 0) {
    const escalation = result.actions.find((action) => action.kind === 'escalate');
    lines.push(
      `  escalated ${escalation?.task_ids?.length ?? 0} task(s) into proposal ` +
        `${escalation?.record_id ?? '(dry run)'} for ${escalation?.to_worker_id ?? '?'}`,
    );
  }
  if (result.closed) lines.push('  cycle closed');
  return lines;
}

export async function runTick(args: Args): Promise<CliOutput> {
  const cycleId = args.require('cycle');
  const dryRun = args.bool('dry-run');
  const scan = args.all('scan');
  const config = loadConfig();

  const result = await withLock(
    config.dataDir,
    cycleId,
    {
      staleMs: config.lockStaleMs,
      owner: `tick.mjs:${process.pid}`,
      now: () => clockNow(config),
    },
    async () => tickCycle({ cycleId, dryRun, scan }),
  );

  return ok(result, summarize(result));
}
