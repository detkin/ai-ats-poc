/**
 * lib/engine/interview-plan.ts — the beats only an interview loop has (spec §8 loop 2).
 *
 * Owns: `planInterviewTick`, which runs **after** the generic rules in `plan.ts` and adds
 * the four things a review cycle never needs: book the panel, re-book on a decline, refresh
 * the debrief packet, and *propose* the stage decision. Everything else — detecting overdue
 * work, completing tasks the record proves are done, chasing scorecards with nudges, batching
 * per recipient, respecting absence and quiet hours, capping attempts, escalating, closing —
 * is loop 1's code, untouched. That reuse is the whole argument of spec §1 claim 1, so this
 * file is deliberately small, and block B2.3 made it smaller: completing an attendance task
 * once the slot has ended is a *generic* completion rule in `detect.ts`, not a beat here.
 *
 * Public interface:
 *   planInterviewTick(snapshot, detected?) -> PlannedAction[]
 *   mergeInterviewActions(generic, interview) -> PlannedAction[]
 *
 * The rules, in order:
 *   i.   no slot on record → `place_hold` for `panelFor(...)` at `chooseSlot(snapshot.slots)`;
 *   ii.  a decline against the current slot → `rebook` with `substituteFor(...)` plus one
 *        `post_change` to the summary channel; no substitute at that rank → `escalate`.
 *        Nobody who has declined *this* slot can be its stand-in, however many declines the
 *        tick is working through (docs/DECISIONS.md D23);
 *   iii. every scorecard in and the debrief inputs moved → `refresh_packet` kind `debrief`;
 *   iv.  the debrief packet on record is current → **one** `propose_decision`, citing the
 *        cycle, the application, the slot, **the debrief packet** and every scorecard.
 *
 * What is not here, on purpose:
 *  - **No `advance_stage`, no `reject`.** A candidate decision leaves the engine only as a
 *    `tl_proposed_action` a named human decides (spec §9). `PLANNED_ACTION_KINDS` has no
 *    such member and `tests/engine/interview-plan.test.ts` asserts it never gains one.
 *  - **No `request_scorecard`.** Chasing is the ordinary nudge over an overdue
 *    `submit_scorecard` task, so scorecard chase inherits loop 1's cadence and gates for free.
 *  - **No attendance rule.** The held slot is the evidence that the panel sat, and `detect`
 *    reads it under the same "has the completing record appeared?" rule that closes a review
 *    submission or a scorecard. Attendance is never nudged (D23), so there is nothing here to
 *    race against.
 *  - **No calendar call.** Candidate slots arrive on the snapshot, already filtered by the
 *    composed Availability port with Rippling absence in front (spec §4).
 *
 * Idempotence (spec §10): every rule is gated on state the executor changes — a slot on
 * record, an interviewer swapped out of that slot, a task gone terminal, a packet hash, an
 * open proposal — so `planTick(applyPlan(s, plan))` converges and then stays empty.
 *
 * Spec: docs/SPEC.md §4, §6, §7, §8 loop 2, §9, §10; docs/PLAN.md §5 block B2.1.
 */

import { detect } from '#lib/engine/detect.ts';
import { chooseSlot, panelFor, substituteFor } from '#lib/engine/interview-loop.ts';
import type { DetectSummary, PlannedAction, TickSnapshot } from '#lib/engine/snapshot.ts';
import type { TlInterviewSlot, TlProposedAction } from '#lib/types/engine.ts';
import type { Worker, WorkerId } from '#lib/types/tier1.ts';

/** Slot statuses that mean "this booking is the one in force". */
const LIVE_SLOT_STATUSES = new Set<TlInterviewSlot['status']>(['proposed', 'held']);

/** Proposal kinds that already carry the candidate decision for an application. */
const DECISION_KINDS = new Set<TlProposedAction['kind']>(['advance_stage', 'reject']);

/** The booking in force for this application: the newest live slot, by id. */
function activeSlotFor(
  slots: readonly TlInterviewSlot[],
  applicationId: string,
): TlInterviewSlot | undefined {
  return [...slots]
    .filter((slot) => slot.application_id === applicationId && LIVE_SLOT_STATUSES.has(slot.status))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .at(-1);
}

/** True when a decision of record for this application has already been proposed. */
function decisionAlreadyProposed(
  proposals: readonly TlProposedAction[],
  applicationId: string,
): boolean {
  return proposals.some(
    (proposal) =>
      DECISION_KINDS.has(proposal.kind) && proposal.payload.application_id === applicationId,
  );
}

/**
 * Loop 2's extra beats for one tick. `detected` is passed in by `plan.ts` so the tick derives
 * it once; a caller with only a snapshot may omit it.
 */
export function planInterviewTick(
  snapshot: TickSnapshot,
  detected: DetectSummary = detect(snapshot),
): PlannedAction[] {
  const actions: PlannedAction[] = [];
  const { application, requisition, cycle, workers } = snapshot;
  if (cycle.type !== 'interview' || application === undefined) return actions;

  const levels = snapshot.levels ?? new Map();
  const slots = snapshot.interview_slots ?? [];
  const active = activeSlotFor(slots, application.id);

  /* (i) Nobody is booked yet. */
  if (active === undefined) {
    if (requisition === undefined) return actions;
    const panel = panelFor(requisition, workers, levels, snapshot.policy);
    if (panel.length === 0) return actions;
    const attendeeIds = panel.map((worker) => worker.id);
    const slot = chooseSlot(snapshot.slots ?? [], {
      attendee_ids: attendeeIds,
      now: snapshot.now,
    });
    if (slot === null) return actions;
    actions.push({
      kind: 'place_hold',
      application_id: application.id,
      slot,
      attendee_ids: attendeeIds,
      evidence_refs: [application.id, requisition.id, ...attendeeIds],
    });
    return actions;
  }

  /* (ii) Somebody said no. Re-staff the same slot, or ask a human. */
  const slotDeclines = (snapshot.declines ?? []).filter((decline) => decline.slot_id === active.id);
  /**
   * Everybody who has ever said no to *this* slot. They stay excluded from substitution for
   * it even after they have been swapped off the panel: a second decline that re-picked the
   * first decliner would book somebody who has already said they cannot make the time
   * (docs/DECISIONS.md D23).
   */
  const declinedIds = new Set<WorkerId>(slotDeclines.map((decline) => decline.worker_id));
  const declines = [...slotDeclines]
    .filter((decline) => active.interviewer_worker_ids.includes(decline.worker_id))
    .sort((a, b) => (a.worker_id < b.worker_id ? -1 : a.worker_id > b.worker_id ? 1 : 0));

  /** The panel as this tick is leaving it — a second decline cannot pick the same stand-in. */
  let panelIds: WorkerId[] = [...active.interviewer_worker_ids];

  for (const decline of declines) {
    const declined = workers.get(decline.worker_id);
    if (declined === undefined) continue;
    // `substituteFor` excludes everyone it is handed, so the exclusion set is the live panel
    // plus every decliner of this slot.
    const excluded = [...new Set<WorkerId>([...panelIds, ...declinedIds])]
      .map((id) => workers.get(id))
      .filter((worker): worker is Worker => worker !== undefined);

    const substitute = substituteFor(declined, excluded, workers, levels, snapshot.availability);

    if (substitute === null) {
      // No same-rank peer is free. A thinner panel is a judgement call, so a human makes it.
      if (detected.covered_task_ids.has(decline.worker_id)) continue;
      const taskIds = detected.signals
        .filter(
          (signal) =>
            !signal.terminal &&
            signal.participant_worker_id === decline.worker_id &&
            signal.subject_worker_id === application.id,
        )
        .map((signal) => signal.task_id);
      actions.push({
        kind: 'escalate',
        task_ids: taskIds,
        to_worker_id: cycle.owner_worker_id,
        rationale:
          `Interviewer \`${decline.worker_id}\` declined slot \`${active.id}\` on application ` +
          `\`${application.id}\` and no ACTIVE worker at the same level rank on their team or ` +
          'in their department is free at that time. The panel is not re-staffed and the ' +
          'booking stands; a named human decides whether to run it short, move it, or widen ' +
          'the rank rule.',
        evidence_refs: [decline.worker_id, active.id, application.id, ...taskIds],
      });
      continue;
    }

    panelIds = panelIds.map((id) => (id === decline.worker_id ? substitute.id : id));
    actions.push({
      kind: 'rebook',
      slot_id: active.id,
      declined_worker_id: decline.worker_id,
      substitute_worker_id: substitute.id,
      evidence_refs: [active.id, application.id, decline.worker_id, substitute.id],
    });
    actions.push({
      kind: 'post_change',
      text:
        `Panel change on application \`${application.id}\`: \`${decline.worker_id}\` declined ` +
        `the ${active.start_at} slot, and \`${substitute.id}\` — same team, same level rank, ` +
        'not away — takes their place. The time is unchanged. No candidate decision was made.',
      evidence_refs: [active.id, application.id, decline.worker_id, substitute.id],
    });
  }

  /* (iii)/(iv) The write-ups are in: assemble the debrief, then propose the decision. */
  const scorecardSignals = detected.signals.filter(
    (signal) => signal.kind === 'submit_scorecard' && signal.subject_worker_id === application.id,
  );
  const allIn =
    scorecardSignals.length > 0 &&
    scorecardSignals.every((signal) => signal.terminal || signal.submission_id !== undefined);
  const debriefHash = snapshot.debrief_inputs_hash;

  if (allIn && debriefHash !== undefined) {
    const scorecardIds = scorecardSignals
      .map((signal) => signal.submission_id)
      .filter((id): id is string => id !== undefined);

    if (debriefHash !== snapshot.last_packet_inputs_hash) {
      actions.push({
        kind: 'refresh_packet',
        packet_kind: 'debrief',
        inputs_hash: debriefHash,
        evidence_refs: [cycle.id, application.id, ...scorecardIds],
      });
    } else if (!decisionAlreadyProposed(snapshot.proposals, application.id)) {
      const decisionKind = snapshot.proposed_decision_kind ?? 'advance_stage';
      // The packet the proposal was assembled from is evidence too: without it an auditor
      // walking `evidence_refs` can reach every scorecard but not the debrief that quoted
      // them (defect M2-D4). It is absent only when a caller hand-built the snapshot.
      const packetRefs = snapshot.last_packet_id === undefined ? [] : [snapshot.last_packet_id];
      actions.push({
        kind: 'propose_decision',
        decision_kind: decisionKind,
        application_id: application.id,
        rationale:
          `Every panel scorecard for application \`${application.id}\` is in and the debrief ` +
          'packet has been assembled from them, with each quotation cited to its scorecard. ' +
          'The engine states no view on the candidate and holds no rating: this proposal ' +
          'exists so a named human records the decision, and executes the stage move in ' +
          'Rippling themselves.',
        evidence_refs: [cycle.id, application.id, active.id, ...packetRefs, ...scorecardIds],
      });
    }
  }

  return actions;
}

/**
 * Fold loop 2's actions into the generic plan. The one interaction worth spelling out: while
 * the interview loop still has a hold to place, a panel to re-staff, a packet to assemble or
 * a decision to propose, the cycle must **not** close — otherwise a tick where the last
 * scorecard lands would close the cycle in the same breath, and the debrief and its proposal
 * would never be written. Loop 1's plan is returned untouched.
 */
export function mergeInterviewActions(
  generic: readonly PlannedAction[],
  interview: readonly PlannedAction[],
): PlannedAction[] {
  if (interview.length === 0) return [...generic];
  const holdsOpen = interview.some(
    (action) =>
      action.kind === 'place_hold' ||
      action.kind === 'rebook' ||
      action.kind === 'refresh_packet' ||
      action.kind === 'propose_decision',
  );
  if (!holdsOpen) return [...generic, ...interview];
  const kept = generic.filter(
    (action) =>
      action.kind !== 'close_cycle' &&
      !(action.kind === 'transition_cycle' && action.to === 'closing'),
  );
  return [...kept, ...interview];
}
