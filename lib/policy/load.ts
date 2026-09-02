/**
 * Tenant policy loader + validator (block B0.3).
 *
 * Owns: reading `tenant/policy.yml`, structurally validating it, and reporting every
 * problem at once. The engine and `bin/doctor.mjs` never parse policy YAML themselves.
 * Spec §5 (policy is data; doctor refuses to tick on a template), §7, §8; plan §2.6;
 * DECISIONS D3.
 *
 * Public interface:
 *   defaultPolicyPath(): string                    -- <repo>/tenant/policy.yml, or
 *                                                     $TL_TENANT_DIR/policy.yml when set
 *   loadPolicy(path?): TenantPolicy                -- throws PolicyError listing all errors
 *   validatePolicy(obj: unknown): { ok, errors }   -- hand-written, no schema dependency
 *   isTemplatePolicy(policy): boolean              -- true while `template: true`
 *   PolicyError                                    -- carries `errors` and `path`
 *   POLICY_FILENAME, POLICY_TEMPLATE_FILENAME
 *
 * Validation is deliberately strict about unknown keys: a typo'd section
 * (`cadance:`) silently changing engine behaviour is the failure mode this guards.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CHANNEL_KINDS, ESCALATION_TARGETS, POLICY_TOP_LEVEL_KEYS } from '#lib/policy/schema.ts';
import type { TenantPolicy } from '#lib/policy/schema.ts';

export const POLICY_FILENAME = 'policy.yml';
export const POLICY_TEMPLATE_FILENAME = 'policy.template.yml';

/** Thrown by `loadPolicy`; `errors` holds every validation message, not just the first. */
export class PolicyError extends Error {
  readonly errors: string[];
  readonly path: string | undefined;

  constructor(message: string, errors: string[] = [], filePath?: string) {
    super(message);
    this.name = 'PolicyError';
    this.errors = errors;
    this.path = filePath;
  }
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Where the tenant policy lives. `TL_TENANT_DIR` (read on every call, so tests and
 * `bin/*` can point at a temp tenant) overrides the repo's own `tenant/` directory.
 */
export function defaultPolicyPath(): string {
  const override = process.env.TL_TENANT_DIR;
  const dir =
    override && override.trim() !== '' ? path.resolve(override) : path.join(repoRoot(), 'tenant');
  return path.join(dir, POLICY_FILENAME);
}

/* ---------------------------------------------------------------- validation */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface NumberBound {
  min?: number;
  exclusiveMin?: number;
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(`unknown ${what}: '${key}' (allowed: ${allowed.join(', ')})`);
    }
  }
}

function checkBoolean(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  errors: string[],
): void {
  const value = obj[key];
  if (value === undefined) {
    errors.push(`${prefix}${key} is required`);
  } else if (typeof value !== 'boolean') {
    errors.push(`${prefix}${key} must be a boolean (got ${describe(value)})`);
  }
}

function checkNumber(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  bound: NumberBound,
  errors: string[],
): number | null {
  const value = obj[key];
  if (value === undefined) {
    errors.push(`${prefix}${key} is required`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${prefix}${key} must be a finite number (got ${describe(value)})`);
    return null;
  }
  if (bound.min !== undefined && value < bound.min) {
    errors.push(`${prefix}${key} must be >= ${bound.min} (got ${value})`);
    return null;
  }
  if (bound.exclusiveMin !== undefined && value <= bound.exclusiveMin) {
    errors.push(`${prefix}${key} must be > ${bound.exclusiveMin} (got ${value})`);
    return null;
  }
  return value;
}

function checkString(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  errors: string[],
): string | null {
  const value = obj[key];
  if (value === undefined) {
    errors.push(`${prefix}${key} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${prefix}${key} must be a non-empty string (got ${describe(value)})`);
    return null;
  }
  return value;
}

function checkEnum(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  allowed: readonly string[],
  errors: string[],
): void {
  const value = obj[key];
  if (value === undefined) {
    errors.push(`${prefix}${key} is required`);
    return;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(`${prefix}${key} must be one of ${allowed.join(' | ')} (got ${describe(value)})`);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}

/** Pull a required object section; records a named error and returns null when absent/wrong. */
function section(
  root: Record<string, unknown>,
  name: string,
  allowed: readonly string[],
  errors: string[],
): Record<string, unknown> | null {
  const value = root[name];
  if (value === undefined) {
    errors.push(`missing required section: '${name}'`);
    return null;
  }
  if (!isRecord(value)) {
    errors.push(`section '${name}' must be a mapping (got ${describe(value)})`);
    return null;
  }
  checkUnknownKeys(value, allowed, `key in section '${name}'`, errors);
  return value;
}

/**
 * Structural validation of a parsed policy document. Collects every problem rather
 * than throwing on the first, so `doctor` can show a tenant the whole list.
 */
export function validatePolicy(obj: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(obj)) {
    return { ok: false, errors: [`policy must be a mapping (got ${describe(obj)})`] };
  }

  checkUnknownKeys(obj, POLICY_TOP_LEVEL_KEYS, 'top-level key', errors);
  checkBoolean(obj, '', 'template', errors);

  const tenant = section(obj, 'tenant', ['name', 'acting_identity_default'], errors);
  if (tenant) {
    checkString(tenant, 'tenant.', 'name', errors);
    checkString(tenant, 'tenant.', 'acting_identity_default', errors);
  }

  const cadence = section(
    obj,
    'cadence',
    ['tick_interval_hours', 'nudge_min_gap_hours', 'max_attempts'],
    errors,
  );
  if (cadence) {
    checkNumber(cadence, 'cadence.', 'tick_interval_hours', { exclusiveMin: 0 }, errors);
    checkNumber(cadence, 'cadence.', 'nudge_min_gap_hours', { min: 0 }, errors);
    checkNumber(cadence, 'cadence.', 'max_attempts', { min: 1 }, errors);
  }

  const quiet = section(
    obj,
    'quiet_hours',
    ['respect_location_hours', 'weekends', 'holidays'],
    errors,
  );
  if (quiet) {
    checkBoolean(quiet, 'quiet_hours.', 'respect_location_hours', errors);
    checkBoolean(quiet, 'quiet_hours.', 'weekends', errors);
    checkBoolean(quiet, 'quiet_hours.', 'holidays', errors);
  }

  const channels = section(
    obj,
    'channels',
    ['nudge', 'escalation', 'summary', 'summary_channel'],
    errors,
  );
  if (channels) {
    checkEnum(channels, 'channels.', 'nudge', CHANNEL_KINDS, errors);
    checkEnum(channels, 'channels.', 'escalation', CHANNEL_KINDS, errors);
    checkEnum(channels, 'channels.', 'summary', CHANNEL_KINDS, errors);
    const summaryChannel = checkString(channels, 'channels.', 'summary_channel', errors);
    if (summaryChannel !== null && !summaryChannel.startsWith('#')) {
      errors.push(`channels.summary_channel must start with '#' (got '${summaryChannel}')`);
    }
  }

  const escalation = section(
    obj,
    'escalation',
    ['overdue_days', 'after_attempts', 'escalate_to'],
    errors,
  );
  if (escalation) {
    checkNumber(escalation, 'escalation.', 'overdue_days', { min: 0 }, errors);
    checkNumber(escalation, 'escalation.', 'after_attempts', { min: 0 }, errors);
    checkEnum(escalation, 'escalation.', 'escalate_to', ESCALATION_TARGETS, errors);
  }

  const absence = section(
    obj,
    'absence',
    ['move_due_date_days_after_return', 'skip_nudge'],
    errors,
  );
  if (absence) {
    checkNumber(absence, 'absence.', 'move_due_date_days_after_return', { min: 0 }, errors);
    checkBoolean(absence, 'absence.', 'skip_nudge', errors);
  }

  validateReviewCycle(obj, errors);

  const interview = section(
    obj,
    'interview_loop',
    ['panel_size', 'scorecard_due_hours', 'substitute_same_level'],
    errors,
  );
  if (interview) {
    checkNumber(interview, 'interview_loop.', 'panel_size', { min: 1 }, errors);
    checkNumber(interview, 'interview_loop.', 'scorecard_due_hours', { exclusiveMin: 0 }, errors);
    checkBoolean(interview, 'interview_loop.', 'substitute_same_level', errors);
  }

  return { ok: errors.length === 0, errors };
}

function validateReviewCycle(root: Record<string, unknown>, errors: string[]): void {
  const reviewCycle = section(root, 'review_cycle', ['stagger_days', 'peers_per_subject'], errors);
  if (!reviewCycle) return;

  checkNumber(reviewCycle, 'review_cycle.', 'peers_per_subject', { min: 1 }, errors);

  const stagger = section(reviewCycle, 'stagger_days', ['self', 'peer', 'manager'], errors);
  if (!stagger) {
    // `section` reports it as 'missing required section: stagger_days'; make the path clear.
    return;
  }
  const prefix = 'review_cycle.stagger_days.';
  const self = checkNumber(stagger, prefix, 'self', { min: 0 }, errors);
  const peer = checkNumber(stagger, prefix, 'peer', { min: 0 }, errors);
  const manager = checkNumber(stagger, prefix, 'manager', { min: 0 }, errors);

  if (self !== null && peer !== null && self > peer) {
    errors.push(`${prefix}self (${self}) must be <= ${prefix}peer (${peer})`);
  }
  if (peer !== null && manager !== null && peer > manager) {
    errors.push(`${prefix}peer (${peer}) must be <= ${prefix}manager (${manager})`);
  }
}

/* -------------------------------------------------------------------- loading */

/**
 * Read and validate a tenant policy. Defaults to `defaultPolicyPath()`.
 * Throws `PolicyError` (with every validation message in `errors`) rather than
 * returning a half-valid policy — the engine must never run on guessed cadence.
 */
export function loadPolicy(policyPath: string = defaultPolicyPath()): TenantPolicy {
  let text: string;
  try {
    text = readFileSync(policyPath, 'utf8');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyError(`cannot read tenant policy at ${policyPath}: ${detail}`, [], policyPath);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyError(
      `tenant policy at ${policyPath} is not valid YAML: ${detail}`,
      [],
      policyPath,
    );
  }

  const { ok, errors } = validatePolicy(parsed);
  if (!ok) {
    throw new PolicyError(
      `invalid tenant policy at ${policyPath}:\n  - ${errors.join('\n  - ')}`,
      errors,
      policyPath,
    );
  }

  return parsed as TenantPolicy;
}

/** True while the policy is the shipped template; `doctor` fails the run on it. */
export function isTemplatePolicy(policy: TenantPolicy): boolean {
  return policy.template === true;
}
