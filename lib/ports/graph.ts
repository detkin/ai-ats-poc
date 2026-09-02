/**
 * lib/ports/graph.ts — the people graph (Tier 1, read-only).
 *
 * Owns: `GraphPort`, the only way the engine learns about workers, departments, teams,
 * levels and locations. Never mutates.
 *
 * Public interface: `GraphPort`, `PeopleQuery`.
 *
 * Rippling backing (research 06):
 *   lookupMe            -> codemode.lookup_me
 *   lookupPerson        -> codemode.lookup_person             | REST GET /workers/{id}?expand=employment,compensation
 *   lookupDirectReports -> codemode.lookup_direct_reports
 *   searchPeople        -> codemode.search_people             | REST GET /workers
 *   searchDepartments   -> codemode.search_departments        | REST GET /departments
 *   getDepartment       -> codemode.get_department_size + search_departments | REST GET /departments/{id}
 *   searchTeams         -> codemode.search_teams              | REST GET /teams
 *   listLevels/getLevel -> REST GET /levels                   (no codemode equivalent)
 *   listLocations/getLocation -> codemode.search_work_locations | REST GET /work-locations
 *
 * Spec: docs/SPEC.md §2, §3 (tier 1), §8 loop 1; docs/PLAN.md §2.3.
 */

import type {
  Department,
  DepartmentId,
  JobFunction,
  Level,
  LevelId,
  Location,
  LocationId,
  Team,
  TeamId,
  Worker,
  WorkerId,
  WorkerStatus,
} from '#lib/types/tier1.ts';

/** All fields are AND-ed. An empty query returns every worker the actor may read. */
export interface PeopleQuery {
  department_id?: DepartmentId;
  team_id?: TeamId;
  level_id?: LevelId;
  manager_id?: WorkerId;
  status?: WorkerStatus;
  job_function?: JobFunction;
}

export interface GraphPort {
  /** The acting user's own worker record. */
  lookupMe(): Promise<Worker>;
  lookupPerson(id: WorkerId): Promise<Worker | null>;
  lookupDirectReports(managerId: WorkerId): Promise<Worker[]>;
  searchPeople(q: PeopleQuery): Promise<Worker[]>;
  searchDepartments(): Promise<Department[]>;
  getDepartment(id: DepartmentId): Promise<Department | null>;
  searchTeams(department_id?: DepartmentId): Promise<Team[]>;
  listLevels(): Promise<Level[]>;
  getLevel(id: LevelId): Promise<Level | null>;
  getLocation(id: LocationId): Promise<Location | null>;
  listLocations(): Promise<Location[]>;
}
