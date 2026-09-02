/**
 * lib/adapters/fixture/graph.ts — the people graph over the fixture tenant (block B1.2).
 *
 * Owns: `FixtureGraphAdapter`, a read-only view over the `TenantBundle` loaded once per
 * runtime. No I/O happens here: `buildRuntime` loads the bundle and hands it in, so a tick
 * that reads the org chart a hundred times touches the disk once.
 *
 * Public interface: `FixtureGraphAdapter` (implements `GraphPort`), `ActorNotFoundError`.
 *
 * Rippling calls this stands in for (see lib/ports/graph.ts):
 *   lookupMe -> codemode.lookup_me; lookupPerson -> codemode.lookup_person;
 *   lookupDirectReports -> codemode.lookup_direct_reports; searchPeople -> codemode.search_people;
 *   searchDepartments -> codemode.search_departments; searchTeams -> codemode.search_teams;
 *   listLocations/getLocation -> codemode.search_work_locations; levels -> REST GET /levels.
 *
 * Spec: docs/SPEC.md §2, §3 (tier 1 is read, never copied); docs/PLAN.md §2.3, §2.8.
 */

import type { TenantBundle } from '#lib/fixtures/index.ts';
import type { GraphPort, PeopleQuery } from '#lib/ports/graph.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type {
  Department,
  DepartmentId,
  Level,
  LevelId,
  Location,
  LocationId,
  Team,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';

/** `TL_ACTOR` named a worker the fixture tenant does not have. */
export class ActorNotFoundError extends TalentLoopsError {
  readonly worker_id: WorkerId;

  constructor(workerId: WorkerId) {
    super(
      'ACTOR_NOT_FOUND',
      `acting worker "${workerId}" is not in the fixture tenant. ` +
        'Set TL_ACTOR to a worker id from fixtures/tenant/identities.json, or unset it to use ' +
        'the default identity.',
    );
    this.name = 'ActorNotFoundError';
    this.worker_id = workerId;
  }
}

/**
 * Read-only Graph over fixtures. Every method returns a defensive copy so a caller cannot
 * mutate the shared bundle — Tier-1 data is the tenant's, not the engine's.
 */
export class FixtureGraphAdapter implements GraphPort {
  private readonly bundle: TenantBundle;
  private readonly actorWorkerId: WorkerId;

  constructor(bundle: TenantBundle, actorWorkerId: WorkerId) {
    this.bundle = bundle;
    this.actorWorkerId = actorWorkerId;
  }

  async lookupMe(): Promise<Worker> {
    const me = this.bundle.workers.find((w) => w.id === this.actorWorkerId);
    if (me === undefined) throw new ActorNotFoundError(this.actorWorkerId);
    return { ...me };
  }

  async lookupPerson(id: WorkerId): Promise<Worker | null> {
    const found = this.bundle.workers.find((w) => w.id === id);
    return found === undefined ? null : { ...found };
  }

  async lookupDirectReports(managerId: WorkerId): Promise<Worker[]> {
    return this.bundle.workers.filter((w) => w.manager_id === managerId).map((w) => ({ ...w }));
  }

  async searchPeople(q: PeopleQuery): Promise<Worker[]> {
    return this.bundle.workers
      .filter((w) => {
        if (q.department_id !== undefined && w.department_id !== q.department_id) return false;
        if (q.team_id !== undefined && w.team_id !== q.team_id) return false;
        if (q.level_id !== undefined && w.level_id !== q.level_id) return false;
        if (q.manager_id !== undefined && w.manager_id !== q.manager_id) return false;
        if (q.status !== undefined && w.status !== q.status) return false;
        if (q.job_function !== undefined && w.job_function !== q.job_function) return false;
        return true;
      })
      .map((w) => ({ ...w }));
  }

  async searchDepartments(): Promise<Department[]> {
    return this.bundle.departments.map((d) => ({ ...d }));
  }

  async getDepartment(id: DepartmentId): Promise<Department | null> {
    const found = this.bundle.departments.find((d) => d.id === id);
    return found === undefined ? null : { ...found };
  }

  async searchTeams(department_id?: DepartmentId): Promise<Team[]> {
    return this.bundle.teams
      .filter((t) => department_id === undefined || t.department_id === department_id)
      .map((t) => ({ ...t }));
  }

  async listLevels(): Promise<Level[]> {
    return this.bundle.levels.map((l) => ({ ...l }));
  }

  async getLevel(id: LevelId): Promise<Level | null> {
    const found = this.bundle.levels.find((l) => l.id === id);
    return found === undefined ? null : { ...found };
  }

  async getLocation(id: LocationId): Promise<Location | null> {
    const found = this.bundle.locations.find((l) => l.id === id);
    return found === undefined ? null : { ...found, work_hours: { ...found.work_hours } };
  }

  async listLocations(): Promise<Location[]> {
    return this.bundle.locations.map((l) => ({ ...l, work_hours: { ...l.work_hours } }));
  }
}
