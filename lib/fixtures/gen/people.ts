/**
 * lib/fixtures/gen/people.ts — the org chart: departments, teams and 120 workers.
 *
 * Owns: the deterministic slot plan (who sits where, who reports to whom, in what order
 * worker ids are allocated) and the PRNG draws that dress it — names, locations, tenure,
 * compensation. The slot plan is pure structure and never touches the PRNG, so pinned ids
 * in `catalog.ts` stay valid even if a name pool changes.
 *
 * Public interface: `planOrg`, `OrgPlan`, `Slot`, `generatePeople`, `PeopleResult`.
 *
 * Spec: docs/SPEC.md §3 (Tier 1), §8 loop 1; docs/PLAN.md §2.1, §3 block B0.4.
 */

import type {
  CompBand,
  Department,
  JobFunction,
  Team,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';
import {
  DEPARTMENT_SPECS,
  EXEC_TEAM,
  FUNCTION_LABEL,
  IC_TITLES,
  LOCATIONS,
  LOCATION_WEIGHTS,
  LEVELS,
  MANAGER_TITLE_BY_LEVEL,
  PINNED,
  TEAM_SPECS,
  workerId,
} from '#lib/fixtures/gen/catalog.ts';
import { EMAIL_DOMAIN } from '#lib/fixtures/gen/bundle.ts';
import { findBandFor, indexBands } from '#lib/fixtures/gen/bands.ts';
import { toDayNumber, fromDayNumber } from '#lib/fixtures/gen/dates.ts';
import {
  FAMILY_NAMES,
  GIVEN_NAMES,
  PINNED_NAMES,
  PREFERRED_NAMES,
  emailLocalPart,
} from '#lib/fixtures/gen/names.ts';
import type { Rng } from '#lib/fixtures/gen/rng.ts';

export type SlotRole = 'ceo' | 'dept_head' | 'team_lead' | 'ic';

export interface Slot {
  id: WorkerId;
  role: SlotRole;
  department_id: string;
  team_id: string;
  job_function: JobFunction;
  level_id: string;
  manager_id: WorkerId | null;
  /** Set for the CEO, department heads and team leads; ICs derive it from their level. */
  title?: string;
}

export interface OrgPlan {
  slots: Slot[];
  departments: Department[];
  teams: Team[];
}

/** Locations forced for the people the demo scenarios name, so the story reads sensibly. */
const FORCED_LOCATIONS: Record<string, string> = {
  w_0001: 'loc_sf',
  w_0002: 'loc_sf',
  w_0005: 'loc_nyc',
  w_0007: 'loc_sf',
  w_0008: 'loc_sf',
  w_0009: 'loc_blr',
  w_0015: 'loc_nyc',
  w_0021: 'loc_sf',
  w_0033: 'loc_remote_us',
  w_0114: 'loc_sf',
};

const IC_LEVEL_IDS = ['lvl_L3', 'lvl_L4', 'lvl_L5', 'lvl_L6', 'lvl_L7'] as const;
const IC_LEVEL_WEIGHTS = [15, 30, 30, 17, 8] as const;

function levelById(id: string) {
  const level = LEVELS.find((candidate) => candidate.id === id);
  if (!level) throw new Error(`Unknown level: ${id}`);
  return level;
}

function locationById(id: string) {
  const location = LOCATIONS.find((candidate) => candidate.id === id);
  if (!location) throw new Error(`Unknown location: ${id}`);
  return location;
}

/**
 * The structural half of the org: id allocation order is CEO → department heads →
 * team leads → ICs team by team, exactly as documented in `catalog.ts`.
 */
export function planOrg(): OrgPlan {
  const slots: Slot[] = [];
  let nextIndex = 1;
  const take = (): WorkerId => workerId(nextIndex++);

  const ceoId = take();
  slots.push({
    id: ceoId,
    role: 'ceo',
    department_id: 'dept_ga',
    team_id: EXEC_TEAM.id,
    job_function: 'ga',
    level_id: 'lvl_E1',
    manager_id: null,
    title: 'Chief Executive Officer',
  });

  const headByDepartment = new Map<string, WorkerId>([['dept_ga', ceoId]]);
  for (const spec of DEPARTMENT_SPECS) {
    if (spec.head_level_id === null) continue;
    const id = take();
    const firstTeam = TEAM_SPECS.find((team) => team.department_id === spec.id);
    if (!firstTeam) throw new Error(`Department ${spec.id} has no teams`);
    headByDepartment.set(spec.id, id);
    slots.push({
      id,
      role: 'dept_head',
      department_id: spec.id,
      team_id: firstTeam.id,
      job_function: spec.job_function,
      level_id: spec.head_level_id,
      manager_id: ceoId,
      title: `${MANAGER_TITLE_BY_LEVEL[spec.head_level_id] ?? 'Manager'}, ${FUNCTION_LABEL[spec.job_function]}`,
    });
  }

  const leadByTeam = new Map<string, WorkerId>();
  for (const team of TEAM_SPECS) {
    const spec = DEPARTMENT_SPECS.find((d) => d.id === team.department_id);
    if (!spec) throw new Error(`Team ${team.id} has no department`);
    const id = take();
    leadByTeam.set(team.id, id);
    slots.push({
      id,
      role: 'team_lead',
      department_id: team.department_id,
      team_id: team.id,
      job_function: spec.job_function,
      level_id: team.lead_level_id,
      manager_id: headByDepartment.get(team.department_id) ?? ceoId,
      title:
        team.lead_title ??
        `${MANAGER_TITLE_BY_LEVEL[team.lead_level_id] ?? 'Manager'}, ${team.name}`,
    });
  }

  for (const team of TEAM_SPECS) {
    const spec = DEPARTMENT_SPECS.find((d) => d.id === team.department_id);
    if (!spec) throw new Error(`Team ${team.id} has no department`);
    const lead = leadByTeam.get(team.id);
    if (!lead) throw new Error(`Team ${team.id} has no lead`);
    for (let i = 0; i < team.ic_count; i += 1) {
      slots.push({
        id: take(),
        role: 'ic',
        department_id: team.department_id,
        team_id: team.id,
        job_function: spec.job_function,
        level_id: 'lvl_L4',
        manager_id: lead,
      });
    }
  }

  const departments: Department[] = DEPARTMENT_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    head_worker_id: headByDepartment.get(spec.id) ?? ceoId,
  }));

  const teams: Team[] = [
    {
      id: EXEC_TEAM.id,
      name: EXEC_TEAM.name,
      department_id: EXEC_TEAM.department_id,
      lead_worker_id: ceoId,
    },
    ...TEAM_SPECS.map((team) => ({
      id: team.id,
      name: team.name,
      department_id: team.department_id,
      lead_worker_id: leadByTeam.get(team.id) ?? ceoId,
    })),
  ];

  return { slots, departments, teams };
}

export interface PeopleResult {
  workers: Worker[];
  departments: Department[];
  teams: Team[];
}

function uniqueSlackId(rng: Rng, taken: Set<string>): string {
  const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let id = 'U';
    for (let i = 0; i < 8; i += 1) id += charset[rng.int(0, charset.length - 1)] ?? '0';
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  throw new Error('Could not allocate a unique slack_user_id');
}

function uniqueEmail(first: string, last: string, taken: Set<string>): string {
  const base = `${emailLocalPart(first)}.${emailLocalPart(last)}`;
  let local = base;
  let suffix = 2;
  while (taken.has(local)) {
    local = `${base}${suffix}`;
    suffix += 1;
  }
  taken.add(local);
  return `${local}@${EMAIL_DOMAIN}`;
}

/** Managers and executives are long-tenured; ICs skew recent, with ~1 in 4 hired in 2026. */
function drawStartDate(rng: Rng, slot: Slot): string {
  if (slot.role !== 'ic') {
    const from = toDayNumber('2017-06-01');
    const to = toDayNumber('2021-12-31');
    return fromDayNumber(rng.int(from, to));
  }
  // The outlier manager's reports must predate FY2025 so they all carry a prior rating.
  if (slot.manager_id === PINNED.outlier_manager) {
    return fromDayNumber(rng.int(toDayNumber('2019-01-01'), toDayNumber('2025-03-31')));
  }
  if (rng.chance(0.72)) {
    return fromDayNumber(rng.int(toDayNumber('2019-01-01'), toDayNumber('2025-12-31')));
  }
  return fromDayNumber(rng.int(toDayNumber('2026-01-01'), toDayNumber('2026-06-15')));
}

/** Dress the slot plan with names, places, tenure and pay. Consumes the PRNG in slot order. */
export function generatePeople(rng: Rng, bands: readonly CompBand[]): PeopleResult {
  const plan = planOrg();
  const bandIndex = indexBands(bands);
  const emails = new Set<string>();
  const slackIds = new Set<string>();
  const contractors = new Set<string>(PINNED.contractors);
  const belowBand = new Set<string>(PINNED.below_band);
  const aboveBand = new Set<string>(PINNED.above_band);

  const workers: Worker[] = plan.slots.map((slot) => {
    const drawnFirst = rng.pick(GIVEN_NAMES);
    const drawnLast = rng.pick(FAMILY_NAMES);
    const levelId =
      slot.role === 'ic' ? rng.weighted(IC_LEVEL_IDS, IC_LEVEL_WEIGHTS) : slot.level_id;
    const locationId = FORCED_LOCATIONS[slot.id] ?? rng.weighted(LOCATIONS, LOCATION_WEIGHTS).id;
    const startDate = drawStartDate(rng, slot);
    const payPosition = rng.next();
    const slackUserId = uniqueSlackId(rng, slackIds);

    const pinned = PINNED_NAMES[slot.id];
    const firstName = pinned?.first ?? drawnFirst;
    const lastName = pinned?.last ?? drawnLast;
    const level = levelById(levelId);
    const location = locationById(locationId);
    const band = findBandFor(bandIndex, level, slot.job_function, location.location_group);
    const step = band.currency === 'INR' ? 10_000 : 500;
    const round = (value: number) => Math.round(value / step) * step;

    let baseAnnual = round(band.min + (band.max - band.min) * (0.15 + payPosition * 0.7));
    if (belowBand.has(slot.id)) baseAnnual = round(band.min * 0.88);
    if (aboveBand.has(slot.id)) baseAnnual = round(band.max * 1.12);

    const icTitles = IC_TITLES[slot.job_function];
    const title =
      slot.title ??
      icTitles[Math.min(Math.max(level.rank - 3, 0), icTitles.length - 1)] ??
      'Analyst';

    const preferred = PREFERRED_NAMES[slot.id];
    const worker: Worker = {
      id: slot.id,
      first_name: firstName,
      last_name: lastName,
      ...(preferred ? { preferred_name: preferred } : {}),
      work_email: uniqueEmail(firstName, lastName, emails),
      title,
      level_id: level.id,
      job_function: slot.job_function,
      department_id: slot.department_id,
      team_id: slot.team_id,
      manager_id: slot.manager_id,
      location_id: location.id,
      employment_type: contractors.has(slot.id) ? 'contractor' : 'full_time',
      start_date: startDate,
      status: 'ACTIVE',
      slack_user_id: slackUserId,
      timezone: location.timezone,
      compensation: { base_annual: baseAnnual, currency: band.currency },
    };
    return worker;
  });

  return { workers, departments: plan.departments, teams: plan.teams };
}

/** Convenience for the scenario builders: `manager_id` → direct reports. */
export function reportsByManager(workers: readonly Worker[]): Map<WorkerId, Worker[]> {
  const map = new Map<WorkerId, Worker[]>();
  for (const worker of workers) {
    if (!worker.manager_id) continue;
    const bucket = map.get(worker.manager_id);
    if (bucket) bucket.push(worker);
    else map.set(worker.manager_id, [worker]);
  }
  return map;
}
