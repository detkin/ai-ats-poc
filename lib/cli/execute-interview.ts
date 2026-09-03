/**
 * lib/cli/execute-interview.ts — loop 2's four actions, as ledgered port calls (block B2.2).
 *
 * Owns: the executors for `place_hold`, `rebook`, `post_change` and `propose_decision`.
 * `lib/engine/apply.ts` is the reference fold that says what each of them *means*; these are
 * the real ones, performing the same state changes through `rt.ports` so the adapter assigns
 * ids, the write allowlist gates every call and the ledger records all of it. The two are
 * kept in step deliberately — `tests/cli/interview-loop.test.ts` and
 * `tests/engine/apply.test.ts` assert the same outcomes from either side.
 *
 * Public interface:
 *   executePlaceHold, executeRebook, executePostChange, executeProposeDecision
 *   InterviewExecuteContext
 *
 * Action → calls:
 *   place_hold        availability.placeHold (composed: refuses if Rippling says an attendee
 *                     is away) → state.create('interview_slot') carrying the `hold_ref` →
 *                     one state.create('task') per attendance and per scorecard
 *                     (`interviewTasksFor`) → one state.create('scorecard') per panellist
 *                     (`scorecardsFor`) → one `interviewer_brief` DM per panellist, **on the
 *                     hold's thread**, which is the thread declines and scorecards come back on
 *   rebook            state.update on the slot's interviewer list, on the declining
 *                     interviewer's `attend_interview` / `submit_scorecard` tasks, and on
 *                     their still-pending `tl_scorecard` — the stand-in inherits the work,
 *                     and the record the work completes has to follow them or the task could
 *                     never close. Which rows move is `movesOnRebook` / `rekeysOnRebook` in
 *                     `lib/engine/interview-loop.ts`, so the reference fold and this executor
 *                     cannot drift apart (docs/DECISIONS.md D23)
 *   post_change       channel.postChannel to `policy.channels.summary_channel`
 *   propose_decision  createProposal — the same function `bin/propose.mjs` uses, and the only
 *                     way `advance_stage` or `reject` can enter the system (spec §9). There is
 *                     no stage write anywhere in this file, and there is no port that offers one.
 *
 * ## Two re-books in one tick compose (defect M2-D2)
 *
 * A tick can carry two declines, and then it plans two `rebook`s against the same slot. Each
 * one writes the whole `interviewer_worker_ids` array, so if both are computed from the
 * snapshot's pre-tick copy the second silently undoes the first: the slot ends up naming a
 * worker whose tasks and scorecard have moved to somebody else, and a panellist on the slot
 * holds neither. `InterviewExecuteContext` therefore carries **live** `slots` and `scorecards`
 * maps — exactly like the `tasks` map already worked — which every executor updates in place,
 * so each action reads the state the previous one left. `lib/engine/apply.ts` composes for the
 * same reason (it folds over its own running arrays); this makes the real executor agree.
 *
 * The alternative — planning at most one `rebook` per slot per tick and letting the next tick
 * take the second decline — was rejected: it leaves the corrupting write in place for anyone
 * who ever plans two, delays re-staffing by a whole tick, and would have to be re-litigated
 * for every future action that writes a list.
 *
 * Spec: docs/SPEC.md §4, §6, §7 step 2, §8 loop 2, §9; docs/PLAN.md §5 block B2.2.
 */

import { toInstant } from '#lib/adapters/index.ts';
import type { Runtime } from '#lib/adapters/index.ts';
import type { ExecutedAction } from '#lib/cli/execute.ts';
import { createProposal } from '#lib/cli/propose.ts';
import { CliError } from '#lib/cli/runtime.ts';
import {
  INTERVIEWER_BRIEF_TEMPLATE_ID,
  PACKET_TEMPLATE_DIR,
  PANEL_CHANGE_TEMPLATE_ID,
  interviewerBriefFacts,
  panelChangeFacts,
  renderTemplate,
} from '#lib/cli/templates.ts';
import type { Config } from '#lib/config.ts';
import {
  interviewSlotFor,
  interviewTasksFor,
  movesOnRebook,
  rekeysOnRebook,
  scorecardsFor,
} from '#lib/engine/index.ts';
import type {
  PlannedPlaceHold,
  PlannedPostChange,
  PlannedProposeDecision,
  PlannedRebook,
  TickSnapshot,
} from '#lib/engine/index.ts';
import type { TlCycle, TlInterviewSlot, TlScorecard, TlTask } from '#lib/types/engine.ts';
import type { Worker, WorkerId } from '#lib/types/tier1.ts';

/** What every loop-2 executor needs from the tick that is running it. */
export interface InterviewExecuteContext {
  rt: Runtime;
  config: Config;
  cycle: TlCycle;
  snapshot: TickSnapshot;
  workers: Map<WorkerId, Worker>;
  /** The tick's live task map; executors update it in place so later actions see the change. */
  tasks: Map<string, TlTask>;
  /** The tick's live Tier-3 slots, by id. Two re-books in one tick compose through this. */
  slots: Map<string, TlInterviewSlot>;
  /** The tick's live Tier-3 scorecards, by id. Re-keyed in place by `rebook`. */
  scorecards: Map<string, TlScorecard>;
}

/** The application the cycle is about, or a domain failure naming the cycle. */
function applicationOf(context: InterviewExecuteContext) {
  const application = context.snapshot.application;
  if (application === undefined) {
    throw new CliError(
      'CYCLE_HAS_NO_APPLICATION',
      `cycle ${context.cycle.id} planned an interview action but carries no application.`,
    );
  }
  return application;
}

/**
 * Book the panel: hold the time, record the Tier-3 slot, create the work it implies, and DM
 * every panellist the brief on the hold's own thread.
 *
 * The order matters. The hold comes first because it is the call that can be refused — the
 * composed Availability port throws `AbsenceWinsError` if Rippling reports an attendee away,
 * whatever their calendar says (spec §4) — and a refused hold must leave no tasks behind
 * claiming an interview that was never booked.
 */
export async function executePlaceHold(
  context: InterviewExecuteContext,
  action: PlannedPlaceHold,
): Promise<ExecutedAction> {
  const { rt, config, cycle, snapshot, workers, tasks } = context;
  const application = applicationOf(context);
  const requisition = snapshot.requisition;
  if (requisition === undefined) {
    throw new CliError(
      'CYCLE_HAS_NO_REQUISITION',
      `cycle ${cycle.id} planned a hold but carries no requisition.`,
    );
  }

  const panel = action.attendee_ids
    .map((id) => workers.get(id))
    .filter((worker): worker is Worker => worker !== undefined);

  // Titles reach a calendar other people can see: the requisition, never the candidate.
  const hold = await rt.ports.availability.placeHold(action.slot, {
    title: `Onsite panel — ${requisition.title} (${application.id})`,
    attendees: [...action.attendee_ids],
  });

  const slot = await rt.ports.state.create(
    'interview_slot',
    interviewSlotFor(application, panel, action.slot, hold.hold_ref),
  );
  context.slots.set(slot.id, slot);

  const created: TlTask[] = [];
  for (const task of interviewTasksFor(cycle, application, panel, action.slot, rt.policy)) {
    const record = await rt.ports.state.create('task', task);
    tasks.set(record.id, record);
    created.push(record);
  }
  const cards: TlScorecard[] = [];
  for (const card of scorecardsFor(application, panel)) {
    const record = await rt.ports.state.create('scorecard', card);
    context.scorecards.set(record.id, record);
    cards.push(record);
  }

  const scorecardDue =
    created.find((task) => task.kind === 'submit_scorecard')?.due_at ?? action.slot.end_at;
  const messageRefs: string[] = [];
  for (const worker of panel) {
    const text = renderTemplate(
      config,
      INTERVIEWER_BRIEF_TEMPLATE_ID,
      interviewerBriefFacts({
        recipient: worker,
        toWorkerId: worker.id,
        cycle,
        applicationId: application.id,
        requisitionId: requisition.id,
        reqTitle: requisition.title,
        criteria: requisition.criteria,
        panelIds: action.attendee_ids,
        startAt: action.slot.start_at,
        endAt: action.slot.end_at,
        scorecardDueAt: scorecardDue,
        holdRef: hold.hold_ref,
        summaryChannel: rt.policy.channels.summary_channel,
      }),
      PACKET_TEMPLATE_DIR,
    );
    const delivery = await rt.ports.channel.sendDirect({
      to_worker_id: worker.id,
      text,
      template_id: INTERVIEWER_BRIEF_TEMPLATE_ID,
      thread_ref: hold.hold_ref,
    });
    messageRefs.push(delivery.message_ref);
  }

  return {
    kind: action.kind,
    record_id: slot.id,
    record_ids: created.map((task) => task.id),
    template_id: INTERVIEWER_BRIEF_TEMPLATE_ID,
    detail:
      `hold ${hold.hold_ref} at ${action.slot.start_at} for ${panel.length} interviewer(s); ` +
      `${created.length} task(s), ${cards.length} pending scorecard(s), ` +
      `${messageRefs.length} brief(s) on thread ${hold.hold_ref}`,
  };
}

/**
 * Swap one interviewer for their stand-in on the booked slot. A staffing change and nothing
 * more: the time does not move, no candidate decision is made, and the slot keeps its hold.
 */
export async function executeRebook(
  context: InterviewExecuteContext,
  action: PlannedRebook,
): Promise<ExecutedAction> {
  const { rt, tasks, slots, scorecards } = context;
  // The slot as this tick has left it, not as the snapshot found it: a second re-book in the
  // same tick must swap its interviewer out of the panel the first one wrote (M2-D2).
  const slot =
    slots.get(action.slot_id) ?? (await rt.ports.state.get('interview_slot', action.slot_id));
  if (slot === null || slot === undefined) {
    throw new CliError('SLOT_NOT_FOUND', `no interview slot with id "${action.slot_id}".`);
  }
  if (!slot.interviewer_worker_ids.includes(action.declined_worker_id)) {
    throw new CliError(
      'INTERVIEWER_NOT_ON_SLOT',
      `worker "${action.declined_worker_id}" is not on interview slot "${slot.id}", so there ` +
        'is nothing to re-book; the panel changed under this plan.',
    );
  }

  const updated = await rt.ports.state.update('interview_slot', slot.id, {
    interviewer_worker_ids: slot.interviewer_worker_ids.map((id) =>
      id === action.declined_worker_id ? action.substitute_worker_id : id,
    ),
  });
  slots.set(updated.id, updated);

  // Only this decliner's rows move: `movesOnRebook` / `rekeysOnRebook` key on the worker who
  // is dropping out, and both maps are live, so an earlier re-book's rows are already theirs.
  const moved: string[] = [];
  for (const task of [...tasks.values()]) {
    if (!movesOnRebook(task, slot.application_id, action.declined_worker_id)) continue;
    const next = await rt.ports.state.update('task', task.id, {
      participant_worker_id: action.substitute_worker_id,
    });
    tasks.set(next.id, next);
    moved.push(next.id);
  }

  // The record that completes the moved scorecard task follows the person who now owes it —
  // the same rule `applyPlan` applies to the pure snapshot (docs/DECISIONS.md D23).
  let rekeyed = 0;
  for (const card of [...scorecards.values()]) {
    if (!rekeysOnRebook(card, slot.application_id, action.declined_worker_id)) continue;
    const next = await rt.ports.state.update('scorecard', card.id, {
      interviewer_worker_id: action.substitute_worker_id,
    });
    scorecards.set(next.id, next);
    rekeyed += 1;
  }

  return {
    kind: action.kind,
    record_id: updated.id,
    task_ids: moved,
    to_worker_id: action.substitute_worker_id,
    from: action.declined_worker_id,
    to: action.substitute_worker_id,
    detail:
      `${action.declined_worker_id} → ${action.substitute_worker_id} on ${updated.id}; ` +
      `${moved.length} task(s) and ${rekeyed} pending scorecard(s) reassigned`,
  };
}

/** Post the staffing change to the tenant's summary channel (`policy.channels.summary`). */
export async function executePostChange(
  context: InterviewExecuteContext,
  action: PlannedPostChange,
): Promise<ExecutedAction> {
  const { rt, config, cycle } = context;
  const channel = rt.policy.channels.summary_channel;
  const text = renderTemplate(
    config,
    PANEL_CHANGE_TEMPLATE_ID,
    panelChangeFacts({
      cycle,
      applicationId: applicationOf(context).id,
      summary: action.text,
      evidenceRefs: action.evidence_refs,
      channel,
    }),
    PACKET_TEMPLATE_DIR,
  );
  const post = await rt.ports.channel.postChannel({
    channel,
    text,
    template_id: PANEL_CHANGE_TEMPLATE_ID,
  });
  return {
    kind: action.kind,
    template_id: PANEL_CHANGE_TEMPLATE_ID,
    message_ref: post.message_ref,
    detail: `posted to ${channel}`,
  };
}

/**
 * Write the candidate decision as a proposal — the only shape it may take. Nothing here
 * touches the application: the stage lives on the real record, a named human moves it in the
 * ATS after deciding, and the next tick observes the result (spec §3, §9).
 */
export async function executeProposeDecision(
  context: InterviewExecuteContext,
  action: PlannedProposeDecision,
): Promise<ExecutedAction> {
  const proposal = await createProposal(context.rt, {
    cycle_id: context.cycle.id,
    kind: action.decision_kind,
    payload: { application_id: action.application_id },
    rationale: action.rationale,
    evidence_refs: [...action.evidence_refs],
  });
  return {
    kind: action.kind,
    record_id: proposal.id,
    detail: `${action.decision_kind} on ${action.application_id} — proposed at ${toInstant(
      context.rt.now(),
    )}, awaiting a named human`,
  };
}
