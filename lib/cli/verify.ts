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
 *     records, and every delivered one names a message the ledger recorded
 *     (`channel.sendDirect`, `result: ok`, that `message_ref` as `result_ref`).
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
 * Everything is read through `rt.raw` — verifying must not itself write ledger lines, or the
 * second run would have a different ledger to verify than the first.
 *
 * Public interface: `VERIFY_SPEC`, `runVerify`, `verifyLoops`, `VerifyReport`, `RuleResult`,
 * `ENGINE_ID_RE`.
 *
 * Spec: docs/SPEC.md §5, §9, §10; docs/PLAN.md §2.9, §4 block B1.3.
 */

import type { Runtime } from '#lib/adapters/index.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { fail, ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { openRuntime } from '#lib/cli/runtime.ts';
import { submissionKindOfTask } from '#lib/engine/index.ts';
import { canonicalState } from '#lib/states/index.ts';
import type {
  TlAgentAction,
  TlCycle,
  TlNudge,
  TlPacket,
  TlProposedAction,
  TlReviewSubmission,
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
}

function rule(id: string, description: string): RuleResult {
  return { id, description, checked: 0, findings: [] };
}

/** Every state record for one cycle, read unledgered. */
async function readBundle(rt: Runtime, cycle: TlCycle): Promise<CycleBundle> {
  const filter = { cycle_id: cycle.id } as const;
  return {
    cycle,
    tasks: await rt.raw.state.list('task', filter),
    nudges: await rt.raw.state.list('nudge', filter),
    proposals: await rt.raw.state.list('proposed_action', filter),
    submissions: await rt.raw.state.list('review_submission', filter),
    packets: await rt.raw.state.list('packet', filter),
  };
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
  const sentRefs = new Set(
    ledger
      .filter(
        (entry) =>
          entry.port === 'channel' && entry.function === 'sendDirect' && entry.result === 'ok',
      )
      .map((entry) => entry.result_ref)
      .filter((ref): ref is string => typeof ref === 'string'),
  );

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
        if (nudge.message_ref === undefined || !sentRefs.has(nudge.message_ref)) {
          rules.nudges.findings.push({
            id: nudge.id,
            detail: `delivered nudge has no channel.sendDirect ok entry in the ledger (message_ref ${nudge.message_ref ?? 'missing'})`,
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
