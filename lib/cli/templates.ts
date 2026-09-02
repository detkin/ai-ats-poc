/**
 * lib/cli/templates.ts — nudge and escalation text, from files with facts injected.
 *
 * Owns: the renderer for `templates/nudges/<template_id>.md`. There is **no LLM call on the
 * tick path** (docs/DECISIONS.md D7): a template is markdown with `{{placeholder}}` slots and
 * the executor fills them from records it already read. That is what makes a tick
 * reproducible, cheap, and safe to run on a schedule.
 *
 * Template ids come from the engine — `nudgeTemplateId(kind, attemptN)` yields
 * `nudge.<task_kind>.<first|followup>` — so a new task kind needs a new file, not new code.
 * `escalation` is the one non-nudge template: the DM that tells the escalation recipient a
 * `tl_proposed_action` is waiting for them.
 *
 * Public interface: `NUDGE_TEMPLATE_DIR`, `ESCALATION_TEMPLATE_ID`, `templatePath`,
 * `renderTemplate`, `nudgeFacts`, `escalationFacts`, `TemplateFacts`.
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
import type { TlCycle, TlTask } from '#lib/types/engine.ts';
import type { Worker } from '#lib/types/tier1.ts';

/** Where the templates live, relative to the repo root. */
export const NUDGE_TEMPLATE_DIR = join('templates', 'nudges');
/** The template used for the escalation DM that accompanies an `escalate` proposal. */
export const ESCALATION_TEMPLATE_ID = 'escalation';

/** Facts a template may reference. Every value is a string; missing keys are errors. */
export type TemplateFacts = Record<string, string>;

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Absolute path of a template file. */
export function templatePath(config: Config, templateId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(templateId)) {
    throw new CliError('BAD_TEMPLATE_ID', `"${templateId}" is not a usable template id`);
  }
  return join(config.repoRoot, NUDGE_TEMPLATE_DIR, `${templateId}.md`);
}

/**
 * Read `templates/nudges/<id>.md` and substitute every `{{placeholder}}`.
 * @throws CliError when the file is missing or a placeholder has no fact.
 */
export function renderTemplate(config: Config, templateId: string, facts: TemplateFacts): string {
  const path = templatePath(config, templateId);
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

/**
 * The facts every nudge template may use. `subject_name` is the person the review is
 * *about* (`tl_task.external_ref`); for a self review that is the recipient.
 */
export function nudgeFacts(input: {
  task: TlTask;
  cycle: TlCycle;
  recipient: Worker | undefined;
  subject: Worker | undefined;
  attemptN: number;
  maxAttempts: number;
}): TemplateFacts {
  return {
    first_name: callName(input.recipient, input.task.participant_worker_id),
    subject_name: fullName(input.subject, input.task.external_ref ?? 'the subject'),
    due_date: dateOf(input.task.due_at),
    original_due_date: dateOf(input.task.original_due_at),
    attempt_n: String(input.attemptN),
    max_attempts: String(input.maxAttempts),
    cycle_name: input.cycle.name,
    cycle_deadline: dateOf(input.cycle.deadline),
    task_id: input.task.id,
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
