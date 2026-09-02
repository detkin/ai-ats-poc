/**
 * lib/adapters/rippling/mcp.ts — the Rippling MCP surface, as stubs that fail loudly.
 *
 * Owns:
 *  1. `RipplingNotConnectedError` — thrown by every call in this family. It names the exact
 *     Rippling function that would have been called and points at `docs/QUESTIONS.md`, so a
 *     failure reads as "connect the tenant", never as "the POC is broken".
 *  2. `codemode` — all 31 `codemode.*` functions the Rippling MCP exposes through its single
 *     `code` tool (docs/research/rippling-06-api-mcp-surface.md), by their real names, so the
 *     day a tenant exists the bodies are the only thing that changes.
 *  3. `RipplingGraph`, `RipplingAvailability`, `RipplingState`, `RipplingLedger` — the ports
 *     the MCP would back (people/org, absence, custom objects). `MCP_BACKING` records which
 *     `codemode.*` function each method maps to; it is the map the docs and the tests read.
 *
 * `delete_custom_record` is in the stub list because Rippling has it — and appears in no
 * port's backing map, because engine state is corrected by update, never deleted (spec §9).
 * `tests/adapters/rippling.test.ts` asserts that stays true.
 *
 * Public interface: `RipplingNotConnectedError`, `CODEMODE_FUNCTIONS`, `CodemodeFunction`,
 * `codemode`, `MCP_BACKING`, `RipplingGraph`, `RipplingAvailability`, `RipplingState`,
 * `RipplingLedger`.
 *
 * Spec: docs/SPEC.md §2, §9, §11; docs/PLAN.md §2.3, §4 block B1.2; docs/QUESTIONS.md Q2.
 */

import type {
  AbsenceAnswer,
  AvailabilityPort,
  HoldInput,
  HoldResult,
  QuietHoursAnswer,
  Slot,
  SlotQuery,
} from '#lib/ports/availability.ts';
import type { GraphPort, PeopleQuery } from '#lib/ports/graph.ts';
import type { LedgerPort, LedgerQuery } from '#lib/ports/ledger.ts';
import type { StateFilter, StatePort } from '#lib/ports/state.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type { NewLedgerEntry, TlAgentAction } from '#lib/types/engine.ts';
import type { NewRecord, RecordPatch, StateKind, StateRecordMap } from '#lib/types/engine.ts';
import type {
  Absence,
  DateISO,
  Department,
  DepartmentId,
  InstantISO,
  Level,
  LevelId,
  Location,
  LocationId,
  Team,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';

/** Where a reader is sent when a Rippling call is attempted with no tenant connected. */
export const RIPPLING_QUESTION_REF = 'docs/QUESTIONS.md Q2 (Rippling MCP / REST tenant)';

/**
 * No Rippling tenant is connected. Every `rippling` adapter method throws this; nothing in
 * this family ever returns a plausible-looking fake.
 */
export class RipplingNotConnectedError extends TalentLoopsError {
  /** The Rippling call that would have run, e.g. `codemode.lookup_me`. */
  readonly call: string;

  constructor(call: string, questionRef: string = RIPPLING_QUESTION_REF) {
    super(
      'RIPPLING_NOT_CONNECTED',
      `${call} needs a connected Rippling tenant. TL_ADAPTER=rippling has no credentials in ` +
        `this POC: run with TL_ADAPTER=fixture, or see ${questionRef} to connect one.`,
    );
    this.name = 'RipplingNotConnectedError';
    this.call = call;
  }
}

/**
 * The 31 functions the Rippling MCP's single `code` tool exposes
 * (docs/research/rippling-06-api-mcp-surface.md). Order follows the research note:
 * grounded read, people/org, time off, hiring, custom objects.
 */
export const CODEMODE_FUNCTIONS = [
  'ask_ai',
  'lookup_me',
  'lookup_person',
  'lookup_direct_reports',
  'search_people',
  'get_department_size',
  'search_departments',
  'search_teams',
  'search_work_locations',
  'search_legal_entities',
  'lookup_absence',
  'lookup_time_off_balance',
  'search_leave_types',
  'request_time_off',
  'create_draft_hire',
  'list_custom_objects',
  'list_custom_categories',
  'describe_custom_object',
  'list_custom_records',
  'lookup_custom_record',
  'search_custom_records',
  'create_custom_record',
  'update_custom_record',
  'delete_custom_record',
  'create_custom_field',
  'update_custom_field',
  'delete_custom_field',
  'create_custom_category',
  'update_custom_object',
  'delete_custom_object',
  'setup_custom_object',
] as const;

export type CodemodeFunction = (typeof CODEMODE_FUNCTIONS)[number];

function stub(name: CodemodeFunction): (...args: unknown[]) => never {
  return (..._args: unknown[]): never => {
    throw new RipplingNotConnectedError(`codemode.${name}`);
  };
}

/**
 * The `codemode.*` namespace, stubbed. Present so call sites are written against the real
 * names today and so `bin/doctor.mjs` can report the surface that exists.
 */
export const codemode: Record<CodemodeFunction, (...args: unknown[]) => never> = Object.fromEntries(
  CODEMODE_FUNCTIONS.map((name) => [name, stub(name)]),
) as Record<CodemodeFunction, (...args: unknown[]) => never>;

/** Port method → the `codemode.*` function that would serve it. */
export const MCP_BACKING = {
  graph: {
    lookupMe: 'codemode.lookup_me',
    lookupPerson: 'codemode.lookup_person',
    lookupDirectReports: 'codemode.lookup_direct_reports',
    searchPeople: 'codemode.search_people',
    searchDepartments: 'codemode.search_departments',
    getDepartment: 'codemode.get_department_size',
    searchTeams: 'codemode.search_teams',
    listLevels: 'REST GET /levels',
    getLevel: 'REST GET /levels/{id}',
    getLocation: 'codemode.search_work_locations',
    listLocations: 'codemode.search_work_locations',
  },
  availability: {
    absenceOn: 'codemode.lookup_absence',
    listAbsences: 'codemode.lookup_absence',
    quietHours: 'codemode.search_work_locations',
    findFreeSlots: 'google_calendar.freebusy.query',
    placeHold: 'google_calendar.events.insert',
  },
  state: {
    get: 'codemode.lookup_custom_record',
    list: 'codemode.list_custom_records',
    create: 'codemode.create_custom_record',
    update: 'codemode.update_custom_record',
  },
  ledger: {
    append: 'codemode.create_custom_record',
    list: 'codemode.search_custom_records',
  },
} as const;

export class RipplingGraph implements GraphPort {
  async lookupMe(): Promise<Worker> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.lookupMe);
  }
  async lookupPerson(_id: WorkerId): Promise<Worker | null> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.lookupPerson);
  }
  async lookupDirectReports(_managerId: WorkerId): Promise<Worker[]> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.lookupDirectReports);
  }
  async searchPeople(_q: PeopleQuery): Promise<Worker[]> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.searchPeople);
  }
  async searchDepartments(): Promise<Department[]> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.searchDepartments);
  }
  async getDepartment(_id: DepartmentId): Promise<Department | null> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.getDepartment);
  }
  async searchTeams(_departmentId?: DepartmentId): Promise<Team[]> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.searchTeams);
  }
  async listLevels(): Promise<Level[]> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.listLevels);
  }
  async getLevel(_id: LevelId): Promise<Level | null> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.getLevel);
  }
  async getLocation(_id: LocationId): Promise<Location | null> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.getLocation);
  }
  async listLocations(): Promise<Location[]> {
    throw new RipplingNotConnectedError(MCP_BACKING.graph.listLocations);
  }
}

export class RipplingAvailability implements AvailabilityPort {
  async absenceOn(_workerId: WorkerId, _dateISO: DateISO): Promise<AbsenceAnswer> {
    throw new RipplingNotConnectedError(MCP_BACKING.availability.absenceOn);
  }
  async listAbsences(
    _workerId: WorkerId,
    _range: { from: DateISO; to: DateISO },
  ): Promise<Absence[]> {
    throw new RipplingNotConnectedError(MCP_BACKING.availability.listAbsences);
  }
  async quietHours(_workerId: WorkerId, _instantISO: InstantISO): Promise<QuietHoursAnswer> {
    throw new RipplingNotConnectedError(MCP_BACKING.availability.quietHours);
  }
  async findFreeSlots(_workerIds: WorkerId[], _q: SlotQuery): Promise<Slot[]> {
    throw new RipplingNotConnectedError(
      MCP_BACKING.availability.findFreeSlots,
      'docs/QUESTIONS.md Q3 (Slack and Google Calendar)',
    );
  }
  async placeHold(_slot: Slot, _input: HoldInput): Promise<HoldResult> {
    throw new RipplingNotConnectedError(
      MCP_BACKING.availability.placeHold,
      'docs/QUESTIONS.md Q3 (Slack and Google Calendar)',
    );
  }
}

/** Engine state as Rippling custom objects. No delete: `StatePort` has none. */
export class RipplingState implements StatePort {
  async get<K extends StateKind>(_kind: K, _id: string): Promise<StateRecordMap[K] | null> {
    throw new RipplingNotConnectedError(MCP_BACKING.state.get);
  }
  async list<K extends StateKind>(
    _kind: K,
    _filter?: StateFilter<K>,
  ): Promise<StateRecordMap[K][]> {
    throw new RipplingNotConnectedError(MCP_BACKING.state.list);
  }
  async create<K extends StateKind>(
    _kind: K,
    _record: NewRecord<StateRecordMap[K]>,
  ): Promise<StateRecordMap[K]> {
    throw new RipplingNotConnectedError(MCP_BACKING.state.create);
  }
  async update<K extends StateKind>(
    _kind: K,
    _id: string,
    _patch: RecordPatch<StateRecordMap[K]>,
  ): Promise<StateRecordMap[K]> {
    throw new RipplingNotConnectedError(MCP_BACKING.state.update);
  }
}

export class RipplingLedger implements LedgerPort {
  async append(_entry: NewLedgerEntry): Promise<TlAgentAction> {
    throw new RipplingNotConnectedError(MCP_BACKING.ledger.append);
  }
  async list(_q: LedgerQuery): Promise<TlAgentAction[]> {
    throw new RipplingNotConnectedError(MCP_BACKING.ledger.list);
  }
}
