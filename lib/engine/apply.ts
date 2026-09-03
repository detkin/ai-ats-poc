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
 *      derived from the tick id, never a source of truth. In particular a `nudge` action is
 *      **one DM per recipient** (D17): one `message_ref` shared by one `tl_nudge` per
 *      bundled task, each moving its own task to `nudged` with its own `attempt_n`.
 *
 * M2 (block B2.1) adds reference implementations for loop 2's actions: `place_hold` creates
 * the `tl_interview_slot` the executor will carry the real `hold_ref` on, `rebook` swaps one
 * interviewer on that slot **and moves their work to the stand-in** — the tasks *and* the
 * pending `tl_scorecard` those tasks complete against (block B2.3; without the re-key the
 * stand-in's task could never close) — `post_change` changes no state at all (it is a
 * message), and `propose_decision` writes a `tl_proposed_action` — the only shape a candidate
 * decision may take (spec §9).
 *
 * Public interface: `applyPlan(snapshot, plan) -> TickSnapshot`.
 *
 * Every state change goes through `assertTransition` (`templates/loop-states.yml`), so a
 * plan that would drive an illegal task or cycle transition fails loudly here and in tests
 * rather than silently on a tenant.
 *
 * Spec: docs/SPEC.md §7 (tick), §10 (idempotence); docs/PLAN.md §2.5, §4 block B1.1.
 */

import { movesOnRebook, rekeysOnRebook } from '#lib/engine/interview-loop.ts';
import { assertTransition } from '#lib/states/index.ts';
import type { PlannedAction, TickPlan, TickSnapshot } from '#lib/engine/snapshot.ts';
import type {
  TlAnomaly,
  TlCycle,
  TlInterviewSlot,
  TlNudge,
  TlProposedAction,
  TlScorecard,
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
  const interviewSlots: TlInterviewSlot[] = (snapshot.interview_slots ?? []).map((slot) => ({
    ...slot,
  }));
  const scorecards: TlScorecard[] = (snapshot.scorecards ?? []).map((card) => ({ ...card }));
  let cycle: TlCycle = { ...snapshot.cycle };
  let packetHash = snapshot.last_packet_inputs_hash;
  let seq = 0;

  /** One deterministic id per *record* created, so a bundled nudge gets one id per task. */
  const nextId = (kind: string): string => {
    seq += 1;
    return placeholderId(kind, plan.tick_id, seq);
  };

  const apply = (action: PlannedAction): void => {
    switch (action.kind) {
      case 'anomaly': {
        anomalies.push({
          id: nextId('anomaly'),
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
        // One DM, one `message_ref`, one `tl_nudge` per bundled task (D17).
        const messageRef = `msg_${plan.tick_id.slice(0, 8)}_${action.to_worker_id}`;
        for (const entry of action.tasks) {
          const task = tasks.get(entry.task_id);
          if (task === undefined) continue;
          const nudged = setTaskStatus(task, 'nudged', now);
          tasks.set(task.id, {
            ...nudged,
            status: 'nudged',
            attempt_n: entry.attempt_n,
            nudged_at: now,
            updated_at: now,
          });
          nudges.push({
            id: nextId('nudge'),
            created_at: now,
            updated_at: now,
            created_by: actor,
            task_id: entry.task_id,
            cycle_id: cycle.id,
            channel: snapshot.policy.channels.nudge,
            sent_at: now,
            attempt_n: entry.attempt_n,
            template_id: action.template_id,
            delivered: true,
            message_ref: messageRef,
            policy_check: action.policy_check,
          });
        }
        return;
      }
      case 'escalate': {
        proposals.push({
          id: nextId('proposed_action'),
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
      case 'place_hold': {
        // The executor calls `availability.placeHold` and stores the ref it gets back; the
        // placeholder here is deterministic so idempotence is testable without a calendar.
        interviewSlots.push({
          id: nextId('interview_slot'),
          created_at: now,
          updated_at: now,
          created_by: actor,
          shadow: true,
          real_ref: action.application_id,
          application_id: action.application_id,
          interviewer_worker_ids: [...action.attendee_ids],
          start_at: action.slot.start_at,
          end_at: action.slot.end_at,
          hold_ref: `hold_${plan.tick_id.slice(0, 8)}`,
          status: 'held',
        });
        return;
      }
      case 'rebook': {
        const index = interviewSlots.findIndex((slot) => slot.id === action.slot_id);
        const slot = interviewSlots[index];
        if (slot === undefined) return;
        interviewSlots[index] = {
          ...slot,
          interviewer_worker_ids: slot.interviewer_worker_ids.map((id) =>
            id === action.declined_worker_id ? action.substitute_worker_id : id,
          ),
          updated_at: now,
        };
        // The stand-in inherits the work: attending, and the scorecard afterwards.
        for (const task of tasks.values()) {
          if (!movesOnRebook(task, slot.application_id, action.declined_worker_id)) continue;
          tasks.set(task.id, {
            ...task,
            participant_worker_id: action.substitute_worker_id,
            updated_at: now,
          });
        }
        // …and so does the record that completes it. `detect` matches a `submit_scorecard`
        // task to its scorecard on `application|interviewer`, so a pending scorecard left on
        // the person who dropped out would strand the stand-in's task and put a panellist who
        // never interviewed into the debrief (docs/DECISIONS.md D23).
        for (const [index, card] of scorecards.entries()) {
          if (!rekeysOnRebook(card, slot.application_id, action.declined_worker_id)) continue;
          scorecards[index] = {
            ...card,
            interviewer_worker_id: action.substitute_worker_id,
            updated_at: now,
          };
        }
        return;
      }
      case 'post_change': {
        // A message to the summary channel. It changes no record, which is why re-running a
        // converged plan cannot post it twice: the `rebook` that produces it is gated on the
        // declining interviewer still being on the slot.
        return;
      }
      case 'propose_decision': {
        proposals.push({
          id: nextId('proposed_action'),
          created_at: now,
          updated_at: now,
          created_by: actor,
          cycle_id: cycle.id,
          kind: action.decision_kind,
          payload: { application_id: action.application_id },
          rationale: action.rationale,
          evidence_refs: action.evidence_refs,
          status: 'proposed',
        });
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
    interview_slots: interviewSlots,
    scorecards,
    last_tick: { at: now, task_states: taskStates },
  };
  if (packetHash === undefined) delete next.last_packet_inputs_hash;
  else next.last_packet_inputs_hash = packetHash;
  return next;
}
