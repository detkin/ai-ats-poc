/**
 * lib/cli/execute.ts — turning a `TickPlan` into ledgered port calls (block B1.3).
 *
 * Owns: `executePlan`. `lib/engine/apply.ts` is the *reference* executor — a pure fold that
 * says what executing a plan means; this is the real one, performing the same state changes
 * through `rt.ports` so the adapter assigns ids, the allowlist gates every write and the
 * ledger records every call. The two are deliberately kept in step: if a `PlannedAction`
 * kind grows a case there, it grows one here.
 *
 * Action → calls (spec §7 step 2–4):
 *   anomaly          state.create('anomaly')                          — recorded, never obeyed
 *   complete_task    state.update('task', { status: 'done' })
 *   move_due_date    state.update('task', { due_at })                 — an engine write, not
 *                                                                       a proposal: no human
 *                                                                       judgement is involved
 *   nudge            one channel.sendDirect for the recipient, then one
 *                    state.create('nudge') + state.update('task') per bundled task, every
 *                    nudge carrying the DM's message_ref (docs/DECISIONS.md D17)
 *   escalate         propose.mjs's own createProposal, then each task → 'escalated', then one
 *                    DM to the recipient so a human learns a decision is waiting
 *   transition_cycle state.update('cycle', { status })
 *   close_cycle      state.update('cycle', { status: 'closed', closed_at })
 *   refresh_packet   packet.mjs's own assemblePacket — `calibration` for a review cycle,
 *                    `debrief` for an interview one, chosen by the engine's `packet_kind`
 *   place_hold / rebook / post_change / propose_decision
 *                    loop 2's actions, in `lib/cli/execute-interview.ts` (block B2.2). Note
 *                    what is *not* in that list: there is no `advance_stage` and no `reject`
 *                    executor, here or anywhere, because a candidate decision leaves the
 *                    engine only as a `tl_proposed_action` (spec §9).
 *
 * Public interface: `executePlan`, `ExecutedAction`, `ExecuteContext`.
 *
 * Spec: docs/SPEC.md §7, §9; docs/PLAN.md §4 block B1.3, §5 block B2.2.
 */

import { toInstant } from '#lib/adapters/index.ts';
import type { Runtime } from '#lib/adapters/index.ts';
import {
  executePlaceHold,
  executePostChange,
  executeProposeDecision,
  executeRebook,
} from '#lib/cli/execute-interview.ts';
import type { InterviewExecuteContext } from '#lib/cli/execute-interview.ts';
import { deliverNudge } from '#lib/cli/nudge.ts';
import type { NudgeTargetTask } from '#lib/cli/nudge.ts';
import { assemblePacket } from '#lib/cli/packet.ts';
import { createProposal } from '#lib/cli/propose.ts';
import { escalationFacts, ESCALATION_TEMPLATE_ID, renderTemplate } from '#lib/cli/templates.ts';
import type { Config } from '#lib/config.ts';
import type { PlannedAction, TickPlan, TickSnapshot } from '#lib/engine/index.ts';
import type { TlCycle, TlTask } from '#lib/types/engine.ts';
import type { Worker, WorkerId } from '#lib/types/tier1.ts';

/** One line of "what the tick actually did", as the CLI reports it. */
export interface ExecutedAction {
  kind: PlannedAction['kind'];
  task_id?: string;
  task_ids?: string[];
  to_worker_id?: WorkerId;
  template_id?: string;
  attempt_n?: number;
  from?: string;
  to?: string;
  record_id?: string;
  /** A bundled nudge writes one `tl_nudge` per task; those ids land here. */
  record_ids?: string[];
  message_ref?: string;
  detail?: string;
}

export interface ExecuteContext {
  snapshot: TickSnapshot;
  plan: TickPlan;
  workers: Map<WorkerId, Worker>;
}

/** Whole days a task is past due, from the plan's own detect pass. */
function overdueDaysFor(plan: TickPlan, taskIds: readonly string[]): number {
  let worst = 0;
  for (const id of taskIds) {
    const signal = plan.detected.by_task.get(id);
    if (signal !== undefined) worst = Math.max(worst, signal.overdue_days);
  }
  return worst;
}

/**
 * Perform every action in plan order. Returns one `ExecutedAction` per action, in the same
 * order, so `--json` output and the ledger tell the same story.
 */
export async function executePlan(
  rt: Runtime,
  config: Config,
  context: ExecuteContext,
): Promise<ExecutedAction[]> {
  const { plan, workers } = context;
  const tasks = new Map<string, TlTask>(context.snapshot.tasks.map((task) => [task.id, task]));
  let cycle: TlCycle = context.snapshot.cycle;
  const done: ExecutedAction[] = [];

  /** Built lazily, and always from the *current* cycle record and task map. */
  const interviewContext = (): InterviewExecuteContext => ({
    rt,
    config,
    cycle,
    snapshot: context.snapshot,
    workers,
    tasks,
  });

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'anomaly': {
        const anomaly = await rt.ports.state.create('anomaly', {
          cycle_id: cycle.id,
          ts: toInstant(rt.now()),
          source_ref: action.source_ref,
          excerpt: action.excerpt,
          rule: action.rule,
        });
        done.push({
          kind: action.kind,
          record_id: anomaly.id,
          detail: `${action.rule} in ${action.source_ref}`,
        });
        break;
      }

      case 'complete_task': {
        const updated = await rt.ports.state.update('task', action.task_id, { status: 'done' });
        tasks.set(updated.id, updated);
        done.push({
          kind: action.kind,
          task_id: action.task_id,
          record_id: action.submission_id,
        });
        break;
      }

      case 'move_due_date': {
        const updated = await rt.ports.state.update('task', action.task_id, { due_at: action.to });
        tasks.set(updated.id, updated);
        done.push({
          kind: action.kind,
          task_id: action.task_id,
          from: action.from,
          to: action.to,
          detail: action.reason,
        });
        break;
      }

      case 'nudge': {
        // One recipient, one DM, one `tl_nudge` per bundled task (docs/DECISIONS.md D17).
        const bundle: NudgeTargetTask[] = [];
        for (const entry of action.tasks) {
          const task = tasks.get(entry.task_id);
          if (task === undefined) continue;
          bundle.push({
            task,
            attemptN: entry.attempt_n,
            subject: task.external_ref === null ? undefined : workers.get(task.external_ref),
          });
        }
        if (bundle.length === 0) break;

        const delivered = await deliverNudge(rt, config, {
          cycle,
          toWorkerId: action.to_worker_id,
          recipient: workers.get(action.to_worker_id),
          tasks: bundle,
          templateId: action.template_id,
          attemptN: action.attempt_n,
          policyCheck: action.policy_check,
        });
        for (const task of delivered.tasks) tasks.set(task.id, task);
        done.push({
          kind: action.kind,
          task_ids: bundle.map((entry) => entry.task.id),
          to_worker_id: action.to_worker_id,
          template_id: action.template_id,
          attempt_n: action.attempt_n,
          record_ids: delivered.nudges.map((nudge) => nudge.id),
          message_ref: delivered.message_ref,
        });
        break;
      }

      case 'escalate': {
        const proposal = await createProposal(rt, {
          cycle_id: cycle.id,
          kind: 'escalate',
          payload: { task_ids: [...action.task_ids], to_worker_id: action.to_worker_id },
          rationale: action.rationale,
          evidence_refs: [...action.evidence_refs],
        });
        for (const taskId of action.task_ids) {
          const current = tasks.get(taskId);
          if (current === undefined || current.status === 'escalated') continue;
          const updated = await rt.ports.state.update('task', taskId, { status: 'escalated' });
          tasks.set(updated.id, updated);
        }
        const text = renderTemplate(
          config,
          ESCALATION_TEMPLATE_ID,
          escalationFacts({
            cycle,
            recipient: workers.get(action.to_worker_id),
            proposalId: proposal.id,
            taskCount: action.task_ids.length,
            evidenceCount: action.evidence_refs.length,
            worstOverdueDays: overdueDaysFor(plan, action.task_ids),
          }),
        );
        const delivery = await rt.ports.channel.sendDirect({
          to_worker_id: action.to_worker_id,
          text,
          template_id: ESCALATION_TEMPLATE_ID,
        });
        done.push({
          kind: action.kind,
          task_ids: [...action.task_ids],
          to_worker_id: action.to_worker_id,
          record_id: proposal.id,
          template_id: ESCALATION_TEMPLATE_ID,
          message_ref: delivery.message_ref,
        });
        break;
      }

      case 'transition_cycle': {
        cycle = await rt.ports.state.update('cycle', cycle.id, { status: action.to });
        done.push({
          kind: action.kind,
          from: action.from,
          to: action.to,
          record_id: cycle.id,
          detail: action.reason,
        });
        break;
      }

      case 'close_cycle': {
        cycle = await rt.ports.state.update('cycle', cycle.id, {
          status: 'closed',
          closed_at: toInstant(rt.now()),
        });
        done.push({ kind: action.kind, record_id: cycle.id, to: 'closed' });
        break;
      }

      case 'refresh_packet': {
        const result = await assemblePacket(rt, config, {
          cycleId: cycle.id,
          kind: action.packet_kind,
          now: context.snapshot.now,
        });
        done.push({
          kind: action.kind,
          record_id: result.packet.id,
          record_ids: result.anomalies.map((anomaly) => anomaly.id),
          detail:
            `${action.packet_kind} inputs_hash ${result.packet.inputs_hash.slice(0, 12)}…` +
            (result.anomalies.length === 0
              ? ''
              : `, ${result.anomalies.length} withheld scorecard(s) recorded as anomalies`),
        });
        break;
      }

      case 'place_hold': {
        done.push(await executePlaceHold(interviewContext(), action));
        break;
      }

      case 'rebook': {
        done.push(await executeRebook(interviewContext(), action));
        break;
      }

      case 'post_change': {
        done.push(await executePostChange(interviewContext(), action));
        break;
      }

      case 'propose_decision': {
        done.push(await executeProposeDecision(interviewContext(), action));
        break;
      }

      default: {
        // Exhaustiveness: a new PlannedAction kind must be executed here too.
        const never: never = action;
        throw new Error(`unhandled planned action: ${JSON.stringify(never)}`);
      }
    }
  }

  return done;
}
