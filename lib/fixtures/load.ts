/**
 * lib/fixtures/load.ts — read the committed fixture tenant back, and prove it is intact.
 *
 * Owns: `loadTenant(dir?)`, which parses every file under the fixtures dir into a
 * `TenantBundle` and refuses to return one that is not internally consistent — every
 * foreign key must resolve, every enum value must be legal, every id must be unique, and
 * exactly one identity must be the default. Problems are collected, not thrown one at a
 * time: a single `FixtureError` lists all of them. Also owns `verifyManifest(dir)`, the
 * hash check `bin/doctor.mjs` and `bin/seed.mjs --verify` rely on.
 *
 * Directory resolution, in order: the `dir` argument, then `TL_FIXTURES_DIR` (read from
 * `process.env` at call time, never cached), then `<repo>/fixtures/tenant` resolved from
 * `import.meta.url`. `lib/config.ts` owns the same knob for the rest of the system; this
 * module reads the environment directly so the fixtures layer has no dependency on it.
 *
 * Public interface: `loadTenant`, `verifyManifest`, `readManifest`, `defaultFixturesDir`,
 * `resolveFixturesDir`, `FixtureError`, `ManifestVerification`.
 *
 * Spec: docs/SPEC.md §3, §5; docs/PLAN.md §2.1, §2.7, §3 block B0.4.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import {
  ABSENCE_STATUSES,
  APPLICATION_STATUSES,
  CANDIDATE_SOURCES,
  CURRENCIES,
  EMPLOYMENT_TYPES,
  HEADCOUNT_POSITION_STATUSES,
  IDENTITY_ROLES,
  JOB_FUNCTIONS,
  LEVEL_TRACKS,
  REQUISITION_STATUSES,
  WORKER_STATUSES,
} from '#lib/types/tier1.ts';
import { CYCLE_STATES, CYCLE_TYPES } from '#lib/types/engine.ts';
import {
  LEDGER_FILE,
  MANIFEST_FILE,
  STATE_FILES,
  TIER1_FILES,
  emptyState,
} from '#lib/fixtures/gen/bundle.ts';
import type { TenantBundle, TenantState, Tier1FileKey } from '#lib/fixtures/gen/bundle.ts';
import { hashBytes } from '#lib/fixtures/write.ts';
import type { FixtureManifest } from '#lib/fixtures/write.ts';

/** Thrown when the fixtures on disk are missing, unparseable or internally inconsistent. */
export class FixtureError extends TalentLoopsError {
  readonly dir: string;
  readonly problems: string[];

  constructor(dir: string, problems: string[]) {
    const listed = problems.map((problem) => `  - ${problem}`).join('\n');
    super(
      'FIXTURES_INVALID',
      `Fixture tenant at ${dir} is not usable (${problems.length} problem${
        problems.length === 1 ? '' : 's'
      }):\n${listed}\nRegenerate with: npm run seed`,
    );
    this.name = 'FixtureError';
    this.dir = dir;
    this.problems = problems;
  }
}

/** `<repo>/fixtures/tenant`, derived from this module's own location. */
export function defaultFixturesDir(): string {
  return fileURLToPath(new URL('../../fixtures/tenant', import.meta.url));
}

/** Argument wins, then `TL_FIXTURES_DIR`, then the repo default. */
export function resolveFixturesDir(dir?: string): string {
  if (dir && dir.length > 0) return dir;
  const fromEnv = process.env.TL_FIXTURES_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return defaultFixturesDir();
}

/* ------------------------------------------------------------------ manifest */

export interface ManifestVerification {
  ok: boolean;
  problems: string[];
}

export function readManifest(dir: string): FixtureManifest {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new FixtureError(dir, [`${MANIFEST_FILE} is missing`]);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
  } catch (error) {
    throw new FixtureError(dir, [`${MANIFEST_FILE} is not valid JSON: ${String(error)}`]);
  }
}

/** Recompute every listed hash, and flag files present on disk that the manifest omits. */
export function verifyManifest(dir?: string): ManifestVerification {
  const root = resolveFixturesDir(dir);
  const problems: string[] = [];
  let manifest: FixtureManifest;
  try {
    manifest = readManifest(root);
  } catch (error) {
    return {
      ok: false,
      problems: error instanceof FixtureError ? error.problems : [String(error)],
    };
  }

  if (!manifest.files || typeof manifest.files !== 'object') {
    return { ok: false, problems: [`${MANIFEST_FILE} has no "files" map`] };
  }

  for (const [file, entry] of Object.entries(manifest.files)) {
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`${file}: listed in the manifest but missing on disk`);
      continue;
    }
    const contents = readFileSync(path, 'utf8');
    const actual = hashBytes(contents);
    if (actual !== entry.sha256) {
      problems.push(`${file}: sha256 mismatch (manifest ${entry.sha256}, on disk ${actual})`);
    }
  }

  for (const file of listFixtureFiles(root)) {
    if (file === MANIFEST_FILE) continue;
    if (!Object.prototype.hasOwnProperty.call(manifest.files, file)) {
      problems.push(`${file}: present on disk but not listed in the manifest`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Every non-dot file under `dir`, as POSIX-relative paths. */
function listFixtureFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFixtureFiles(join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out.sort();
}

/* -------------------------------------------------------------------- loading */

function readJsonArray(dir: string, file: string, problems: string[]): unknown[] {
  const path = join(dir, file);
  if (!existsSync(path)) {
    problems.push(`${file}: missing`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${file}: not valid JSON (${(error as Error).message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    problems.push(`${file}: expected a JSON array`);
    return [];
  }
  return parsed;
}

function readResumes(dir: string, problems: string[]): Record<string, string> {
  const resumeDir = join(dir, 'resumes');
  const resumes: Record<string, string> = {};
  if (!existsSync(resumeDir)) {
    problems.push('resumes/: missing');
    return resumes;
  }
  for (const name of readdirSync(resumeDir).sort()) {
    if (!name.endsWith('.md')) continue;
    resumes[`resumes/${name}`] = readFileSync(join(resumeDir, name), 'utf8');
  }
  return resumes;
}

/* ----------------------------------------------------------------- validation */

type Row = Record<string, unknown>;

function ids(rows: readonly Row[]): Set<string> {
  return new Set(rows.map((row) => String(row.id)));
}

function checkUniqueIds(file: string, rows: readonly Row[], problems: string[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) {
      problems.push(`${file}: a row has no string id`);
      continue;
    }
    if (seen.has(id)) problems.push(`${file}: duplicate id "${id}"`);
    seen.add(id);
  }
}

function checkEnum(
  file: string,
  rows: readonly Row[],
  field: string,
  allowed: readonly string[],
  problems: string[],
): void {
  for (const row of rows) {
    const value = row[field];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      problems.push(`${file}: ${String(row.id)} has illegal ${field} "${String(value)}"`);
    }
  }
}

/** A short uppercase code (`US`, `IN`, `DE`, `LT`) — the shape of a country/group key. */
function checkCode(file: string, rows: readonly Row[], field: string, problems: string[]): void {
  for (const row of rows) {
    const value = row[field];
    if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(value)) {
      problems.push(
        `${file}: ${String(row.id)} has ${field} "${String(value)}" which is not an ` +
          'uppercase code (e.g. US, IN, DE)',
      );
    }
  }
}

/** `nullable` allows an explicitly `null` reference (e.g. `manager_id`). */
function checkRef(
  file: string,
  rows: readonly Row[],
  field: string,
  target: ReadonlySet<string>,
  targetName: string,
  problems: string[],
  options: { nullable?: boolean; optional?: boolean } = {},
): void {
  for (const row of rows) {
    const value = row[field];
    if (value === null && options.nullable) continue;
    if (value === undefined && options.optional) continue;
    if (typeof value !== 'string' || !target.has(value)) {
      problems.push(
        `${file}: ${String(row.id)} has ${field} "${String(value)}" which is not a known ${targetName}`,
      );
    }
  }
}

function validate(bundle: TenantBundle, problems: string[]): void {
  const rowsOf = (key: Tier1FileKey): Row[] => bundle[key] as unknown as Row[];

  for (const [key, file] of Object.entries(TIER1_FILES) as [Tier1FileKey, string][]) {
    // `prior_ratings`, `identities` and `calendar_busy` are keyed by worker, not by an `id`.
    if (key === 'prior_ratings' || key === 'identities' || key === 'calendar_busy') continue;
    checkUniqueIds(file, rowsOf(key), problems);
  }

  const levelIds = ids(rowsOf('levels'));
  const locationIds = ids(rowsOf('locations'));
  const departmentIds = ids(rowsOf('departments'));
  const teamIds = ids(rowsOf('teams'));
  const workerIds = ids(rowsOf('workers'));
  const bandIds = ids(rowsOf('comp_bands'));
  const positionIds = ids(rowsOf('headcount_positions'));
  const requisitionIds = ids(rowsOf('job_requisitions'));
  const candidateIds = ids(rowsOf('candidates'));
  const leaveTypeIds = ids(rowsOf('leave_types'));

  checkEnum('levels.json', rowsOf('levels'), 'track', LEVEL_TRACKS, problems);
  // `country` and `location_group` are free strings, not enums: a bridged tenant
  // (docs/PLAN.md §8) has DE and LT locations that no fixture catalogue lists. The shape is
  // still checked — an ISO-3166 alpha-2 style code — so a typo is not silently accepted.
  checkCode('locations.json', rowsOf('locations'), 'country', problems);
  checkCode('locations.json', rowsOf('locations'), 'location_group', problems);

  const workers = rowsOf('workers');
  checkEnum('workers.json', workers, 'job_function', JOB_FUNCTIONS, problems);
  checkEnum('workers.json', workers, 'employment_type', EMPLOYMENT_TYPES, problems);
  checkEnum('workers.json', workers, 'status', WORKER_STATUSES, problems);
  checkRef('workers.json', workers, 'level_id', levelIds, 'level', problems);
  checkRef('workers.json', workers, 'department_id', departmentIds, 'department', problems);
  checkRef('workers.json', workers, 'team_id', teamIds, 'team', problems);
  checkRef('workers.json', workers, 'location_id', locationIds, 'location', problems);
  checkRef('workers.json', workers, 'manager_id', workerIds, 'worker', problems, {
    nullable: true,
  });
  // `compensation` is optional (docs/PLAN.md §8): the Rippling MCP redacts pay, so a bridged
  // tenant has none. When it is present it must still be a whole, legal figure.
  for (const worker of workers) {
    const comp = worker.compensation as Row | undefined;
    if (comp === undefined || comp === null) continue;
    if (typeof comp.base_annual !== 'number') {
      problems.push(`workers.json: ${String(worker.id)} has no numeric compensation.base_annual`);
    } else if (!CURRENCIES.includes(comp.currency as never)) {
      problems.push(`workers.json: ${String(worker.id)} has illegal currency`);
    }
  }

  checkRef(
    'departments.json',
    rowsOf('departments'),
    'head_worker_id',
    workerIds,
    'worker',
    problems,
  );
  checkRef('teams.json', rowsOf('teams'), 'department_id', departmentIds, 'department', problems);
  checkRef('teams.json', rowsOf('teams'), 'lead_worker_id', workerIds, 'worker', problems);

  const bands = rowsOf('comp_bands');
  checkEnum('comp_bands.json', bands, 'job_function', JOB_FUNCTIONS, problems);
  checkCode('comp_bands.json', bands, 'location_group', problems);
  checkEnum('comp_bands.json', bands, 'currency', CURRENCIES, problems);
  checkRef('comp_bands.json', bands, 'level_id', levelIds, 'level', problems);
  for (const band of bands) {
    const { min, mid, max } = band as { min: number; mid: number; max: number };
    if (!(min < mid && mid < max)) {
      problems.push(`comp_bands.json: ${String(band.id)} does not satisfy min < mid < max`);
    }
  }

  const positions = rowsOf('headcount_positions');
  checkEnum('headcount_positions.json', positions, 'status', HEADCOUNT_POSITION_STATUSES, problems);
  checkRef(
    'headcount_positions.json',
    positions,
    'department_id',
    departmentIds,
    'department',
    problems,
  );
  checkRef('headcount_positions.json', positions, 'level_id', levelIds, 'level', problems);
  checkRef('headcount_positions.json', positions, 'recruiter_id', workerIds, 'worker', problems);
  checkRef(
    'headcount_positions.json',
    positions,
    'job_requisition_id',
    requisitionIds,
    'requisition',
    problems,
    { nullable: true },
  );

  const requisitions = rowsOf('job_requisitions');
  checkEnum('job_requisitions.json', requisitions, 'status', REQUISITION_STATUSES, problems);
  checkEnum('job_requisitions.json', requisitions, 'job_function', JOB_FUNCTIONS, problems);
  checkRef(
    'job_requisitions.json',
    requisitions,
    'department_id',
    departmentIds,
    'department',
    problems,
  );
  checkRef('job_requisitions.json', requisitions, 'level_id', levelIds, 'level', problems);
  checkRef('job_requisitions.json', requisitions, 'location_id', locationIds, 'location', problems);
  checkRef(
    'job_requisitions.json',
    requisitions,
    'hiring_manager_id',
    workerIds,
    'worker',
    problems,
  );
  checkRef('job_requisitions.json', requisitions, 'recruiter_id', workerIds, 'worker', problems);
  checkRef(
    'job_requisitions.json',
    requisitions,
    'headcount_position_id',
    positionIds,
    'headcount position',
    problems,
    { nullable: true },
  );

  const candidates = rowsOf('candidates');
  checkEnum('candidates.json', candidates, 'source', CANDIDATE_SOURCES, problems);
  checkRef('candidates.json', candidates, 'referred_by_worker_id', workerIds, 'worker', problems, {
    optional: true,
  });
  for (const candidate of candidates) {
    const ref = candidate.resume_ref;
    if (typeof ref !== 'string' || !(ref in bundle.resumes)) {
      problems.push(`candidates.json: ${String(candidate.id)} has no résumé at "${String(ref)}"`);
    }
  }

  const applications = rowsOf('applications');
  checkEnum('applications.json', applications, 'status', APPLICATION_STATUSES, problems);
  checkRef('applications.json', applications, 'candidate_id', candidateIds, 'candidate', problems);
  checkRef('applications.json', applications, 'job_id', requisitionIds, 'requisition', problems);

  const absences = rowsOf('absences');
  checkEnum('absences.json', absences, 'status', ABSENCE_STATUSES, problems);
  checkRef('absences.json', absences, 'worker_id', workerIds, 'worker', problems);
  checkRef('absences.json', absences, 'leave_type_id', leaveTypeIds, 'leave type', problems);
  for (const absence of absences) {
    if (String(absence.start_date) > String(absence.end_date)) {
      problems.push(`absences.json: ${String(absence.id)} ends before it starts`);
    }
  }

  checkRef('holidays.json', rowsOf('holidays'), 'location_id', locationIds, 'location', problems);

  for (const rating of rowsOf('prior_ratings')) {
    const subject = rating.worker_id;
    const rater = rating.rated_by_worker_id;
    if (typeof subject !== 'string' || !workerIds.has(subject)) {
      problems.push(`prior_ratings.json: unknown worker_id "${String(subject)}"`);
    }
    if (typeof rater !== 'string' || !workerIds.has(rater)) {
      problems.push(`prior_ratings.json: unknown rated_by_worker_id "${String(rater)}"`);
    }
    const value = rating.rating;
    if (typeof value !== 'number' || value < 1 || value > 5) {
      problems.push(`prior_ratings.json: ${String(subject)} has an out-of-range rating`);
    }
  }

  const identities = rowsOf('identities');
  checkEnum('identities.json', identities, 'role', IDENTITY_ROLES, problems);
  const identityWorkers = new Set<string>();
  for (const identity of identities) {
    const key = String(identity.worker_id);
    if (identityWorkers.has(key)) problems.push(`identities.json: duplicate worker_id "${key}"`);
    identityWorkers.add(key);
  }
  for (const identity of identities) {
    const workerRef = identity.worker_id;
    if (typeof workerRef !== 'string' || !workerIds.has(workerRef)) {
      problems.push(`identities.json: unknown worker_id "${String(workerRef)}"`);
    }
    if (!Array.isArray(identity.permissions) || identity.permissions.length === 0) {
      problems.push(`identities.json: ${String(workerRef)} has no permissions`);
    }
  }
  const defaults = identities.filter((identity) => identity.is_default === true);
  if (defaults.length !== 1) {
    problems.push(
      `identities.json: expected exactly one is_default identity, found ${defaults.length}`,
    );
  }

  // The Google Calendar seam (spec §4). Busy blocks are meetings, never absence: a row here
  // must point at a real worker and must end after it starts, and that is all it may say.
  for (const block of rowsOf('calendar_busy')) {
    const workerRef = block.worker_id;
    if (typeof workerRef !== 'string' || !workerIds.has(workerRef)) {
      problems.push(`calendar_busy.json: unknown worker_id "${String(workerRef)}"`);
    }
    const start = block.start_at;
    const end = block.end_at;
    if (typeof start !== 'string' || typeof end !== 'string' || !(start < end)) {
      problems.push(
        `calendar_busy.json: ${String(workerRef)} has a block that does not end after it ` +
          `starts ("${String(start)}" → "${String(end)}")`,
      );
    }
  }

  const bandKeys = new Set(
    bands.map(
      (band) =>
        `${String(band.level_id)}|${String(band.job_function)}|${String(band.location_group)}`,
    ),
  );
  const locationGroup = new Map(
    rowsOf('locations').map((row) => [String(row.id), String(row.location_group)]),
  );
  // A tenant with no bands at all is a bridged tenant, not a broken one: bands are REST-only.
  if (bands.length > 0) {
    for (const worker of workers) {
      const key = `${String(worker.level_id)}|${String(worker.job_function)}|${locationGroup.get(String(worker.location_id)) ?? '?'}`;
      if (!bandKeys.has(key)) {
        problems.push(`comp_bands.json: no band covers ${String(worker.id)} (${key})`);
      }
    }
  }
  if (bandIds.size !== bands.length) problems.push('comp_bands.json: duplicate band ids');

  const cycles = bundle.state.cycles as unknown as Row[];
  checkEnum('state/cycles.json', cycles, 'type', CYCLE_TYPES, problems);
  checkEnum('state/cycles.json', cycles, 'status', CYCLE_STATES, problems);
  checkRef('state/cycles.json', cycles, 'owner_worker_id', workerIds, 'worker', problems);
  checkRef('state/cycles.json', cycles, 'created_by', workerIds, 'worker', problems);
  for (const cycle of cycles) {
    const scope = cycle.scope as { department_ids?: unknown } | undefined;
    const scoped = scope?.department_ids;
    if (Array.isArray(scoped)) {
      for (const departmentId of scoped) {
        if (typeof departmentId !== 'string' || !departmentIds.has(departmentId)) {
          problems.push(
            `state/cycles.json: ${String(cycle.id)} is scoped to unknown department "${String(departmentId)}"`,
          );
        }
      }
    }
  }
}

/**
 * Load, validate and return the fixture tenant. Throws `FixtureError` listing every
 * problem found rather than the first one, so a broken fixture is fixed in one pass.
 */
export function loadTenant(dir?: string): TenantBundle {
  const root = resolveFixturesDir(dir);
  const problems: string[] = [];

  if (!existsSync(root)) {
    throw new FixtureError(root, ['the fixtures directory does not exist']);
  }

  const tier1 = {} as Record<Tier1FileKey, unknown[]>;
  for (const [key, file] of Object.entries(TIER1_FILES) as [Tier1FileKey, string][]) {
    tier1[key] = readJsonArray(root, file, problems);
  }

  const state = emptyState();
  for (const [key, file] of Object.entries(STATE_FILES) as [keyof TenantState, string][]) {
    (state[key] as unknown[]) = readJsonArray(root, file, problems);
  }

  if (!existsSync(join(root, LEDGER_FILE))) {
    problems.push(`${LEDGER_FILE}: missing`);
  }

  const resumes = readResumes(root, problems);

  const bundle = {
    ...(tier1 as unknown as Omit<TenantBundle, 'resumes' | 'state'>),
    resumes,
    state,
  } as TenantBundle;

  if (problems.length === 0) validate(bundle, problems);
  if (problems.length > 0) throw new FixtureError(root, problems);
  return bundle;
}
