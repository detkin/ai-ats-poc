/**
 * lib/cli/verify.ts — reconcile state against the ledger and against Tier 1 (block B1.3).
 *
 * Owns: `verifyLoops`, the health check spec §5 describes as "state ↔ ledger ↔ real objects;
 * fails loudly". Drift between two sources of truth is the bug class this whole design is
 * built to avoid, so the check runs on demand and exits non-zero on any finding.
 *
 * The seven rules:
 *
 *  1. `done_task_has_submission`  — a review task marked `done` has a **submitted**
 *     `tl_review_submission` behind it. A task that is done because something edited a file
 *     is exactly the drift the POC promises to catch.
 *  2. `nudged_task_has_nudges`    — a task with `attempt_n = n` has at least n `tl_nudge`
 *     records; every delivered one carries a `message_ref`; and each distinct `message_ref`
 *     has **exactly one** `channel.sendDirect` `ok` line in the ledger. Nudges bundled into
 *     one DM share a `message_ref` (docs/DECISIONS.md D17), so "one per nudge" would be the
 *     wrong rule — "one send per message" is the right one.
 *  3. `escalated_task_in_proposal`— an `escalated` task is cited by an `escalate` proposal's
 *     `evidence_refs`. Escalation without evidence is a rumour.
 *  4. `state_records_ledgered`    — every adapter-assigned `tl_*` record id appears as a
 *     `result_ref` in the ledger. Hand-authored fixture ids (`tl_cycle_h2_2026`) are exempt:
 *     they were seeded, not written by an agent.
 *  5. `references_resolve`        — every task participant and every `external_ref` resolves
 *     to a Tier-1 worker through the Graph port.
 *  6. `cycle_status_canonical`    — the stored status is a canonical state of the `cycle`
 *     machine in `templates/loop-states.yml`, not an alias and not a typo.
 *  7. `decisions_by_active_worker`— a decided proposal names a decider, and that worker is
 *     ACTIVE.
 *
 * Loop 2 adds four (blocks B2.2 and B2.4):
 *
 *  8. `interview_slot_held`       — every `tl_interview_slot` carrying a `hold_ref` has a
 *     matching line in `holds.jsonl` **and** an `availability.placeHold` `ok` line in the
 *     ledger naming it. A slot that claims a booking no calendar ever received is the loop-2
 *     shape of the drift rule 1 catches for loop 1.
 *  9. `scorecard_task_has_submission` — a `submit_scorecard` task marked `done` has a
 *     `submitted` `tl_scorecard` for that application and that interviewer. After a re-book
 *     that means the *stand-in's* scorecard, which is why the executor re-keys it.
 * 10. `no_stage_in_engine_state`  — **no `tl_*` record anywhere carries a `stage`.** Spec §3
 *     is a rule about what the engine may hold, not only about what it writes today: a stage
 *     lives on the real application, is re-read every tick, and moves only when a named human
 *     moves it. A `stage` key appearing on engine state would mean a shadow pipeline had
 *     started, and this rule fails the moment one does. It is checked on the whole runtime
 *     state, not per cycle.
 * 11. `interview_panel_reconciles` — for every `tl_interview_slot` that is not cancelled, the
 *     people holding `attend_interview` / `submit_scorecard` tasks and `tl_scorecard` records
 *     for that application are **exactly** the slot's `interviewer_worker_ids`, one of each
 *     per panellist (block B2.4). A re-book rewrites three places at once — the slot, the
 *     tasks and the scorecard — and a tick that re-books twice used to leave them disagreeing
 *     (defect M2-D2): somebody holding the work for a panel they are not on, somebody on the
 *     panel holding none of it. Rules 8 and 9 both passed on exactly that state, which is why
 *     this one exists: it reconciles the slot against the work, not either against itself.
 *
 * Everything is read through `rt.raw` — verifying must not itself write ledger lines, or the
 * second run would have a different ledger to verify than the first.
 *
 * Public interface: `VERIFY_SPEC`, `runVerify`, `verifyLoops`, `VerifyReport`, `RuleResult`,
 * `ENGINE_ID_RE`.
 *
 * Spec: docs/SPEC.md §3, §5, §9, §10; docs/PLAN.md §2.9, §4 block B1.3, §5 block B2.2.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HOLDS_FILENAME } from '#lib/adapters/index.ts';
import type { HoldLine, Runtime } from '#lib/adapters/index.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { fail, ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { openRuntime } from '#lib/cli/runtime.ts';
import { submissionKindOfTask } from '#lib/engine/index.ts';
import { canonicalState } from '#lib/states/index.ts';
import { STATE_KINDS } from '#lib/types/engine.ts';
import type {
  TlAgentAction,
  TlCycle,
  TlInterviewSlot,
  TlNudge,
  TlPacket,
  TlProposedAction,
  TlReviewSubmission,
  TlScorecard,
  TlTask,
} from '#lib/types/engine.ts';
import type { Worker, WorkerId } from '#lib/types/tier1.ts';

/** An id the State adapter assigned: `tl_<kind>_<8 hex>`. Seeded ids look different. */
export const ENGINE_ID_RE = /^tl_[a-z_]+_[0-9a-f]{8}$/;

export const VERIFY_SPEC: CliSpec = {
  name: 'verify-loops.mjs',
  summary: 'reconcile engine state against the ledger and Tier-1 records; non-zero on drift',
  usage: ['bin/verify-loops.mjs [--cycle <id>] [--json]'],
  flags: [
    {
      name: 'cycle',
      type: 'string',
      value: '<id>',
      description: 'check one cycle; omit to check every cycle in the runtime state',
    },
  ],
  notes: ['Exit 1 on any drift, with the offending record ids named.'],
};

export interface RuleResult {
  id: string;
  description: string;
  /** How many records this rule looked at. */
  checked: number;
  /** Offending record ids, with a short reason each. */
  findings: { id: string; detail: string }[];
}

export interface VerifyReport {
  ok: boolean;
  cycle_ids: string[];
  rules: RuleResult[];
  totals: { checked: number; findings: number };
}

interface CycleBundle {
  cycle: TlCycle;
  tasks: TlTask[];
  nudges: TlNudge[];
  proposals: TlProposedAction[];
  submissions: TlReviewSubmission[];
  packets: TlPacket[];
  /**
   * Tier-3 records for the application this cycle is about. They are keyed by
   * `application_id`, not by cycle — they hang off a real ATS record, which is the whole
   * point of Tier 3 (spec §3) — so they are fetched by that id and are empty for loop 1.
   */
  slots: TlInterviewSlot[];
  scorecards: TlScorecard[];
}

function rule(id: string, description: string): RuleResult {
  return { id, description, checked: 0, findings: [] };
}

/** Every state record for one cycle, read unledgered. */
async function readBundle(rt: Runtime, cycle: TlCycle): Promise<CycleBundle> {
  const filter = { cycle_id: cycle.id } as const;
  const applicationId = cycle.scope.application_id;
  const byApplication = applicationId === undefined ? undefined : { application_id: applicationId };
  return {
    cycle,
    tasks: await rt.raw.state.list('task', filter),
    nudges: await rt.raw.state.list('nudge', filter),
    proposals: await rt.raw.state.list('proposed_action', filter),
    submissions: await rt.raw.state.list('review_submission', filter),
    packets: await rt.raw.state.list('packet', filter),
    slots:
      byApplication === undefined ? [] : await rt.raw.state.list('interview_slot', byApplication),
    scorecards:
      byApplication === undefined ? [] : await rt.raw.state.list('scorecard', byApplication),
  };
}

/** Every `hold_ref` in `<TL_DATA_DIR>/holds.jsonl`. A missing file is an empty calendar. */
function heldRefs(dataDir: string): Set<string> {
  const path = join(dataDir, HOLDS_FILENAME);
  if (!existsSync(path)) return new Set();
  const refs = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<HoldLine>;
      if (typeof parsed.hold_ref === 'string') refs.add(parsed.hold_ref);
    } catch {
      // A malformed line is not a hold; rule 8 reports the slot that expected one.
    }
  }
  return refs;
}

/** `application|interviewer` keys of every scorecard that has actually been filed. */
function submittedScorecardKeys(scorecards: readonly TlScorecard[]): Set<string> {
  const keys = new Set<string>();
  for (const card of scorecards) {
    if (card.status !== 'submitted') continue;
    keys.add(`${card.application_id}|${card.interviewer_worker_id}`);
  }
  return keys;
}

/**
 * Does this engine record hold a `stage`? Checked at the top level and one level into
 * `payload`, which is the only free-form object on a `tl_*` record.
 */
function stageKeyIn(record: Record<string, unknown>): string | null {
  if ('stage' in record) return 'stage';
  const payload = record['payload'];
  if (payload !== null && typeof payload === 'object' && 'stage' in payload) {
    return 'payload.stage';
  }
  return null;
}

function submittedKeys(submissions: readonly TlReviewSubmission[]): Set<string> {
  const keys = new Set<string>();
  for (const submission of submissions) {
    if (submission.status !== 'submitted') continue;
    keys.add(
      [
        submission.cycle_id,
        submission.subject_worker_id,
        submission.author_worker_id,
        submission.kind,
      ].join('|'),
    );
  }
  return keys;
}

/** Task kinds a panellist holds exactly one of, per slot they are on. */
const PANEL_TASK_KINDS = ['attend_interview', 'submit_scorecard'] as const;

/** `worker → how many of these rows they hold`, for one application. */
function countBy<T>(rows: readonly T[], key: (row: T) => WorkerId): Map<WorkerId, number> {
  const counts = new Map<WorkerId, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return counts;
}

/**
 * Rule 11. Reconcile one slot's panel against the work keyed to its application: every
 * panellist holds exactly one task of each kind and exactly one scorecard, and nobody else
 * holds any of it. The finding names the slot and the workers, because "which worker" is the
 * first question anyone asks of this failure.
 */
function panelFindings(
  slot: TlInterviewSlot,
  bundle: CycleBundle,
): { id: string; detail: string }[] {
  const findings: { id: string; detail: string }[] = [];
  const panel = new Set<WorkerId>(slot.interviewer_worker_ids);
  const cards = bundle.scorecards.filter((card) => card.application_id === slot.application_id);
  const byKind = new Map<string, Map<WorkerId, number>>(
    PANEL_TASK_KINDS.map((kind) => [
      kind,
      countBy(
        bundle.tasks.filter(
          (task) => task.kind === kind && task.external_ref === slot.application_id,
        ),
        (task) => task.participant_worker_id,
      ),
    ]),
  );
  byKind.set(
    'tl_scorecard',
    countBy(cards, (card) => card.interviewer_worker_id),
  );

  for (const [what, counts] of byKind) {
    // Nothing at all of this kind exists yet (a slot booked by a plan that never ran its
    // task creation is rule 8's business, not this one).
    if (counts.size === 0) continue;
    for (const worker of panel) {
      const held = counts.get(worker) ?? 0;
      if (held === 1) continue;
      findings.push({
        id: slot.id,
        detail:
          held === 0
            ? `${worker} is on the slot but holds no ${what} for application ${slot.application_id}`
            : `${worker} holds ${held} ${what} rows for application ${slot.application_id}; a panellist holds one`,
      });
    }
    for (const [worker, held] of counts) {
      if (panel.has(worker)) continue;
      findings.push({
        id: slot.id,
        detail:
          `${worker} holds ${held} ${what} row(s) for application ${slot.application_id} but is ` +
          `not on the slot (panel: ${slot.interviewer_worker_ids.join(', ')})`,
      });
    }
  }
  return findings;
}

/**
 * Run every rule over the given cycles.
 * @param cycleId check one cycle; omit for all of them.
 */
export async function verifyLoops(rt: Runtime, cycleId?: string): Promise<VerifyReport> {
  const allCycles: TlCycle[] = await rt.raw.state.list('cycle');
  const cycles = cycleId === undefined ? allCycles : allCycles.filter((c) => c.id === cycleId);

  const rules = {
    submission: rule(
      'done_task_has_submission',
      'a done review task has a submitted shadow record',
    ),
    nudges: rule('nudged_task_has_nudges', 'attempt_n is backed by nudge records and ledger sends'),
    escalated: rule('escalated_task_in_proposal', 'an escalated task is cited by a proposal'),
    ledgered: rule('state_records_ledgered', 'every engine-written record has a ledger line'),
    references: rule('references_resolve', 'participants and external_refs are real workers'),
    status: rule('cycle_status_canonical', 'cycle status is a canonical state'),
    decisions: rule('decisions_by_active_worker', 'decided proposals name an ACTIVE decider'),
    holds: rule(
      'interview_slot_held',
      'a held interview slot has a calendar hold and a ledger line',
    ),
    scorecards: rule(
      'scorecard_task_has_submission',
      'a done submit_scorecard task has a submitted tl_scorecard',
    ),
    noStage: rule('no_stage_in_engine_state', 'no tl_* record holds an application stage'),
    panel: rule(
      'interview_panel_reconciles',
      'a slot’s interviewers are exactly the people holding its tasks and scorecards',
    ),
  };

  if (cycleId !== undefined && cycles.length === 0) {
    rules.status.findings.push({
      id: cycleId,
      detail: 'no cycle with this id in the runtime state',
    });
  }

  const ledger: TlAgentAction[] = await rt.raw.ledger.list({});
  const resultRefs = new Set(
    ledger.map((entry) => entry.result_ref).filter((ref): ref is string => typeof ref === 'string'),
  );
  /** `hold_ref`s the ledger says `availability.placeHold` actually returned. */
  const ledgeredHolds = new Set(
    ledger
      .filter(
        (entry) =>
          entry.port === 'availability' && entry.function === 'placeHold' && entry.result === 'ok',
      )
      .map((entry) => entry.result_ref)
      .filter((ref): ref is string => typeof ref === 'string'),
  );
  const calendarHolds = heldRefs(rt.config.dataDir);
  /** How many `channel.sendDirect ok` lines name each `message_ref`. Must be exactly one. */
  const sendsByRef = new Map<string, number>();
  for (const entry of ledger) {
    if (entry.port !== 'channel' || entry.function !== 'sendDirect' || entry.result !== 'ok') {
      continue;
    }
    if (typeof entry.result_ref !== 'string') continue;
    sendsByRef.set(entry.result_ref, (sendsByRef.get(entry.result_ref) ?? 0) + 1);
  }

  const workerCache = new Map<WorkerId, Worker | null>();
  const lookup = async (id: WorkerId): Promise<Worker | null> => {
    const cached = workerCache.get(id);
    if (cached !== undefined) return cached;
    const worker = await rt.raw.graph.lookupPerson(id);
    workerCache.set(id, worker);
    return worker;
  };

  for (const cycle of cycles) {
    const bundle = await readBundle(rt, cycle);

    // 6. cycle status
    rules.status.checked += 1;
    try {
      const canonical = canonicalState('cycle', cycle.status, rt.states);
      if (canonical !== cycle.status) {
        rules.status.findings.push({
          id: cycle.id,
          detail: `status "${cycle.status}" is an alias of "${canonical}"; state files store canonical states`,
        });
      }
    } catch (error) {
      rules.status.findings.push({
        id: cycle.id,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const submitted = submittedKeys(bundle.submissions);
    const nudgesByTask = new Map<string, TlNudge[]>();
    for (const nudge of bundle.nudges) {
      nudgesByTask.set(nudge.task_id, [...(nudgesByTask.get(nudge.task_id) ?? []), nudge]);
    }
    const cited = new Set<string>();
    for (const proposal of bundle.proposals) {
      if (proposal.kind !== 'escalate') continue;
      for (const ref of proposal.evidence_refs) cited.add(ref);
    }
    const filedScorecards = submittedScorecardKeys(bundle.scorecards);

    // 8. a held slot is really held: on the calendar, and in the ledger.
    for (const slot of bundle.slots) {
      if (slot.hold_ref === null) continue;
      rules.holds.checked += 1;
      if (!calendarHolds.has(slot.hold_ref)) {
        rules.holds.findings.push({
          id: slot.id,
          detail: `slot claims hold "${slot.hold_ref}" but no such line exists in ${HOLDS_FILENAME}`,
        });
      }
      if (!ledgeredHolds.has(slot.hold_ref)) {
        rules.holds.findings.push({
          id: slot.id,
          detail: `hold "${slot.hold_ref}" has no availability.placeHold ok entry in the ledger`,
        });
      }
    }

    // 11. the slot, its tasks and its scorecards name the same people
    for (const slot of bundle.slots) {
      if (slot.status === 'cancelled') continue;
      rules.panel.checked += 1;
      for (const finding of panelFindings(slot, bundle)) rules.panel.findings.push(finding);
    }

    for (const task of bundle.tasks) {
      // 1. done → submitted shadow record
      const kind = submissionKindOfTask(task.kind);
      if (kind !== null) {
        rules.submission.checked += 1;
        if (task.status === 'done') {
          const key = [
            task.cycle_id,
            task.external_ref ?? '',
            task.participant_worker_id,
            kind,
          ].join('|');
          if (!submitted.has(key)) {
            rules.submission.findings.push({
              id: task.id,
              detail: `task is done but no submitted tl_review_submission exists for ${task.participant_worker_id} → ${task.external_ref ?? '?'} (${kind})`,
            });
          }
        }
      }

      // 9. done scorecard task → the write-up actually exists, keyed to whoever now owes it
      if (task.kind === 'submit_scorecard') {
        rules.scorecards.checked += 1;
        const key = `${task.external_ref ?? ''}|${task.participant_worker_id}`;
        if (task.status === 'done' && !filedScorecards.has(key)) {
          rules.scorecards.findings.push({
            id: task.id,
            detail:
              'task is done but no submitted tl_scorecard exists for ' +
              `${task.participant_worker_id} on application ${task.external_ref ?? '?'}`,
          });
        }
      }

      // 2. attempts ↔ nudges ↔ ledger sends
      rules.nudges.checked += 1;
      const nudges = nudgesByTask.get(task.id) ?? [];
      if (task.attempt_n > nudges.length) {
        rules.nudges.findings.push({
          id: task.id,
          detail: `attempt_n ${task.attempt_n} but only ${nudges.length} tl_nudge record(s)`,
        });
      }
      for (const nudge of nudges) {
        if (!nudge.delivered) continue;
        if (nudge.message_ref === undefined) {
          rules.nudges.findings.push({
            id: nudge.id,
            detail: 'nudge is delivered but carries no message_ref',
          });
          continue;
        }
        // Several nudges share one `message_ref` when a bundled DM covered several tasks
        // (docs/DECISIONS.md D17) — but that one message must have been sent exactly once.
        const sends = sendsByRef.get(nudge.message_ref) ?? 0;
        if (sends !== 1) {
          rules.nudges.findings.push({
            id: nudge.id,
            detail:
              sends === 0
                ? `delivered nudge has no channel.sendDirect ok entry in the ledger (message_ref ${nudge.message_ref})`
                : `message_ref ${nudge.message_ref} was sent ${sends} times; one DM is one ledger line`,
          });
        }
      }

      // 3. escalated → cited by a proposal
      if (task.status === 'escalated') {
        rules.escalated.checked += 1;
        if (!cited.has(task.id)) {
          rules.escalated.findings.push({
            id: task.id,
            detail: 'task is escalated but no escalate proposal cites it as evidence',
          });
        }
      }

      // 5. references resolve
      rules.references.checked += 1;
      const participant = await lookup(task.participant_worker_id);
      if (participant === null) {
        rules.references.findings.push({
          id: task.id,
          detail: `participant_worker_id "${task.participant_worker_id}" is not a worker`,
        });
      }
      if (task.external_ref !== null && kind !== null) {
        const subject = await lookup(task.external_ref);
        if (subject === null) {
          rules.references.findings.push({
            id: task.id,
            detail: `external_ref "${task.external_ref}" is not a worker`,
          });
        }
      }
    }

    // 7. decisions
    for (const proposal of bundle.proposals) {
      if (proposal.status === 'proposed') continue;
      rules.decisions.checked += 1;
      if (proposal.decided_by === undefined || proposal.decided_at === undefined) {
        rules.decisions.findings.push({
          id: proposal.id,
          detail: `status ${proposal.status} but decided_by/decided_at are missing`,
        });
        continue;
      }
      const decider = await lookup(proposal.decided_by);
      if (decider === null || decider.status !== 'ACTIVE') {
        rules.decisions.findings.push({
          id: proposal.id,
          detail: `decided by "${proposal.decided_by}", who is ${decider === null ? 'not a worker' : decider.status}`,
        });
      }
    }

    // 4. every engine-written record has a ledger line
    const records: { id: string; kind: string }[] = [
      { id: cycle.id, kind: 'cycle' },
      ...bundle.tasks.map((task) => ({ id: task.id, kind: 'task' })),
      ...bundle.nudges.map((nudge) => ({ id: nudge.id, kind: 'nudge' })),
      ...bundle.proposals.map((proposal) => ({ id: proposal.id, kind: 'proposed_action' })),
      ...bundle.submissions.map((s) => ({ id: s.id, kind: 'review_submission' })),
      ...bundle.packets.map((packet) => ({ id: packet.id, kind: 'packet' })),
      ...bundle.slots.map((slot) => ({ id: slot.id, kind: 'interview_slot' })),
      ...bundle.scorecards.map((card) => ({ id: card.id, kind: 'scorecard' })),
    ];
    for (const record of records) {
      if (!ENGINE_ID_RE.test(record.id)) continue;
      rules.ledgered.checked += 1;
      if (!resultRefs.has(record.id)) {
        rules.ledgered.findings.push({
          id: record.id,
          detail: `${record.kind} exists in state but no ledger entry names it as result_ref`,
        });
      }
    }
  }

  // 10. Tier 1 owns the stage. Checked over the whole runtime state, not one cycle: the rule
  // is "the engine never holds a value the real object holds" (spec §3), and a shadow
  // pipeline would not politely confine itself to the cycle being verified.
  for (const kind of STATE_KINDS) {
    const records = (await rt.raw.state.list(kind)) as unknown as Record<string, unknown>[];
    for (const record of records) {
      rules.noStage.checked += 1;
      const where = stageKeyIn(record);
      if (where === null) continue;
      rules.noStage.findings.push({
        id: String(record['id'] ?? `${kind}:?`),
        detail: `tl_${kind} carries "${where}"; an application stage lives on the real record and is re-read, never stored`,
      });
    }
  }

  const list = Object.values(rules);
  return {
    ok: list.every((entry) => entry.findings.length === 0),
    cycle_ids: cycles.map((cycle) => cycle.id),
    rules: list,
    totals: {
      checked: list.reduce((sum, entry) => sum + entry.checked, 0),
      findings: list.reduce((sum, entry) => sum + entry.findings.length, 0),
    },
  };
}

function renderReport(report: VerifyReport): string[] {
  const lines = [
    `verify-loops: ${report.ok ? 'PASS' : 'FAIL'} — ` +
      `${report.totals.checked} check(s) over ${report.cycle_ids.length} cycle(s), ` +
      `${report.totals.findings} finding(s)`,
  ];
  for (const entry of report.rules) {
    const mark = entry.findings.length === 0 ? 'ok  ' : 'FAIL';
    lines.push(`  ${mark} ${entry.id.padEnd(28)} ${entry.checked} checked — ${entry.description}`);
    for (const finding of entry.findings.slice(0, 10)) {
      lines.push(`         ${finding.id}: ${finding.detail}`);
    }
    if (entry.findings.length > 10) {
      lines.push(`         … and ${entry.findings.length - 10} more`);
    }
  }
  return lines;
}

export async function runVerify(args: Args): Promise<CliOutput> {
  const cycleId = args.get('cycle');
  const { rt } = openRuntime();
  const report = await verifyLoops(rt, cycleId);
  const lines = renderReport(report);
  return report.ok ? ok(report, lines) : fail(report, lines);
}
