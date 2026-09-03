/**
 * lib/cli/templates.ts — nudge and escalation text, from files with facts injected.
 *
 * Owns: the renderer for `templates/nudges/<template_id>.md`. There is **no LLM call on the
 * tick path** (docs/DECISIONS.md D7): a template is markdown with `{{placeholder}}` slots and
 * the executor fills them from records it already read. That is what makes a tick
 * reproducible, cheap, and safe to run on a schedule.
 *
 * Template ids come from the engine — `bundleTemplateId(kinds, attemptN)` yields
 * `nudge.<task_kind>.<first|followup>` when a bundled DM covers one kind of task and
 * `nudge.multi.<first|followup>` when it covers several — so a new task kind needs a new
 * file, not new code.
 * `escalation` is the one non-nudge template: the DM that tells the escalation recipient a
 * `tl_proposed_action` is waiting for them.
 *
 * Two more non-nudge templates live under `templates/packets/` (block B2.2) because they are
 * loop-2 *artefacts* rather than reminders: `interviewer_brief` is the DM each panellist gets
 * when the hold is placed — and, because it is sent on the hold's thread, it is also the
 * thread an interviewer replies to in order to decline or to file a scorecard — and
 * `panel_change` is the message posted to the summary channel when somebody is swapped out.
 * `renderTemplate` takes the directory, so a template id can never reach outside these two.
 *
 * Public interface: `NUDGE_TEMPLATE_DIR`, `PACKET_TEMPLATE_DIR`, `ESCALATION_TEMPLATE_ID`,
 * `INTERVIEWER_BRIEF_TEMPLATE_ID`, `PANEL_CHANGE_TEMPLATE_ID`, `templatePath`,
 * `renderTemplate`, `nudgeFacts`, `escalationFacts`, `interviewerBriefFacts`,
 * `panelChangeFacts`, `TemplateFacts`, `NudgeFactTask`.
 *
 * An unresolved `{{placeholder}}` is an error, never an empty string: a nudge that says
 * "Hi ," has already failed, and failing loudly in the executor is cheaper than in a DM.
 *
 * Spec: docs/SPEC.md §7 ("nudge tone from templates, facts injected"), §9;
 * docs/PLAN.md §4 block B1.3.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError } from '#lib/cli/runtime.ts';
import type { Config } from '#lib/config.ts';
import { dateOf } from '#lib/engine/index.ts';
import type { TlCycle, TlTask, TlTaskKind } from '#lib/types/engine.ts';
import type { Worker } from '#lib/types/tier1.ts';

/** Where the nudge templates live, relative to the repo root. */
export const NUDGE_TEMPLATE_DIR = join('templates', 'nudges');
/** Where loop 2's non-nudge message templates live, relative to the repo root. */
export const PACKET_TEMPLATE_DIR = join('templates', 'packets');
/** The template used for the escalation DM that accompanies an `escalate` proposal. */
export const ESCALATION_TEMPLATE_ID = 'escalation';
/** The DM each panellist gets when the hold is placed; also opens the reply thread. */
export const INTERVIEWER_BRIEF_TEMPLATE_ID = 'interviewer_brief';
/** The summary-channel post that announces a substitute interviewer. */
export const PANEL_CHANGE_TEMPLATE_ID = 'panel_change';

/** Facts a template may reference. Every value is a string; missing keys are errors. */
export type TemplateFacts = Record<string, string>;

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Absolute path of a template file, under `dir` (a repo-relative template directory). */
export function templatePath(
  config: Config,
  templateId: string,
  dir: string = NUDGE_TEMPLATE_DIR,
): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(templateId)) {
    throw new CliError('BAD_TEMPLATE_ID', `"${templateId}" is not a usable template id`);
  }
  return join(config.repoRoot, dir, `${templateId}.md`);
}

/**
 * Read `<dir>/<id>.md` (default `templates/nudges/`) and substitute every `{{placeholder}}`.
 * @throws CliError when the file is missing or a placeholder has no fact.
 */
export function renderTemplate(
  config: Config,
  templateId: string,
  facts: TemplateFacts,
  dir: string = NUDGE_TEMPLATE_DIR,
): string {
  const path = templatePath(config, templateId, dir);
  if (!existsSync(path)) {
    throw new CliError(
      'TEMPLATE_NOT_FOUND',
      `no message template at ${path}. Add it, or pass --template <id> with one that exists.`,
    );
  }
  const source = readFileSync(path, 'utf8');
  const missing: string[] = [];
  const rendered = source.replace(PLACEHOLDER, (_match, name: string) => {
    const value = facts[name];
    if (value === undefined) {
      missing.push(name);
      return '';
    }
    return value;
  });
  if (missing.length > 0) {
    throw new CliError(
      'TEMPLATE_PLACEHOLDER_MISSING',
      `template "${templateId}" wants {{${[...new Set(missing)].join('}}, {{')}}}, ` +
        `which this call has no value for.`,
    );
  }
  return rendered.trim();
}

/** Preferred name if the worker has one, else the first name. */
function callName(worker: Worker | undefined, fallback: string): string {
  if (worker === undefined) return fallback;
  return worker.preferred_name ?? worker.first_name;
}

function fullName(worker: Worker | undefined, fallback: string): string {
  if (worker === undefined) return fallback;
  return `${worker.first_name} ${worker.last_name}`;
}

/** How a task kind reads in a reminder's bullet list. */
const TASK_LABELS: Readonly<Record<TlTaskKind, string>> = {
  write_self_review: 'self review',
  write_peer_review: 'peer review',
  write_manager_review: 'manager review',
  submit_scorecard: 'interview scorecard',
  approve_req: 'requisition approval',
  enter_comp: 'compensation entry',
  attend_interview: 'interview',
};

/** One task of a bundled reminder: the record, and the person it is about. */
export interface NudgeFactTask {
  task: TlTask;
  /** The review subject (`task.external_ref`), when it resolves to a worker. */
  subject: Worker | undefined;
}

/** `- peer review of Ada Lovelace — due 2026-08-31`, one line per bundled task. */
function taskList(tasks: readonly NudgeFactTask[], recipientId: string): string {
  return tasks
    .map((entry) => {
      const label = TASK_LABELS[entry.task.kind];
      const about =
        entry.task.external_ref === null || entry.task.external_ref === recipientId
          ? ''
          : ` of ${fullName(entry.subject, entry.task.external_ref)}`;
      return `- ${label}${about} — due ${dateOf(entry.task.due_at)}`;
    })
    .join('\n');
}

/** The earliest instant among the bundled tasks, by the given field. */
function earliest(tasks: readonly NudgeFactTask[], pick: (task: TlTask) => string): string {
  return tasks.map((entry) => pick(entry.task)).sort()[0] ?? '';
}

/**
 * The facts every nudge template may use. One DM covers every task one person owes this
 * tick (docs/DECISIONS.md D17), so the bundle-shaped facts are the ones templates should
 * reach for: `{{task_list}}` (markdown bullets: kind, subject, due date) and
 * `{{task_count}}`. The scalar facts describe the bundle as a whole — `subject_name` is
 * every subject joined, `due_date` and `original_due_date` are the earliest in the bundle,
 * `task_id` is every bundled id joined — so a one-task bundle reads exactly as before.
 */
export function nudgeFacts(input: {
  tasks: readonly NudgeFactTask[];
  cycle: TlCycle;
  toWorkerId: string;
  recipient: Worker | undefined;
  attemptN: number;
  maxAttempts: number;
}): TemplateFacts {
  const { tasks } = input;
  if (tasks.length === 0) {
    throw new CliError('EMPTY_NUDGE_BUNDLE', 'a nudge must cover at least one task');
  }
  const subjects = [
    ...new Set(
      tasks
        .filter((entry) => entry.task.external_ref !== input.toWorkerId)
        .map((entry) => fullName(entry.subject, entry.task.external_ref ?? 'the subject')),
    ),
  ];

  return {
    first_name: callName(input.recipient, input.toWorkerId),
    subject_name: subjects.length === 0 ? 'you' : subjects.join(', '),
    due_date: dateOf(earliest(tasks, (task) => task.due_at)),
    original_due_date: dateOf(earliest(tasks, (task) => task.original_due_at)),
    attempt_n: String(input.attemptN),
    max_attempts: String(input.maxAttempts),
    cycle_name: input.cycle.name,
    cycle_deadline: dateOf(input.cycle.deadline),
    task_id: tasks.map((entry) => entry.task.id).join(', '),
    task_count: String(tasks.length),
    task_list: taskList(tasks, input.toWorkerId),
  };
}

/**
 * The facts the interviewer brief uses. Everything here is a **record id, a time or the
 * requisition's own words** — the candidate is never named, never described and never
 * scored, because a brief that characterised them would be the engine forming a view
 * (spec §9). The panel is listed by worker id for the same reason attribution matters in
 * the debrief: the reader needs to know who else is in the room.
 */
export function interviewerBriefFacts(input: {
  recipient: Worker | undefined;
  toWorkerId: string;
  cycle: TlCycle;
  applicationId: string;
  requisitionId: string;
  reqTitle: string;
  criteria: readonly string[];
  panelIds: readonly string[];
  startAt: string;
  endAt: string;
  scorecardDueAt: string;
  holdRef: string;
  summaryChannel: string;
}): TemplateFacts {
  return {
    first_name: callName(input.recipient, input.toWorkerId),
    cycle_name: input.cycle.name,
    cycle_id: input.cycle.id,
    application_id: input.applicationId,
    requisition_id: input.requisitionId,
    req_title: input.reqTitle,
    criteria_list:
      input.criteria.length === 0
        ? '- (the requisition lists no criteria)'
        : input.criteria.map((criterion) => `- ${criterion}`).join('\n'),
    panel_list: input.panelIds.map((id) => `\`${id}\``).join(', '),
    start_at: input.startAt,
    end_at: input.endAt,
    scorecard_due: input.scorecardDueAt,
    hold_ref: input.holdRef,
    summary_channel: input.summaryChannel,
  };
}

/**
 * The facts the panel-change post uses. `summary` is the engine's own sentence, carried
 * through unchanged; the template only frames it. Evidence is ids, never prose.
 */
export function panelChangeFacts(input: {
  cycle: TlCycle;
  applicationId: string;
  summary: string;
  evidenceRefs: readonly string[];
  channel: string;
}): TemplateFacts {
  return {
    cycle_name: input.cycle.name,
    cycle_id: input.cycle.id,
    application_id: input.applicationId,
    summary: input.summary,
    evidence: input.evidenceRefs.map((ref) => `\`${ref}\``).join(', '),
    channel: input.channel,
  };
}

/** The facts the escalation DM uses. Counts and ids only — never a name-and-shame list. */
export function escalationFacts(input: {
  cycle: TlCycle;
  recipient: Worker | undefined;
  proposalId: string;
  taskCount: number;
  evidenceCount: number;
  worstOverdueDays: number;
}): TemplateFacts {
  return {
    first_name: callName(input.recipient, input.cycle.owner_worker_id),
    cycle_name: input.cycle.name,
    cycle_id: input.cycle.id,
    cycle_deadline: dateOf(input.cycle.deadline),
    proposal_id: input.proposalId,
    task_count: String(input.taskCount),
    evidence_count: String(input.evidenceCount),
    worst_overdue_days: String(input.worstOverdueDays),
  };
}
