/**
 * lib/cli/snapshot-interview.ts — reading loop 2's world for one tick (block B2.2).
 *
 * Owns: `loadInterviewContext`, the interview half of `lib/cli/snapshot.ts`. It reads the
 * things only an interview cycle needs — the application and its requisition and candidate,
 * the levels the panel rules compare, the Tier-3 slots and scorecards, candidate hours from
 * the **composed** Availability port — and it turns the interviewers' Slack replies into the
 * two facts the engine understands: a decline, and a filed scorecard.
 *
 * Public interface:
 *   loadInterviewContext(rt, cycle, workers, now, options) -> InterviewContext
 *   activeSlotOf(slots, applicationId) -> TlInterviewSlot | undefined
 *   classifyReply(document) -> ReplyClassification
 *   isDeclineText(text), replyAuthorOf(ref)
 *   INTERVIEW_LEAD_DAYS, INTERVIEW_WINDOW_DAYS, INTERVIEW_DURATION_MIN,
 *   SCORECARD_REF_PREFIX, DECLINE_RE, InterviewContext, LoadInterviewOptions
 *
 * ## Replies are untrusted text, and the rules that read them are deliberately small
 *
 * `channel.readReplies(<the hold's ref>)` returns `UntrustedDocument`s — free human text
 * (spec §9). Three rules, in this order, and nothing else:
 *
 *  1. **Every reply is screened.** Each one is added to `TickSnapshot.untrusted`, so
 *     `detect` runs `detectInstructionText` over it and the tick records a `tl_anomaly` for
 *     anything aimed at the agent. The instruction is never followed. A reply that carries an
 *     injection *and* a genuine decline is still a decline: the anomaly is recorded and the
 *     decline is counted, because the interviewer's inability to attend is a fact about the
 *     world and not an order the text gave.
 *  2. **The author comes from metadata, never from the body.** `UntrustedDocument` carries
 *     `ref` and `text` and nothing else, so a scripted reply names its author in its
 *     `message_ref`: `<kind>_<worker_id>[_<suffix>]`, e.g. `reply_w_0024_decline` or
 *     `scorecard_w_0007`. A reply whose ref names no worker is screened and then ignored —
 *     the loop will not take a stranger's word for who wrote something. (Engine gap: a real
 *     Slack adapter has the author on the message; `lib/ports/channel.ts` does not expose it.
 *     Recorded in `lib/cli/README.md`.)
 *  3. **A decline needs an explicit phrase.** `DECLINE_RE` matches `decline`/`declines`/
 *     `declining`, `can't make` and `cannot make`, and nothing else. Anything vaguer stays a
 *     message a human reads; the engine does not infer intent from prose.
 *
 * `InterviewContext.declines` carries **every** decline the thread holds against the slot in
 * force, whether or not its author is still on the panel, deduplicated by author. Who still
 * needs a stand-in is the engine's question, not this module's — see `declinesOn` below.
 *
 * A reply whose ref begins `scorecard` is the interviewer's write-up. When the caller asks
 * to `observe`, the matching pending `tl_scorecard` is moved to `submitted` with the reply's
 * ref as its `body_ref` — the body itself is never inlined into state (spec §6). That write
 * is how the loop *observes the world*: on a tenant the scorecard arrives in Recruiting and
 * the tick reads it; on fixtures the inbox is that world.
 *
 * ## The scheduling window
 *
 * Candidate slots are asked for over `[now + INTERVIEW_LEAD_DAYS, + INTERVIEW_WINDOW_DAYS)`.
 * The lead time is the candidate's notice — an onsite booked for tomorrow morning is not a
 * scheduling success — and the window is the horizon past which "we will find a time" stops
 * meaning anything. The engine then takes the earliest hour the whole panel shares
 * (`chooseSlot`); it never asks a calendar anything itself.
 *
 * Spec: docs/SPEC.md §3 (Tier 3), §4, §6, §8 loop 2, §9; docs/PLAN.md §5 block B2.2.
 */

import type { Runtime } from '#lib/adapters/index.ts';
import { CliError } from '#lib/cli/runtime.ts';
import { addDays, dateOf, debriefInputsHash, panelFor, rankOf } from '#lib/engine/index.ts';
import type { InterviewDecline, UntrustedText } from '#lib/engine/index.ts';
import type { DebriefInputs } from '#lib/engine/packet-debrief.ts';
import type { Slot } from '#lib/ports/availability.ts';
import type { TlCycle, TlInterviewSlot, TlScorecard } from '#lib/types/engine.ts';
import type {
  Application,
  Candidate,
  InstantISO,
  JobRequisition,
  Level,
  LevelId,
  UntrustedDocument,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';

/** Days of notice before the earliest bookable hour. */
export const INTERVIEW_LEAD_DAYS = 5;
/** How far past the lead time the loop is willing to look for a shared hour. */
export const INTERVIEW_WINDOW_DAYS = 21;
/** Length of the onsite block the loop books. */
export const INTERVIEW_DURATION_MIN = 60;

/** A reply whose `message_ref` starts with this is an interviewer's scorecard. */
export const SCORECARD_REF_PREFIX = 'scorecard';

/**
 * The only phrasings that count as "I cannot attend". Narrow on purpose: a loop that guessed
 * at intent from free text would re-staff a panel because somebody wrote "I declined the
 * other offer".
 */
export const DECLINE_RE = /\bdeclin(?:e|es|ed|ing)\b|\bcan'?t make\b|\bcannot make\b/i;

/**
 * Worker ids as they appear inside a reply's `message_ref`. `_` is a word character, so
 * `\b` is no use here: `reply_w_0024_decline` has no boundary before the `w`. The rule is
 * "at the start, or after something that is not a letter or a digit".
 */
const AUTHOR_RE = /(?:^|[^a-z0-9])(w_\d+)/i;

/** Slot statuses that mean "this booking is the one in force" (mirrors the engine's rule). */
const LIVE_SLOT_STATUSES = new Set<TlInterviewSlot['status']>(['proposed', 'held']);

export interface LoadInterviewOptions {
  /**
   * Write the world back: a `scorecard` reply moves its pending `tl_scorecard` to
   * `submitted`. Only `bin/tick.mjs` passes `true`; a read-only caller (`packet.mjs`,
   * `cycle.mjs close`) leaves state alone and sees whatever is already on record.
   */
  observe?: boolean;
}

/** What one reply turned out to be. */
export interface ReplyClassification {
  ref: string;
  text: string;
  /** Author, from the reply's `message_ref`; `null` when the ref names no worker. */
  worker_id: WorkerId | null;
  is_scorecard: boolean;
  is_decline: boolean;
}

export interface InterviewContext {
  application: Application;
  requisition: JobRequisition;
  /** Read for its id only — the debrief packet strips every attribute of it (spec §9). */
  candidate: Candidate;
  levels: Map<LevelId, Level>;
  /** The panel in panel order: the booked slot's interviewers, else `panelFor`. */
  panel: Worker[];
  /** Candidate hours from the composed Availability port; empty once a slot is booked. */
  slots: Slot[];
  interview_slots: TlInterviewSlot[];
  scorecards: TlScorecard[];
  /** Every decline against the slot in force, panel member or not (`declinesOn`). */
  declines: InterviewDecline[];
  /** Every reply read this tick, for the generic anomaly screen. */
  untrusted: UntrustedText[];
  /** `body_ref` → the untrusted text behind it, for the debrief packet. */
  bodies: Record<string, string>;
  debrief: DebriefInputs;
  debrief_inputs_hash: string;
  /** Workers the tick needs an absence answer for beyond the task owners. */
  availability_ids: WorkerId[];
}

/** The booking in force for this application: the newest live slot, by id. */
export function activeSlotOf(
  slots: readonly TlInterviewSlot[],
  applicationId: string,
): TlInterviewSlot | undefined {
  return [...slots]
    .filter((slot) => slot.application_id === applicationId && LIVE_SLOT_STATUSES.has(slot.status))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .at(-1);
}

/** The worker a reply's `message_ref` names, or `null`. Metadata, never the body. */
export function replyAuthorOf(ref: string): WorkerId | null {
  return AUTHOR_RE.exec(ref)?.[1] ?? null;
}

/** Does this reply say, in so many words, that the interviewer cannot attend? */
export function isDeclineText(text: string): boolean {
  return DECLINE_RE.test(text);
}

/** Route one reply. Nothing here acts on the text; it only labels it. */
export function classifyReply(document: UntrustedDocument): ReplyClassification {
  const isScorecard = document.ref.startsWith(SCORECARD_REF_PREFIX);
  return {
    ref: document.ref,
    text: document.text,
    worker_id: replyAuthorOf(document.ref),
    is_scorecard: isScorecard,
    is_decline: !isScorecard && isDeclineText(document.text),
  };
}

/** The Tier-1 records the loop keys everything by. Re-read every tick (spec §3). */
async function readTier1(
  rt: Runtime,
  cycle: TlCycle,
): Promise<{ application: Application; requisition: JobRequisition; candidate: Candidate }> {
  const applicationId = cycle.scope.application_id;
  if (applicationId === undefined) {
    throw new CliError(
      'CYCLE_HAS_NO_APPLICATION',
      `interview cycle ${cycle.id} has no application in scope; create it with ` +
        '`node bin/cycle.mjs create --type interview --application <app_id> …`.',
    );
  }
  const application = await rt.ports.ats.getApplication(applicationId);
  if (application === null) {
    throw new CliError('APPLICATION_NOT_FOUND', `no application with id "${applicationId}".`);
  }
  const requisitionId = cycle.scope.requisition_id ?? application.job_id;
  const requisition = await rt.ports.ats.getRequisition(requisitionId);
  if (requisition === null) {
    throw new CliError('REQUISITION_NOT_FOUND', `no requisition with id "${requisitionId}".`);
  }
  const candidate = await rt.ports.ats.getCandidate(application.candidate_id);
  if (candidate === null) {
    throw new CliError(
      'CANDIDATE_NOT_FOUND',
      `no candidate with id "${application.candidate_id}".`,
    );
  }
  return { application, requisition, candidate };
}

/**
 * Move each replied-in scorecard to `submitted`. Returns the scorecard list as it now
 * stands, so the same tick that reads the reply can complete the task it evidences.
 */
async function observeScorecards(
  rt: Runtime,
  scorecards: readonly TlScorecard[],
  replies: readonly ReplyClassification[],
  applicationId: string,
  now: InstantISO,
): Promise<TlScorecard[]> {
  const byId = new Map(scorecards.map((card) => [card.id, card]));
  for (const reply of replies) {
    if (!reply.is_scorecard || reply.worker_id === null) continue;
    const target = [...byId.values()].find(
      (card) =>
        card.application_id === applicationId &&
        card.interviewer_worker_id === reply.worker_id &&
        card.status === 'pending',
    );
    if (target === undefined) continue;
    const updated = await rt.ports.state.update('scorecard', target.id, {
      status: 'submitted',
      body_ref: reply.ref,
      submitted_at: now,
    });
    byId.set(updated.id, updated);
  }
  return [...byId.values()];
}

/**
 * Everybody whose absence the tick must know about beyond the task owners: the panel, and —
 * when somebody has declined — the same-rank peers `substituteFor` may pick from. Scoping it
 * to the same rank keeps the read small; a worker outside it can never be chosen anyway.
 */
function availabilityIdsFor(
  panelIds: readonly WorkerId[],
  declines: readonly InterviewDecline[],
  workers: Map<WorkerId, Worker>,
  levels: Map<LevelId, Level>,
): WorkerId[] {
  const ids = new Set<WorkerId>(panelIds);
  for (const decline of declines) {
    const declined = workers.get(decline.worker_id);
    if (declined === undefined) continue;
    const rank = rankOf(levels, declined.level_id);
    if (rank === null) continue;
    for (const worker of workers.values()) {
      if (worker.status !== 'ACTIVE') continue;
      if (rankOf(levels, worker.level_id) !== rank) continue;
      if (worker.team_id !== declined.team_id && worker.department_id !== declined.department_id) {
        continue;
      }
      ids.add(worker.id);
    }
  }
  return [...ids].sort();
}

/**
 * Every decline this thread carries against the slot in force — **including** one from an
 * interviewer who has since been swapped off the panel.
 *
 * Panel membership is deliberately not a filter here. `planInterviewTick` needs the whole
 * decline history for the slot to keep a decliner out of its own substitution set; it decides
 * for itself which decline still needs a re-book, by looking at who is on the slot now
 * (docs/DECISIONS.md D23). Filtering here is what made a second decline re-book the first
 * decliner — the person who had already said they cannot make that hour (defect M2-D1).
 *
 * One decline per author: a second reply from somebody who has already declined is the same
 * fact stated twice, and two `rebook` actions for one worker would be a contradiction.
 */
function declinesOn(replies: readonly ReplyClassification[], slotId: string): InterviewDecline[] {
  const declines: InterviewDecline[] = [];
  const seen = new Set<WorkerId>();
  for (const reply of replies) {
    if (!reply.is_decline || reply.worker_id === null) continue;
    if (seen.has(reply.worker_id)) continue;
    seen.add(reply.worker_id);
    declines.push({
      worker_id: reply.worker_id,
      slot_id: slotId,
      reason: `slack reply ${reply.ref}`,
    });
  }
  return declines;
}

/**
 * Read everything loop 2 needs, through the ports. Sequential on purpose, like
 * `buildSnapshot`: the ledger's line order is then the order the tick asked its questions.
 */
export async function loadInterviewContext(
  rt: Runtime,
  cycle: TlCycle,
  workers: Map<WorkerId, Worker>,
  now: InstantISO,
  options: LoadInterviewOptions = {},
): Promise<InterviewContext> {
  const { application, requisition, candidate } = await readTier1(rt, cycle);
  const levels = new Map((await rt.ports.graph.listLevels()).map((level) => [level.id, level]));

  const interviewSlots: TlInterviewSlot[] = await rt.ports.state.list('interview_slot', {
    application_id: application.id,
  });
  let scorecards: TlScorecard[] = await rt.ports.state.list('scorecard', {
    application_id: application.id,
  });

  const active = activeSlotOf(interviewSlots, application.id);
  const documents: UntrustedDocument[] =
    active?.hold_ref === undefined || active.hold_ref === null
      ? []
      : await rt.ports.channel.readReplies(active.hold_ref);
  const replies = documents.map(classifyReply);
  const untrusted: UntrustedText[] = replies.map((reply) => ({
    source_ref: reply.ref,
    text: reply.text,
  }));

  if (options.observe === true && replies.some((reply) => reply.is_scorecard)) {
    scorecards = await observeScorecards(rt, scorecards, replies, application.id, now);
  }

  const declines: InterviewDecline[] = active === undefined ? [] : declinesOn(replies, active.id);

  const panelIds =
    active?.interviewer_worker_ids ??
    panelFor(requisition, workers, levels, rt.policy).map((worker) => worker.id);
  const panel = panelIds
    .map((id) => workers.get(id))
    .filter((worker): worker is Worker => worker !== undefined);

  const from = `${addDays(dateOf(now), INTERVIEW_LEAD_DAYS)}T00:00:00Z`;
  const to = `${addDays(dateOf(now), INTERVIEW_LEAD_DAYS + INTERVIEW_WINDOW_DAYS)}T00:00:00Z`;
  const slots =
    active === undefined && panelIds.length > 0
      ? await rt.ports.availability.findFreeSlots([...panelIds], {
          from,
          to,
          duration_min: INTERVIEW_DURATION_MIN,
        })
      : [];

  const bodies: Record<string, string> = {};
  for (const reply of replies) if (reply.is_scorecard) bodies[reply.ref] = reply.text;

  const debrief: DebriefInputs = {
    cycle,
    application,
    candidate,
    req: requisition,
    panel,
    scorecards,
    bodies,
    now,
  };

  return {
    application,
    requisition,
    candidate,
    levels,
    panel,
    slots,
    interview_slots: interviewSlots,
    scorecards,
    declines,
    untrusted,
    bodies,
    debrief,
    debrief_inputs_hash: debriefInputsHash(debrief),
    availability_ids: availabilityIdsFor(panelIds, declines, workers, levels),
  };
}
