/**
 * lib/engine/apply.ts — the reference implementation of "what executing a plan means".
 *
 * Owns: `applyPlan`, a pure `(snapshot, plan) -> snapshot` fold that mutates nothing and
 * performs no I/O. It exists for two reasons:
 *   1. **Idempotence is testable without a filesystem** — `planTick(applyPlan(s, plan))`
 *      must have zero actions (spec §10).
 *   2. **It documents the executor.** `bin/tick.mjs` (block B1.3) performs exactly these
 *      state changes, but through `StatePort`/`ChannelPort` so every call is ledgered and
 *      the adapter assigns the real ids. Ids invented here are deterministic placeholders
 *      derived from the tick id, never a source of truth.
 *
 * Public interface: `applyPlan(snapshot, plan) -> TickSnapshot`.
 *
 * Every state change goes through `assertTransition` (`templates/loop-states.yml`), so a
 * plan that would drive an illegal task or cycle transition fails loudly here and in tests
 * rather than silently on a tenant.
 *
 * Spec: docs/SPEC.md §7 (tick), §10 (idempotence); docs/PLAN.md §2.5, §4 block B1.1.
 */

import { assertTransition } from '#lib/states/index.ts';
import type { PlannedAction, TickPlan, TickSnapshot } from '#lib/engine/snapshot.ts';
import type {
  TlAnomaly,
  TlCycle,
  TlNudge,
  TlProposedAction,
  TlTask,
  TlTaskState,
} from '#lib/types/engine.ts';

/** Deterministic placeholder id; the State adapter assigns the real one at runtime. */
function placeholderId(kind: string, tickId: string, seq: number): string {
  return `tl_${kind}_${tickId.slice(0, 8)}_${String(seq).padStart(3, '0')}`;
}

function setTaskStatus(task: TlTask, to: TlTaskState, now: string): TlTask {
  if (task.status === to) return task;
  assertTransition('task', task.status, to);
  return { ...task, status: to, updated_at: now };
}

/**
 * Fold a plan into the snapshot it came from. Order matters and is the plan's own order:
 * a task may be nudged and then escalated in the same tick, and a cycle may transition to
 * `closing` and then close.
 */
export function applyPlan(snapshot: TickSnapshot, plan: TickPlan): TickSnapshot {
  const now = snapshot.now;
  const actor = snapshot.actor_worker_id ?? snapshot.cycle.owner_worker_id;
  const tasks = new Map<string, TlTask>(snapshot.tasks.map((t) => [t.id, { ...t }]));
  const nudges: TlNudge[] = [...snapshot.nudges];
  const proposals: TlProposedAction[] = [...snapshot.proposals];
  const anomalies: TlAnomaly[] = [...(snapshot.anomalies ?? [])];
  let cycle: TlCycle = { ...snapshot.cycle };
  let packetHash = snapshot.last_packet_inputs_hash;
  let seq = 0;

  const apply = (action: PlannedAction): void => {
    seq += 1;
    switch (action.kind) {
      case 'anomaly': {
        anomalies.push({
          id: placeholderId('anomaly', plan.tick_id, seq),
          created_at: now,
          updated_at: now,
          created_by: actor,
          cycle_id: cycle.id,
          ts: now,
          source_ref: action.source_ref,
          excerpt: action.excerpt,
          rule: action.rule,
        });
        return;
      }
      case 'complete_task': {
        const task = tasks.get(action.task_id);
        if (task !== undefined) tasks.set(task.id, setTaskStatus(task, 'done', now));
        return;
      }
      case 'move_due_date': {
        const task = tasks.get(action.task_id);
        if (task !== undefined) tasks.set(task.id, { ...task, due_at: action.to, updated_at: now });
        return;
      }
      case 'nudge': {
        const task = tasks.get(action.task_id);
        if (task === undefined) return;
        const nudged = setTaskStatus(task, 'nudged', now);
        tasks.set(task.id, {
          ...nudged,
          status: 'nudged',
          attempt_n: action.attempt_n,
          nudged_at: now,
          updated_at: now,
        });
        nudges.push({
          id: placeholderId('nudge', plan.tick_id, seq),
          created_at: now,
          updated_at: now,
          created_by: actor,
          task_id: action.task_id,
          cycle_id: cycle.id,
          channel: snapshot.policy.channels.nudge,
          sent_at: now,
          attempt_n: action.attempt_n,
          template_id: action.template_id,
          delivered: true,
          policy_check: action.policy_check,
        });
        return;
      }
      case 'escalate': {
        proposals.push({
          id: placeholderId('proposed_action', plan.tick_id, seq),
          created_at: now,
          updated_at: now,
          created_by: actor,
          cycle_id: cycle.id,
          kind: 'escalate',
          payload: { task_ids: action.task_ids, to_worker_id: action.to_worker_id },
          rationale: action.rationale,
          evidence_refs: action.evidence_refs,
          status: 'proposed',
        });
        for (const taskId of action.task_ids) {
          const task = tasks.get(taskId);
          if (task !== undefined) tasks.set(taskId, setTaskStatus(task, 'escalated', now));
        }
        return;
      }
      case 'transition_cycle': {
        assertTransition('cycle', cycle.status, action.to);
        cycle = { ...cycle, status: action.to, updated_at: now };
        return;
      }
      case 'close_cycle': {
        if (cycle.status !== 'closed') {
          assertTransition('cycle', cycle.status, 'closed');
          cycle = { ...cycle, status: 'closed', closed_at: now, updated_at: now };
        }
        return;
      }
      case 'refresh_packet': {
        packetHash = action.inputs_hash;
        return;
      }
      default: {
        // Exhaustiveness: a new PlannedAction kind must be handled here.
        const never: never = action;
        throw new Error(`unhandled planned action: ${JSON.stringify(never)}`);
      }
    }
  };

  for (const action of plan.actions) apply(action);

  const taskList = [...tasks.values()];
  const taskStates: Record<string, TlTaskState> = {};
  for (const task of taskList) taskStates[task.id] = task.status;

  const next: TickSnapshot = {
    ...snapshot,
    cycle,
    tasks: taskList,
    nudges,
    proposals,
    anomalies,
    last_tick: { at: now, task_states: taskStates },
  };
  if (packetHash === undefined) delete next.last_packet_inputs_hash;
  else next.last_packet_inputs_hash = packetHash;
  return next;
}
