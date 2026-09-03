/**
 * lib/adapters/bridge/map.ts — Rippling MCP records → a Tier-1 `TenantBundle` (block B2.6).
 *
 * Owns: `mapSnapshot(snapshot, policy, now)`, one pure function that turns the raw JSON the
 * agent fetched (`lib/adapters/bridge/snapshot.ts`) into exactly the bundle the fixture port
 * classes already read, plus a `Provenance` record and a list of warnings. No I/O, no clock,
 * no randomness: the same snapshot maps to the same bundle, byte for byte.
 *
 * The seven fixture assumptions that did not survive contact with a real tenant
 * (docs/testing/live-rippling.md, docs/DECISIONS.md D27) are all resolved here:
 *
 *  1. **Timezone is on the person, not the location.** `Worker.timezone` comes from the
 *     profile; `Location.timezone` is the most common timezone of the people at that
 *     location, falling back to `quiet_hours.default_timezone`.
 *  2. **Locations have no work hours.** Every `Location.work_hours` is
 *     `quiet_hours.default_work_hours`.
 *  3. **Departments nest.** `parent_id` is kept as `Department.parent_department_id`.
 *  4. **`level` and `teams` are null.** One synthetic `lvl_unknown` / `lvl_manager` pair and
 *     one synthetic team per department stand in — which means **same-level logic degrades
 *     to "same team", and on this tenant "same team" means "same department"**. Loop 2's
 *     substitute rule is therefore weaker on a bridged tenant than on fixtures; say so in
 *     any report rather than implying levels were compared.
 *  5. **Absence is present-tense.** `is_on_leave` becomes one `APPROVED` absence dated
 *     `current_leave.start_date … end_date`, both defaulting to *today* when the MCP does not
 *     say. A one-day, today-only absence is the honest reading of "they are away right now";
 *     the engine re-checks on the next tick, so the answer corrects itself as the run goes on.
 *  6. **Compensation is redacted.** `Worker.compensation` is left unset and no comp band is
 *     emitted; `BandsPort.getWorkerCompensation` answers nulls and the calibration packet
 *     says compensation was not available.
 *  7. **The ATS is redacted.** Candidates, applications, requisitions and headcount are all
 *     empty arrays — a bridged tenant can run loop 1 and nothing else.
 *
 * Public interface: `mapSnapshot`, `MapResult`, `Provenance`, `MAPPING_VERSION`,
 * `UNASSIGNED_LOCATION_ID`, `UNASSIGNED_DEPARTMENT_ID`, `UNKNOWN_LEAVE_TYPE_ID`,
 * `UNKNOWN_LEVEL_ID`, `MANAGER_LEVEL_ID`, `jobFunctionForDepartment`.
 *
 * Spec: docs/PLAN.md §8, §2.1; docs/DECISIONS.md D25–D27.
 */

import { emptyState } from '#lib/fixtures/gen/bundle.ts';
import type { TenantBundle } from '#lib/fixtures/index.ts';
import type { TenantPolicy } from '#lib/policy/index.ts';
import type { BridgeCall, BridgeSnapshot, McpPerson } from '#lib/adapters/bridge/snapshot.ts';
import { JOB_FUNCTIONS } from '#lib/types/tier1.ts';
import type {
  Absence,
  Department,
  EmploymentType,
  Identity,
  JobFunction,
  LeaveType,
  Level,
  Location,
  Team,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';

/** Bump when a mapping rule changes; stamped into `provenance.json`. */
export const MAPPING_VERSION = '1';

/** Synthetic ids. Prefixed like their Tier-1 kin so an id still says what it is. */
export const UNASSIGNED_LOCATION_ID = 'loc_unassigned';
export const UNASSIGNED_DEPARTMENT_ID = 'dept_unassigned';
export const UNKNOWN_LEAVE_TYPE_ID = 'lt_unknown';
export const UNKNOWN_LEVEL_ID = 'lvl_unknown';
export const MANAGER_LEVEL_ID = 'lvl_manager';

/** The permission the MCP access assignment grants; recorded on every ledger line. */
export const BRIDGE_PERMISSION = 'rippling-mcp:access-assignment';

/** How a bundle came to exist. Written to `TL_DATA_DIR/tier1/provenance.json`. */
export interface Provenance {
  source: 'rippling-mcp';
  fetched_at: string;
  actor_worker_id: WorkerId;
  company_id: string | null;
  counts: Record<string, number>;
  calls: BridgeCall[];
  mapping_version: string;
  warnings: string[];
}

export interface MapResult {
  bundle: TenantBundle;
  provenance: Provenance;
  warnings: string[];
}

/* ------------------------------------------------------------------- helpers */

/** `YYYY-MM-DD` in UTC. The bridge has no per-location calendar to be clever with. */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Department name → job function. Substring match, `ga` when nothing fits. */
export function jobFunctionForDepartment(name: string): JobFunction {
  const text = name.toLowerCase();
  if (text.includes('engineer') || text.includes('technology') || text.includes('r&d')) {
    return 'engineering';
  }
  if (text.includes('product')) return 'product';
  if (text.includes('design')) return 'design';
  if (text.includes('customer') || text.includes('support') || text.includes('success')) {
    return 'customer_success';
  }
  if (text.includes('sales') || text.includes('revenue') || text.includes('marketing')) {
    return 'sales';
  }
  return JOB_FUNCTIONS.includes('ga') ? 'ga' : 'ga';
}

/** The most frequent value, ties broken by sort order so the map is deterministic. */
function mode(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (
    [...counts.entries()].sort((a, b) =>
      b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1,
    )[0]?.[0] ?? null
  );
}

/** `Given Family` split out of a display name when the structured fields are absent. */
function namesOf(person: McpPerson): { first: string; last: string; preferred?: string } {
  const display = (person.display_name ?? '').trim();
  const parts = display.length > 0 ? display.split(/\s+/) : [];
  const first = person.given_name?.trim() ?? parts[0] ?? person.id;
  const last = person.family_name?.trim() ?? (parts.length > 1 ? parts.slice(1).join(' ') : '');
  const preferred = person.preferred_given_name?.trim();
  return {
    first: first.length > 0 ? first : person.id,
    last,
    ...(preferred !== undefined && preferred.length > 0 && preferred !== first
      ? { preferred }
      : {}),
  };
}

function employmentTypeOf(person: McpPerson): EmploymentType {
  return (person.employment_type?.type ?? '').toUpperCase() === 'EMPLOYEE'
    ? 'full_time'
    : 'contractor';
}

/**
 * Depth in the manager tree: 0 for somebody with no manager (or whose manager was not
 * fetched), and one more than their manager otherwise. Cycles are broken at the depth cap.
 */
function depthsOf(people: readonly McpPerson[]): Map<WorkerId, number> {
  const managerOf = new Map<WorkerId, WorkerId | null>();
  const known = new Set(people.map((p) => p.id));
  for (const person of people) {
    const managerId = person.manager?.id;
    managerOf.set(person.id, managerId !== undefined && known.has(managerId) ? managerId : null);
  }
  const depths = new Map<WorkerId, number>();
  for (const person of people) {
    let depth = 0;
    let cursor: WorkerId | null = person.id;
    const seen = new Set<WorkerId>();
    while (cursor !== null && !seen.has(cursor) && depth <= known.size) {
      seen.add(cursor);
      const next: WorkerId | null = managerOf.get(cursor) ?? null;
      if (next === null) break;
      cursor = next;
      depth += 1;
    }
    depths.set(person.id, depth);
  }
  return depths;
}

/* ---------------------------------------------------------------- the mapping */

interface Ctx {
  snapshot: BridgeSnapshot;
  policy: TenantPolicy;
  today: string;
  warnings: string[];
  depths: Map<WorkerId, number>;
  actorId: WorkerId;
}

/** Departments, plus the synthetic catch-all if anybody needs it. */
function mapDepartments(ctx: Ctx, people: readonly McpPerson[]): Department[] {
  const rows = ctx.snapshot.departments.results;
  const ids = new Set(rows.map((row) => row.id));
  const needsUnassigned = people.some((person) => {
    const id = person.department?.id;
    return id === undefined || !ids.has(id);
  });

  /** The shallowest manager in the department, else the shallowest worker, else the actor. */
  const headOf = (departmentId: string): WorkerId => {
    const members = people
      .filter((person) => (person.department?.id ?? UNASSIGNED_DEPARTMENT_ID) === departmentId)
      .sort((a, b) => {
        const byDepth = (ctx.depths.get(a.id) ?? 0) - (ctx.depths.get(b.id) ?? 0);
        return byDepth !== 0 ? byDepth : a.id < b.id ? -1 : 1;
      });
    return members.find((p) => p.is_manager === true)?.id ?? members[0]?.id ?? ctx.actorId;
  };

  const departments: Department[] = rows.map((row) => {
    const parent = row.parent_id ?? null;
    if (parent !== null && !ids.has(parent)) {
      ctx.warnings.push(
        `department ${row.id} names parent "${parent}", which search_departments did not return; recorded as a root`,
      );
    }
    return {
      id: row.id,
      name: row.name,
      head_worker_id: headOf(row.id),
      parent_department_id: parent !== null && ids.has(parent) ? parent : null,
    };
  });

  if (needsUnassigned) {
    ctx.warnings.push(
      `some people have no department on their profile; they are placed in ${UNASSIGNED_DEPARTMENT_ID}`,
    );
    departments.push({
      id: UNASSIGNED_DEPARTMENT_ID,
      name: 'Unassigned',
      head_worker_id: headOf(UNASSIGNED_DEPARTMENT_ID),
      parent_department_id: null,
    });
  }
  return departments.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Locations, with a timezone voted for by the people standing in them. */
function mapLocations(ctx: Ctx, people: readonly McpPerson[]): Location[] {
  const rows = ctx.snapshot.locations.results;
  const ids = new Set(rows.map((row) => row.id));
  const needsUnassigned = people.some((person) => {
    const id = person.location?.id;
    return id === undefined || !ids.has(id);
  });
  const workHours = { ...ctx.policy.quiet_hours.default_work_hours };
  const fallbackZone = ctx.policy.quiet_hours.default_timezone;

  const zoneFor = (locationId: string): string => {
    const zones = people
      .filter((person) => (person.location?.id ?? UNASSIGNED_LOCATION_ID) === locationId)
      .map((person) => person.timezone)
      .filter((zone): zone is string => typeof zone === 'string' && zone.length > 0);
    const voted = mode(zones);
    if (voted === null) {
      ctx.warnings.push(
        `location ${locationId} has no worker timezone to derive from; using quiet_hours.default_timezone (${fallbackZone})`,
      );
      return fallbackZone;
    }
    return voted;
  };

  const locations: Location[] = rows.map((row) => {
    const country = (row.address?.country ?? '').trim().toUpperCase();
    if (country === '') {
      ctx.warnings.push(`location ${row.id} has no country on its address; recorded as UNKNOWN`);
    }
    const code = country === '' ? 'UNKNOWN' : country;
    return {
      id: row.id,
      name: row.name,
      country: code,
      timezone: zoneFor(row.id),
      work_hours: workHours,
      location_group: code,
    };
  });

  if (needsUnassigned) {
    ctx.warnings.push(
      `some people have no work location on their profile; they are placed in ${UNASSIGNED_LOCATION_ID}`,
    );
    locations.push({
      id: UNASSIGNED_LOCATION_ID,
      name: 'Unassigned',
      country: 'UNKNOWN',
      timezone: zoneFor(UNASSIGNED_LOCATION_ID),
      work_hours: workHours,
      location_group: 'UNKNOWN',
    });
  }
  return locations.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** `team_<department id>` — the stand-in when Rippling has no teams (the live tenant's case). */
function syntheticTeamId(departmentId: string): string {
  return `team_${departmentId}`;
}

interface TeamPlan {
  teams: Team[];
  teamIdOf: (person: McpPerson, departmentId: string) => string;
}

/**
 * Real teams when the tenant has them, one team per department when it does not. A person
 * whose `teams` list is empty always lands on their department's synthetic team, so
 * `Worker.team_id` always resolves and `peersFor` always has a pool.
 */
function planTeams(ctx: Ctx, people: readonly McpPerson[], departments: Department[]): TeamPlan {
  const headOf = new Map(departments.map((d) => [d.id, d.head_worker_id]));
  const realRows = ctx.snapshot.teams?.results ?? [];
  const realIds = new Set(realRows.map((row) => row.id));
  if (realRows.length === 0) {
    ctx.warnings.push(
      'this tenant has no teams (search_teams returned none); one synthetic team per department stands in, so same-level peer logic degrades to same-department',
    );
  }

  const departmentOf = (person: McpPerson): string =>
    headOf.has(person.department?.id ?? '')
      ? (person.department?.id ?? UNASSIGNED_DEPARTMENT_ID)
      : UNASSIGNED_DEPARTMENT_ID;

  const realTeamOf = (person: McpPerson): string | null => {
    const first = (person.teams ?? []).find((team) => realIds.has(team.id));
    return first === undefined ? null : first.id;
  };

  const teamIdOf = (person: McpPerson, departmentId: string): string =>
    realTeamOf(person) ?? syntheticTeamId(departmentId);

  const teams: Team[] = [];
  for (const row of realRows) {
    const members = people.filter((person) => realTeamOf(person) === row.id);
    const departmentId = mode(members.map(departmentOf)) ?? UNASSIGNED_DEPARTMENT_ID;
    const lead = [...members].sort((a, b) => {
      const byDepth = (ctx.depths.get(a.id) ?? 0) - (ctx.depths.get(b.id) ?? 0);
      return byDepth !== 0 ? byDepth : a.id < b.id ? -1 : 1;
    })[0];
    teams.push({
      id: row.id,
      name: row.name,
      department_id: departmentId,
      lead_worker_id: lead?.id ?? headOf.get(departmentId) ?? ctx.actorId,
    });
  }

  const used = new Set(people.map((person) => teamIdOf(person, departmentOf(person))));
  for (const department of departments) {
    const id = syntheticTeamId(department.id);
    if (!used.has(id)) continue;
    teams.push({
      id,
      name: `${department.name} team`,
      department_id: department.id,
      lead_worker_id: department.head_worker_id,
    });
  }
  return { teams: teams.sort((a, b) => (a.id < b.id ? -1 : 1)), teamIdOf };
}

/** Real levels when profiles carry them, plus the two synthetic ones the mapper assigns. */
function mapLevels(people: readonly McpPerson[]): Level[] {
  const levels = new Map<string, Level>([
    [UNKNOWN_LEVEL_ID, { id: UNKNOWN_LEVEL_ID, name: 'Unknown', track: 'IC', rank: 0 }],
    [MANAGER_LEVEL_ID, { id: MANAGER_LEVEL_ID, name: 'Manager', track: 'M', rank: 1 }],
  ]);
  for (const person of people) {
    const level = person.level;
    if (level === null || level === undefined || typeof level.id !== 'string') continue;
    if (levels.has(level.id)) continue;
    levels.set(level.id, {
      id: level.id,
      name: level.name ?? level.id,
      track: level.track === 'M' || level.track === 'E' ? level.track : 'IC',
      rank: typeof level.rank === 'number' ? level.rank : 0,
    });
  }
  return [...levels.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function levelIdOf(person: McpPerson): string {
  const id = person.level?.id;
  if (typeof id === 'string' && id.length > 0) return id;
  return person.is_manager === true ? MANAGER_LEVEL_ID : UNKNOWN_LEVEL_ID;
}

function mapWorkers(
  ctx: Ctx,
  people: readonly McpPerson[],
  departments: Department[],
  locations: Location[],
  teamPlan: TeamPlan,
): Worker[] {
  const departmentIds = new Set(departments.map((d) => d.id));
  const locationIds = new Set(locations.map((l) => l.id));
  const known = new Set(people.map((p) => p.id));
  const fallbackZone = ctx.policy.quiet_hours.default_timezone;
  const byName = new Map(departments.map((d) => [d.id, d.name]));

  return people
    .map((person): Worker => {
      const { first, last, preferred } = namesOf(person);
      const departmentId =
        person.department?.id !== undefined && departmentIds.has(person.department.id)
          ? person.department.id
          : UNASSIGNED_DEPARTMENT_ID;
      const locationId =
        person.location?.id !== undefined && locationIds.has(person.location.id)
          ? person.location.id
          : UNASSIGNED_LOCATION_ID;
      const managerId = person.manager?.id;
      if (managerId !== undefined && !known.has(managerId)) {
        ctx.warnings.push(
          `worker ${person.id} reports to ${managerId}, who was not fetched; recorded with no manager`,
        );
      }
      const timezone = person.timezone;
      if (timezone === null || timezone === undefined || timezone.length === 0) {
        ctx.warnings.push(
          `worker ${person.id} has no timezone; using quiet_hours.default_timezone (${fallbackZone})`,
        );
      }
      const startDate = person.start_date;
      if (startDate === null || startDate === undefined || startDate.length === 0) {
        ctx.warnings.push(`worker ${person.id} has no start_date; using today (${ctx.today})`);
      }
      const email = person.work_email;
      if (email === null || email === undefined || email.length === 0) {
        ctx.warnings.push(`worker ${person.id} has no work_email; nudges can only address an id`);
      }

      return {
        id: person.id,
        first_name: first,
        last_name: last,
        ...(preferred === undefined ? {} : { preferred_name: preferred }),
        work_email: email ?? '',
        title: person.title ?? '',
        level_id: levelIdOf(person),
        job_function: jobFunctionForDepartment(byName.get(departmentId) ?? ''),
        department_id: departmentId,
        team_id: teamPlan.teamIdOf(person, departmentId),
        manager_id: managerId !== undefined && known.has(managerId) ? managerId : null,
        location_id: locationId,
        employment_type: employmentTypeOf(person),
        start_date: startDate ?? ctx.today,
        status: (person.status ?? '').toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'TERMINATED',
        // Slack ids are not in the HRIS; the fixture channel adapter addresses worker ids.
        slack_user_id: '',
        timezone:
          timezone !== null && timezone !== undefined && timezone.length > 0
            ? timezone
            : fallbackZone,
        // `compensation` is deliberately absent: the MCP redacts pay (D27).
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function mapLeaveTypes(ctx: Ctx): LeaveType[] {
  const rows = ctx.snapshot.leave_types.results.map((row) => ({ id: row.id, name: row.name }));
  rows.push({ id: UNKNOWN_LEAVE_TYPE_ID, name: 'Leave' });
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * One `APPROVED` absence per person the MCP reports as on leave right now.
 * `lookup_absence` is present-tense and takes no date (D27), so an absence with no dates on
 * `current_leave` is recorded as today-only and re-read on the next tick.
 */
function mapAbsences(ctx: Ctx, workerIds: ReadonlySet<string>, leaveTypes: LeaveType[]): Absence[] {
  const leaveTypeIds = new Set(leaveTypes.map((t) => t.id));
  const absences: Absence[] = [];
  for (const [workerId, row] of Object.entries(ctx.snapshot.absences).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    if (row.is_on_leave !== true) continue;
    if (!workerIds.has(workerId)) {
      ctx.warnings.push(`absence for ${workerId}, who is not in the org walk; skipped`);
      continue;
    }
    const leave = row.current_leave ?? null;
    const rawType = leave?.leave_type_id ?? null;
    const leaveTypeId =
      rawType !== null && leaveTypeIds.has(rawType) ? rawType : UNKNOWN_LEAVE_TYPE_ID;
    const start = leave?.start_date ?? ctx.today;
    const end = leave?.end_date ?? ctx.today;
    if (leave?.end_date === undefined || leave.end_date === null) {
      ctx.warnings.push(
        `${workerId} is on leave but current_leave carries no end_date; recorded as ending today (${ctx.today}) and re-read next tick`,
      );
    }
    absences.push({
      id: `abs_${workerId}`,
      worker_id: workerId,
      leave_type_id: leaveTypeId,
      start_date: start <= end ? start : end,
      end_date: end,
      status: 'APPROVED',
    });
  }
  return absences;
}

/**
 * Map a fetched snapshot into a Tier-1 bundle.
 *
 * @param now the run's clock — the only thing that varies for a fixed snapshot, and it is
 *            used solely to date an absence or a start date the MCP did not supply.
 */
export function mapSnapshot(snapshot: BridgeSnapshot, policy: TenantPolicy, now: Date): MapResult {
  const people = [...snapshot.people].sort((a, b) => (a.id < b.id ? -1 : 1));
  const ctx: Ctx = {
    snapshot,
    policy,
    today: isoDate(now),
    warnings: [],
    depths: depthsOf(people),
    actorId: snapshot.actor.id,
  };

  const departments = mapDepartments(ctx, people);
  const locations = mapLocations(ctx, people);
  const teamPlan = planTeams(ctx, people, departments);
  const levels = mapLevels(people);
  const workers = mapWorkers(ctx, people, departments, locations, teamPlan);
  const leaveTypes = mapLeaveTypes(ctx);
  const absences = mapAbsences(ctx, new Set(workers.map((w) => w.id)), leaveTypes);

  const identities: Identity[] = [
    {
      worker_id: ctx.actorId,
      role: 'hrbp',
      permissions: [BRIDGE_PERMISSION],
      is_default: true,
    },
  ];

  const bundle: TenantBundle = {
    workers,
    departments,
    teams: teamPlan.teams,
    levels,
    locations,
    // Compensation, headcount and the whole ATS are redacted by the MCP (D27).
    comp_bands: [],
    headcount_positions: [],
    job_requisitions: [],
    candidates: [],
    applications: [],
    absences,
    leave_types: leaveTypes,
    // No holiday calendar is exposed; the tenant may list them in policy later.
    holidays: [],
    prior_ratings: [],
    identities,
    calendar_busy: [],
    resumes: {},
    state: emptyState(),
  };

  const provenance: Provenance = {
    source: 'rippling-mcp',
    fetched_at: snapshot.fetched_at,
    actor_worker_id: ctx.actorId,
    company_id: snapshot.actor.company_id ?? null,
    counts: {
      workers: workers.length,
      departments: departments.length,
      teams: teamPlan.teams.length,
      levels: levels.length,
      locations: locations.length,
      leave_types: leaveTypes.length,
      absences: absences.length,
      identities: identities.length,
    },
    calls: snapshot.calls.map((call) => ({ ...call })),
    mapping_version: MAPPING_VERSION,
    warnings: [...ctx.warnings],
  };

  return { bundle, provenance, warnings: [...ctx.warnings] };
}
