/**
 * lib/adapters/bridge/snapshot.ts — the JSON an agent hands the bridge (block B2.6).
 *
 * Owns: `BridgeSnapshot`, the *raw* shape of what the agent saved after running the
 * `codemode.*` reads `bin/bridge.mjs fetch-plan` prints, plus `validateSnapshot`, which says
 * whether that file can be mapped at all. Nothing here interprets a record: every field
 * mirrors the Rippling MCP response verbatim (docs/testing/live-rippling.md, "What was run"),
 * so a future shape change shows up as a validation error and not as a silent mis-map.
 *
 * Why a file and not a call: the Rippling MCP's OAuth token lives in the Claude client, so
 * `bin/*.mjs` cannot reach it (docs/DECISIONS.md D25). The agent fetches; the scripts
 * validate, map and ledger what it fetched.
 *
 * Public interface: `BridgeSnapshot` and its member record types, `SNAPSHOT_FILENAME`,
 * `READ_FUNCTIONS`, `validateSnapshot`, `SnapshotValidation`, `BridgeSnapshotInvalidError`.
 *
 * Spec: docs/PLAN.md §8; docs/DECISIONS.md D25–D27; docs/testing/live-rippling.md.
 */

import { TalentLoopsError } from '#lib/safety/errors.ts';

/** Conventional name of the saved snapshot, under `TL_DATA_DIR/bridge/`. */
export const SNAPSHOT_FILENAME = 'snapshot.json';

/**
 * The six `codemode.*` read functions a snapshot is built from, in call order.
 * `search_teams` is a seventh, optional read: the live tenant has zero teams.
 */
export const READ_FUNCTIONS = [
  'lookup_me',
  'search_departments',
  'search_work_locations',
  'search_leave_types',
  'lookup_direct_reports',
  'lookup_person',
  'lookup_absence',
] as const;

/* ------------------------------------------------------------- record shapes */

/** `person.department` — the id/name pair carried on a profile. */
export interface McpDepartmentRef {
  id: string;
  name?: string;
  reference_code?: string | null;
}

export interface McpManagerRef {
  id: string;
  display_name?: string;
  work_email?: string;
}

export interface McpAddress {
  type?: string;
  formatted?: string;
  street_address?: string | null;
  locality?: string | null;
  region?: string | null;
  postal_code?: string | null;
  /** ISO-3166 alpha-2 on the live tenant (`US`, `DE`, `LT`). */
  country?: string | null;
}

export interface McpLocationRef {
  id: string;
  name?: string;
  type?: string;
  address?: McpAddress | null;
}

export interface McpEmploymentType {
  id?: string;
  /** `EMPLOYEE`, `CONTRACTOR`, … */
  type?: string;
  label?: string;
  name?: string;
}

export interface McpLevelRef {
  id?: string;
  name?: string;
  rank?: number;
  track?: string;
}

/** `lookup_me` / `lookup_person`. Only the fields the mapper reads are named. */
export interface McpPerson {
  id: string;
  rippling_url?: string;
  work_email?: string | null;
  display_name?: string;
  given_name?: string | null;
  middle_name?: string | null;
  family_name?: string | null;
  preferred_given_name?: string | null;
  preferred_family_name?: string | null;
  title?: string | null;
  /** `ACTIVE`, `TERMINATED`, `PENDING`, … */
  status?: string;
  start_date?: string | null;
  end_date?: string | null;
  country?: string | null;
  employee_number?: string | null;
  permanent_profile_number?: string | null;
  is_manager?: boolean;
  timezone?: string | null;
  employment_type?: McpEmploymentType | null;
  manager?: McpManagerRef | null;
  department?: McpDepartmentRef | null;
  location?: McpLocationRef | null;
  legal_entity?: { id?: string; legal_name?: string; country?: string } | null;
  teams?: { id: string; name?: string }[] | null;
  level?: McpLevelRef | null;
  business_partners?: unknown[];
  redacted_fields?: string[];
  company_id?: string;
}

/** The common `search_*` envelope. */
export interface McpSearchEnvelope<T> {
  query?: string;
  total_matches?: number;
  total_matches_partial?: boolean;
  truncated?: boolean;
  results: T[];
}

export interface McpDepartment {
  id: string;
  name: string;
  parent_id?: string | null;
  parent_name?: string | null;
  reference_code?: string | null;
  department_hierarchy_id?: string[];
  redacted_fields?: string[];
}

/** `search_work_locations`: an address and nothing else — no timezone, no hours (D27). */
export interface McpWorkLocation {
  id: string;
  name: string;
  address?: McpAddress | null;
  redacted_fields?: string[];
}

export interface McpLeaveType {
  id: string;
  name: string;
  /** `VACATION | SICK | CUSTOM | WFH | UNPAID | …` */
  type?: string;
  description?: string | null;
  is_paid?: boolean;
  is_managed_by_external_system?: boolean;
}

export interface McpTeam {
  id: string;
  name: string;
  parent_id?: string | null;
  reference_code?: string | null;
}

export interface McpDirectReportRow {
  id: string;
  rippling_url?: string;
  display_name?: string;
  status?: string;
  title?: string | null;
  redacted_fields?: string[];
}

export interface McpDirectReports {
  manager_id: string;
  rippling_url?: string;
  total_direct_reports?: number;
  direct_reports: McpDirectReportRow[];
}

/**
 * `lookup_absence` — **present tense only** (D27). There is no date argument and no list of
 * upcoming leave; `current_leave`'s shape was unverified on the live smoke (nobody was away),
 * so every field on it is optional and the mapper defaults rather than assumes.
 */
export interface McpCurrentLeave {
  id?: string;
  leave_type_id?: string | null;
  leave_type_name?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  status?: string | null;
}

export interface McpAbsence {
  worker_id: string;
  display_name?: string;
  is_on_leave: boolean;
  current_leave?: McpCurrentLeave | null;
  rippling_url?: string;
  redacted_fields?: string[];
}

export interface McpBalanceRow {
  id?: string;
  leave_type_id?: string;
  leave_type_name?: string;
  is_balance_unlimited?: boolean;
  balance_including_future_requests_hours?: number;
  balance_excluding_future_requests_hours?: number;
}

export interface McpTimeOffBalance {
  worker_id: string;
  balances: McpBalanceRow[];
}

/** One `codemode.*` call the agent made, for the provenance record. */
export interface BridgeCall {
  fn: string;
  args_summary: string;
  ok: boolean;
}

/** Everything the agent fetched, saved verbatim. */
export interface BridgeSnapshot {
  /** ISO instant the agent finished fetching. */
  fetched_at: string;
  /** `codemode.lookup_me` — the acting user. */
  actor: McpPerson;
  departments: McpSearchEnvelope<McpDepartment>;
  locations: McpSearchEnvelope<McpWorkLocation>;
  leave_types: McpSearchEnvelope<McpLeaveType>;
  /** `search_teams`; zero results on the live tenant, so the key may be absent. */
  teams?: McpSearchEnvelope<McpTeam>;
  /** One `lookup_person` per worker found by the org walk. Includes the actor. */
  people: McpPerson[];
  /** `lookup_direct_reports`, keyed by manager id. */
  direct_reports: Record<string, McpDirectReports>;
  /** `lookup_absence`, keyed by worker id. */
  absences: Record<string, McpAbsence>;
  /** `lookup_time_off_balance`, keyed by worker id. Optional: nothing maps from it yet. */
  balances?: Record<string, McpTimeOffBalance>;
  calls: BridgeCall[];
}

/* ------------------------------------------------------------- validation */

export interface SnapshotValidation {
  ok: boolean;
  errors: string[];
}

/** The snapshot file is missing, unparseable or structurally wrong. */
export class BridgeSnapshotInvalidError extends TalentLoopsError {
  readonly errors: string[];
  readonly path: string;

  constructor(path: string, errors: string[]) {
    super(
      'BRIDGE_SNAPSHOT_INVALID',
      `bridge snapshot at ${path} cannot be mapped (${errors.length} problem${
        errors.length === 1 ? '' : 's'
      }):\n${errors.map((e) => `  - ${e}`).join('\n')}\n` +
        'Re-run the calls printed by: node bin/bridge.mjs fetch-plan',
    );
    this.name = 'BridgeSnapshotInvalidError';
    this.errors = errors;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** `{ results: [...] }`, the shape every `search_*` returns. */
function checkEnvelope(
  root: Record<string, unknown>,
  key: string,
  required: boolean,
  errors: string[],
): Record<string, unknown>[] {
  const value = root[key];
  if (value === undefined || value === null) {
    if (required) errors.push(`${key}: missing (run codemode.search_${key} and save its result)`);
    return [];
  }
  if (!isRecord(value)) {
    errors.push(`${key}: must be the whole search result object, not ${typeof value}`);
    return [];
  }
  const results = value.results;
  if (!Array.isArray(results)) {
    errors.push(`${key}.results: expected an array`);
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  results.forEach((row, index) => {
    if (!isRecord(row)) {
      errors.push(`${key}.results[${index}]: expected an object`);
      return;
    }
    if (typeof row.id !== 'string' || row.id.length === 0) {
      errors.push(`${key}.results[${index}]: has no string id`);
      return;
    }
    rows.push(row);
  });
  return rows;
}

/**
 * Structurally validate a parsed snapshot, collecting every problem rather than the first.
 * This is not a schema check of the whole MCP surface: it asserts the parts the mapper reads
 * and the internal consistency it cannot repair (a person whose department is not listed).
 */
export function validateSnapshot(parsed: unknown): SnapshotValidation {
  const errors: string[] = [];
  if (!isRecord(parsed)) {
    return { ok: false, errors: ['the snapshot must be a JSON object'] };
  }

  const fetchedAt = parsed.fetched_at;
  if (typeof fetchedAt !== 'string' || !ISO_INSTANT.test(fetchedAt)) {
    errors.push(`fetched_at: expected an ISO instant (got ${JSON.stringify(fetchedAt)})`);
  }

  const actor = parsed.actor;
  if (!isRecord(actor) || typeof actor.id !== 'string' || actor.id.length === 0) {
    errors.push('actor: expected the codemode.lookup_me result, with a string id');
  }

  const departments = checkEnvelope(parsed, 'departments', true, errors);
  checkEnvelope(parsed, 'locations', true, errors);
  checkEnvelope(parsed, 'leave_types', true, errors);
  checkEnvelope(parsed, 'teams', false, errors);

  const people = parsed.people;
  const peopleIds = new Set<string>();
  if (!Array.isArray(people)) {
    errors.push('people: expected an array of codemode.lookup_person results');
  } else {
    if (people.length === 0) errors.push('people: the org walk found nobody');
    people.forEach((person, index) => {
      if (!isRecord(person) || typeof person.id !== 'string' || person.id.length === 0) {
        errors.push(`people[${index}]: expected a person object with a string id`);
        return;
      }
      if (peopleIds.has(person.id)) errors.push(`people: duplicate id "${person.id}"`);
      peopleIds.add(person.id);
    });
    if (isRecord(actor) && typeof actor.id === 'string' && !peopleIds.has(actor.id)) {
      errors.push(
        `people: the acting user "${actor.id}" is not in the list — the org walk must ` +
          'include the person it started from',
      );
    }
  }

  const departmentIds = new Set(departments.map((row) => String(row.id)));
  for (const person of Array.isArray(people) ? people : []) {
    if (!isRecord(person) || typeof person.id !== 'string') continue;
    const department = person.department;
    if (isRecord(department) && typeof department.id === 'string') {
      if (!departmentIds.has(department.id)) {
        errors.push(
          `people: "${person.id}" is in department "${department.id}", which ` +
            'search_departments did not return',
        );
      }
    }
    const manager = person.manager;
    if (isRecord(manager) && typeof manager.id === 'string' && !peopleIds.has(manager.id)) {
      errors.push(
        `people: "${person.id}" reports to "${manager.id}", who was not fetched — walk up ` +
          'to the top of the tree, or run lookup_person on the manager',
      );
    }
  }

  for (const key of ['direct_reports', 'absences', 'balances'] as const) {
    const value = parsed[key];
    if (value === undefined || value === null) {
      if (key !== 'balances') errors.push(`${key}: missing (expected an object keyed by id)`);
      continue;
    }
    if (!isRecord(value)) errors.push(`${key}: expected an object keyed by worker id`);
  }

  const absences = isRecord(parsed.absences) ? parsed.absences : {};
  for (const [workerId, row] of Object.entries(absences)) {
    if (!isRecord(row)) {
      errors.push(`absences["${workerId}"]: expected a lookup_absence result`);
      continue;
    }
    if (typeof row.is_on_leave !== 'boolean') {
      errors.push(`absences["${workerId}"].is_on_leave: expected a boolean`);
    }
  }

  const calls = parsed.calls;
  if (!Array.isArray(calls)) {
    errors.push('calls: expected an array of { fn, args_summary, ok }');
  } else {
    calls.forEach((call, index) => {
      if (!isRecord(call) || typeof call.fn !== 'string') {
        errors.push(`calls[${index}]: expected { fn, args_summary, ok }`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}
