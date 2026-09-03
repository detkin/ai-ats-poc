/**
 * tests/bridge/map.test.ts — the Rippling MCP → Tier-1 mapping (block B2.6).
 *
 * `tests/bridge/sample-snapshot.json` is synthetic (fake names, fake ids) but is shaped
 * exactly like the records observed on the live tenant (docs/testing/live-rippling.md): eight
 * people in a three-level manager chain, one nested department, one person on leave with a
 * dated `current_leave`, one person with `location: null`, a Berlin location so the country
 * is not `US`, `teams: null` everywhere and `level: null` everywhere.
 *
 * What these tests are for: each of the seven fixture assumptions that failed on contact has
 * exactly one rule in `mapSnapshot`, and a rule that silently stops firing is a bridged run
 * that quietly nudges somebody on holiday, or dates a due move from the wrong timezone.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MANAGER_LEVEL_ID,
  MAPPING_VERSION,
  UNASSIGNED_LOCATION_ID,
  UNKNOWN_LEAVE_TYPE_ID,
  UNKNOWN_LEVEL_ID,
  jobFunctionForDepartment,
  mapSnapshot,
  validateSnapshot,
} from '#lib/adapters/bridge/index.ts';
import { loadPolicy } from '#lib/policy/index.ts';
import { sampleSnapshot as sample } from '#tests/bridge/helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-09-02T16:00:00Z');
const POLICY = loadPolicy(path.join(HERE, '..', '..', 'tenant', 'policy.yml'));

const mapped = mapSnapshot(sample(), POLICY, NOW);
const workerOf = (id: string) => mapped.bundle.workers.find((w) => w.id === id);

describe('the sample snapshot itself', () => {
  it('validates, so the tests below are testing the mapping and not a broken fixture', () => {
    expect(validateSnapshot(sample())).toEqual({ ok: true, errors: [] });
  });

  it('is in the observed MCP shapes', () => {
    const snapshot = sample();
    expect(snapshot.actor.company_id).toBe('co_test_1');
    // The three shapes the live smoke proved: no location timezone, no teams, no level.
    expect(snapshot.locations.results[0]).not.toHaveProperty('timezone');
    expect(snapshot.teams?.results).toEqual([]);
    expect(snapshot.people.every((person) => person.level === null)).toBe(true);
    expect(snapshot.people.every((person) => person.teams === null)).toBe(true);
  });
});

describe('workers', () => {
  it('maps every fetched person, in id order', () => {
    expect(mapped.bundle.workers).toHaveLength(8);
    expect(mapped.bundle.workers.map((w) => w.id)).toEqual(
      [...mapped.bundle.workers.map((w) => w.id)].sort(),
    );
  });

  it('takes the timezone from the person, never from the location', () => {
    expect(workerOf('w_eng2')?.timezone).toBe('Europe/Berlin');
    expect(workerOf('w_cs1')?.timezone).toBe('America/New_York');
    expect(workerOf('w_ceo')?.timezone).toBe('America/Los_Angeles');
  });

  it('carries the manager edge, and only to somebody who was fetched', () => {
    expect(workerOf('w_ceo')?.manager_id).toBeNull();
    expect(workerOf('w_cto')?.manager_id).toBe('w_ceo');
    expect(workerOf('w_cs2')?.manager_id).toBe('w_cs1');
  });

  it('maps employment_type EMPLOYEE to full_time and everything else to contractor', () => {
    expect(workerOf('w_eng1')?.employment_type).toBe('full_time');
    expect(workerOf('w_fin1')?.employment_type).toBe('contractor');
  });

  it('leaves compensation unset — the MCP redacts pay', () => {
    for (const worker of mapped.bundle.workers) {
      expect(worker.compensation).toBeUndefined();
    }
    expect(mapped.bundle.comp_bands).toEqual([]);
  });

  it('leaves slack_user_id empty; the outbox addresses worker ids', () => {
    expect(mapped.bundle.workers.every((w) => w.slack_user_id === '')).toBe(true);
  });

  it('keeps a preferred name only when it differs from the given name', () => {
    expect(workerOf('w_plat1')?.preferred_name).toBe('Essie');
    expect(workerOf('w_ceo')?.preferred_name).toBeUndefined();
  });

  it('derives job_function from the department name', () => {
    expect(workerOf('w_eng1')?.job_function).toBe('engineering');
    expect(workerOf('w_plat1')?.job_function).toBe('engineering');
    expect(workerOf('w_cs2')?.job_function).toBe('customer_success');
    expect(workerOf('w_ceo')?.job_function).toBe('ga');
  });

  it('maps a non-ACTIVE status to TERMINATED and nothing in between', () => {
    expect(new Set(mapped.bundle.workers.map((w) => w.status))).toEqual(new Set(['ACTIVE']));
  });
});

describe('job function mapping', () => {
  it.each([
    ['Engineering', 'engineering'],
    ['Platform Engineering', 'engineering'],
    ['Product', 'product'],
    ['Design', 'design'],
    ['Customer Success', 'customer_success'],
    ['Sales', 'sales'],
    ['Marketing', 'sales'],
    ['G&A', 'ga'],
    ['Finance', 'ga'],
    ['', 'ga'],
  ])('%s → %s', (name, expected) => {
    expect(jobFunctionForDepartment(name)).toBe(expected);
  });
});

describe('departments', () => {
  it('keeps the parent edge Rippling has and fixtures do not', () => {
    const platform = mapped.bundle.departments.find((d) => d.id === 'dept_platform');
    expect(platform?.parent_department_id).toBe('dept_eng');
    expect(
      mapped.bundle.departments.find((d) => d.id === 'dept_eng')?.parent_department_id,
    ).toBeNull();
  });

  it('heads each department with its highest-in-tree manager', () => {
    const head = (id: string) => mapped.bundle.departments.find((d) => d.id === id)?.head_worker_id;
    expect(head('dept_eng')).toBe('w_cto');
    expect(head('dept_cs')).toBe('w_cs1');
    expect(head('dept_ga')).toBe('w_ceo');
  });

  it('falls back to the shallowest member when a department has no manager in it', () => {
    // dept_platform holds only w_plat1, who is not a manager.
    expect(mapped.bundle.departments.find((d) => d.id === 'dept_platform')?.head_worker_id).toBe(
      'w_plat1',
    );
  });
});

describe('locations', () => {
  it('votes the timezone of the people standing in it', () => {
    const byId = new Map(mapped.bundle.locations.map((l) => [l.id, l]));
    expect(byId.get('loc_sf')?.timezone).toBe('America/Los_Angeles');
    expect(byId.get('loc_berlin')?.timezone).toBe('Europe/Berlin');
  });

  it('takes work hours from policy, because the MCP has none', () => {
    for (const location of mapped.bundle.locations) {
      expect(location.work_hours).toEqual(POLICY.quiet_hours.default_work_hours);
    }
  });

  it('derives location_group from the address country, not from a US/IN union', () => {
    const byId = new Map(mapped.bundle.locations.map((l) => [l.id, l]));
    expect(byId.get('loc_sf')?.location_group).toBe('US');
    expect(byId.get('loc_berlin')?.location_group).toBe('DE');
    expect(byId.get('loc_berlin')?.country).toBe('DE');
  });

  it('invents loc_unassigned for a person with no location, and warns', () => {
    expect(workerOf('w_cs1')?.location_id).toBe(UNASSIGNED_LOCATION_ID);
    const unassigned = mapped.bundle.locations.find((l) => l.id === UNASSIGNED_LOCATION_ID);
    expect(unassigned?.timezone).toBe('America/New_York');
    expect(mapped.warnings.join('\n')).toContain('no work location');
  });
});

describe('teams and levels — the degraded path', () => {
  it('gives every department a synthetic team when Rippling has none, and says so', () => {
    expect(mapped.bundle.teams.map((t) => t.id).sort()).toEqual([
      'team_dept_cs',
      'team_dept_eng',
      'team_dept_ga',
      'team_dept_platform',
    ]);
    expect(mapped.warnings.join('\n')).toContain('degrades to same-department');
  });

  it('leads each synthetic team with the department head', () => {
    const team = mapped.bundle.teams.find((t) => t.id === 'team_dept_eng');
    expect(team?.lead_worker_id).toBe('w_cto');
    expect(team?.department_id).toBe('dept_eng');
  });

  it('puts every worker on their own department team, so peer picking has a pool', () => {
    for (const worker of mapped.bundle.workers) {
      expect(worker.team_id).toBe(`team_${worker.department_id}`);
    }
  });

  it('emits exactly the two synthetic levels and assigns by is_manager', () => {
    expect(mapped.bundle.levels.map((l) => l.id).sort()).toEqual([
      MANAGER_LEVEL_ID,
      UNKNOWN_LEVEL_ID,
    ]);
    expect(workerOf('w_cto')?.level_id).toBe(MANAGER_LEVEL_ID);
    expect(workerOf('w_eng1')?.level_id).toBe(UNKNOWN_LEVEL_ID);
  });

  it('uses a real level when a profile carries one', () => {
    const snapshot = sample();
    const person = snapshot.people.find((p) => p.id === 'w_eng1');
    if (person !== undefined) person.level = { id: 'lvl_l5', name: 'L5', track: 'IC', rank: 5 };
    const result = mapSnapshot(snapshot, POLICY, NOW);
    expect(result.bundle.levels.find((l) => l.id === 'lvl_l5')).toEqual({
      id: 'lvl_l5',
      name: 'L5',
      track: 'IC',
      rank: 5,
    });
    expect(result.bundle.workers.find((w) => w.id === 'w_eng1')?.level_id).toBe('lvl_l5');
  });

  it('uses real teams when the tenant has them', () => {
    const snapshot = sample();
    snapshot.teams = {
      query: '',
      total_matches: 1,
      results: [{ id: 'team_infra', name: 'Infrastructure' }],
    };
    for (const person of snapshot.people) {
      if (person.id === 'w_eng1' || person.id === 'w_eng2') {
        person.teams = [{ id: 'team_infra', name: 'Infrastructure' }];
      }
    }
    const result = mapSnapshot(snapshot, POLICY, NOW);
    const team = result.bundle.teams.find((t) => t.id === 'team_infra');
    expect(team?.department_id).toBe('dept_eng');
    expect(team?.lead_worker_id).toBe('w_eng1');
    expect(result.bundle.workers.find((w) => w.id === 'w_eng2')?.team_id).toBe('team_infra');
    // Everybody else still needs a team that resolves.
    expect(result.bundle.workers.find((w) => w.id === 'w_ceo')?.team_id).toBe('team_dept_ga');
  });
});

describe('absence — present tense only', () => {
  it('records one APPROVED absence per person the MCP says is on leave right now', () => {
    expect(mapped.bundle.absences).toEqual([
      {
        id: 'abs_w_eng2',
        worker_id: 'w_eng2',
        leave_type_id: 'lt_vacation',
        start_date: '2026-08-31',
        end_date: '2026-09-03',
        status: 'APPROVED',
      },
    ]);
  });

  it('falls back to today, and warns, when current_leave carries no end date', () => {
    const snapshot = sample();
    const row = snapshot.absences.w_eng2;
    if (row !== undefined) row.current_leave = { leave_type_id: 'lt_sick' };
    const result = mapSnapshot(snapshot, POLICY, NOW);
    expect(result.bundle.absences[0]).toMatchObject({
      start_date: '2026-09-02',
      end_date: '2026-09-02',
      leave_type_id: 'lt_sick',
    });
    expect(result.warnings.join('\n')).toContain('no end_date');
  });

  it('falls back to lt_unknown when the leave type is not in the catalogue', () => {
    const snapshot = sample();
    const row = snapshot.absences.w_eng2;
    if (row !== undefined) row.current_leave = { leave_type_id: 'lt_not_listed' };
    const result = mapSnapshot(snapshot, POLICY, NOW);
    expect(result.bundle.absences[0]?.leave_type_id).toBe(UNKNOWN_LEAVE_TYPE_ID);
    expect(result.bundle.leave_types.some((t) => t.id === UNKNOWN_LEAVE_TYPE_ID)).toBe(true);
  });

  it('records nothing for somebody who is not on leave', () => {
    expect(mapped.bundle.absences.map((a) => a.worker_id)).not.toContain('w_ceo');
  });
});

describe('what a bridged tenant does not have', () => {
  it('has no ATS, no headcount, no holidays, no prior ratings and no résumés', () => {
    expect(mapped.bundle.candidates).toEqual([]);
    expect(mapped.bundle.applications).toEqual([]);
    expect(mapped.bundle.job_requisitions).toEqual([]);
    expect(mapped.bundle.headcount_positions).toEqual([]);
    expect(mapped.bundle.holidays).toEqual([]);
    expect(mapped.bundle.prior_ratings).toEqual([]);
    expect(mapped.bundle.calendar_busy).toEqual([]);
    expect(mapped.bundle.resumes).toEqual({});
  });

  it('starts with empty state', () => {
    expect(mapped.bundle.state.cycles).toEqual([]);
    expect(mapped.bundle.state.tasks).toEqual([]);
  });
});

describe('identity and provenance', () => {
  it('makes the acting user the one default hrbp identity', () => {
    expect(mapped.bundle.identities).toEqual([
      {
        worker_id: 'w_ceo',
        role: 'hrbp',
        permissions: ['rippling-mcp:access-assignment'],
        is_default: true,
      },
    ]);
  });

  it('records where the data came from, and every call that fetched it', () => {
    expect(mapped.provenance.source).toBe('rippling-mcp');
    expect(mapped.provenance.fetched_at).toBe('2026-09-02T15:40:00Z');
    expect(mapped.provenance.actor_worker_id).toBe('w_ceo');
    expect(mapped.provenance.company_id).toBe('co_test_1');
    expect(mapped.provenance.mapping_version).toBe(MAPPING_VERSION);
    expect(mapped.provenance.counts.workers).toBe(8);
    expect(mapped.provenance.calls.length).toBe(sample().calls.length);
    expect(mapped.provenance.warnings).toEqual(mapped.warnings);
  });
});

describe('determinism', () => {
  it('maps the same snapshot to the same bundle, twice', () => {
    const a = mapSnapshot(sample(), POLICY, NOW);
    const b = mapSnapshot(sample(), POLICY, NOW);
    expect(JSON.stringify(a.bundle)).toBe(JSON.stringify(b.bundle));
    expect(a.warnings).toEqual(b.warnings);
  });
});

describe('validateSnapshot rejects what cannot be mapped', () => {
  it('names a person whose department was never fetched', () => {
    const snapshot = sample();
    const person = snapshot.people.find((p) => p.id === 'w_eng1');
    if (person !== undefined) person.department = { id: 'dept_ghost', name: 'Ghost' };
    expect(validateSnapshot(snapshot).errors.join('\n')).toContain(
      'search_departments did not return',
    );
  });

  it('names a manager who was not fetched', () => {
    const snapshot = sample();
    snapshot.people = snapshot.people.filter((p) => p.id !== 'w_cs1');
    delete snapshot.absences.w_cs1;
    expect(validateSnapshot(snapshot).errors.join('\n')).toContain('who was not fetched');
  });

  it('insists the acting user is in the walk', () => {
    const snapshot = sample();
    snapshot.people = snapshot.people.filter((p) => p.id !== 'w_ceo');
    expect(validateSnapshot(snapshot).errors.join('\n')).toContain('is not in the list');
  });

  it('rejects a missing envelope, a bad fetched_at and a non-object', () => {
    const snapshot = sample() as unknown as Record<string, unknown>;
    delete snapshot.departments;
    snapshot.fetched_at = 'yesterday';
    const errors = validateSnapshot(snapshot).errors.join('\n');
    expect(errors).toContain('departments: missing');
    expect(errors).toContain('fetched_at');
    expect(validateSnapshot('nope').errors).toEqual(['the snapshot must be a JSON object']);
  });
});
