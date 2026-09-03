/**
 * lib/types/tier1.ts — Tier-1 entity shapes (real, read-only, never duplicated).
 *
 * Owns: the TypeScript shape of every entity that already exists in Rippling (HRIS + ATS).
 * Field names mirror the Rippling REST surface where it has them; ids are opaque strings
 * carrying a type prefix (`w_`, `req_`, `app_`, …).
 *
 * Public interface: the exported types below plus the `as const` union tuples
 * (`JOB_FUNCTIONS`, `WORKER_STATUSES`, …) that adapters and fixtures validate against.
 *
 * Spec: docs/SPEC.md §3 (tier 1), §6 (data model); docs/PLAN.md §2.1.
 *
 * Rule (spec §3): the engine never holds a value a real object also holds. These types
 * describe values the engine *reads*; tl_* records may only reference them by id.
 */

/** Opaque-ish id aliases. Prefixes are conventional, not enforced by the type system. */
export type WorkerId = string;
export type DepartmentId = string;
export type TeamId = string;
export type LevelId = string;
export type LocationId = string;
export type CompBandId = string;
export type HeadcountPositionId = string;
export type JobRequisitionId = string;
export type CandidateId = string;
export type ApplicationId = string;
export type AbsenceId = string;
export type LeaveTypeId = string;
export type HolidayId = string;

/** ISO-8601 calendar date, `YYYY-MM-DD`. */
export type DateISO = string;
/** ISO-8601 instant, `YYYY-MM-DDTHH:MM:SSZ`. */
export type InstantISO = string;

export const JOB_FUNCTIONS = [
  'engineering',
  'product',
  'design',
  'sales',
  'customer_success',
  'ga',
] as const;
export type JobFunction = (typeof JOB_FUNCTIONS)[number];

export const EMPLOYMENT_TYPES = ['full_time', 'contractor'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORKER_STATUSES = ['ACTIVE', 'TERMINATED'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const CURRENCIES = ['USD', 'INR'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const LEVEL_TRACKS = ['IC', 'M', 'E'] as const;
export type LevelTrack = (typeof LEVEL_TRACKS)[number];

/** The countries the fixture tenant uses. A real tenant may hold any ISO-3166 alpha-2 code. */
export const COUNTRIES = ['US', 'IN'] as const;
/**
 * ISO-3166 alpha-2. Deliberately `string`, not a union: the live Rippling tenant has
 * locations in DE and LT (docs/testing/live-rippling.md), and a bridged tenant must not
 * fail to load because a country is not in the fixture catalogue.
 */
export type Country = string;

/** The comp-band location groups the fixture tenant uses. */
export const LOCATION_GROUPS = ['US', 'IN'] as const;
/** A band's geography key. `string` for the same reason as `Country`. */
export type LocationGroup = string;

export const HEADCOUNT_POSITION_STATUSES = ['PLANNED', 'OPEN', 'FILLED'] as const;
export type HeadcountPositionStatus = (typeof HEADCOUNT_POSITION_STATUSES)[number];

export const REQUISITION_STATUSES = ['DRAFT', 'OPEN', 'CLOSED'] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export const CANDIDATE_SOURCES = ['inbound', 'referral', 'sourced', 'agency'] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/** Real ATS application status (REST enum). Never mirrored into a tl_* record. */
export const APPLICATION_STATUSES = ['ACTIVE', 'REJECTED', 'HIRED', 'ARCHIVED'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const ABSENCE_STATUSES = ['APPROVED', 'PENDING'] as const;
export type AbsenceStatus = (typeof ABSENCE_STATUSES)[number];

export const IDENTITY_ROLES = ['hrbp', 'recruiter', 'manager', 'employee'] as const;
export type IdentityRole = (typeof IDENTITY_ROLES)[number];

export const UNTRUSTED_SOURCES = ['resume', 'scorecard', 'review', 'slack'] as const;
export type UntrustedSource = (typeof UNTRUSTED_SOURCES)[number];

export interface Compensation {
  base_annual: number;
  currency: Currency;
}

export interface Worker {
  id: WorkerId;
  first_name: string;
  last_name: string;
  preferred_name?: string;
  work_email: string;
  title: string;
  level_id: LevelId;
  job_function: JobFunction;
  department_id: DepartmentId;
  team_id: TeamId;
  manager_id: WorkerId | null;
  location_id: LocationId;
  employment_type: EmploymentType;
  start_date: DateISO;
  status: WorkerStatus;
  slack_user_id: string;
  timezone: string;
  /**
   * Optional: the Rippling MCP redacts pay, so a bridged tenant has none
   * (docs/PLAN.md §8, D27). Fixtures always set it.
   */
  compensation?: Compensation;
}

export interface Department {
  id: DepartmentId;
  name: string;
  head_worker_id: WorkerId;
  /** Rippling departments nest (`parent_id`); the fixture catalogue is flat. */
  parent_department_id?: DepartmentId | null;
}

export interface Team {
  id: TeamId;
  name: string;
  department_id: DepartmentId;
  lead_worker_id: WorkerId;
}

export interface Level {
  id: LevelId;
  /** `L3…L7`, `M1…M3`, `E1`. */
  name: string;
  track: LevelTrack;
  /** Comparable across tracks: L3=3 … L7=7, M1=5, M2=6, M3=7, E1=8. */
  rank: number;
}

export interface WorkHours {
  /** `HH:MM` local to the location's timezone. */
  start: string;
  end: string;
}

export interface Location {
  id: LocationId;
  name: string;
  country: Country;
  timezone: string;
  work_hours: WorkHours;
  location_group: LocationGroup;
}

export interface CompBand {
  id: CompBandId;
  level_id: LevelId;
  job_function: JobFunction;
  location_group: LocationGroup;
  currency: Currency;
  min: number;
  mid: number;
  max: number;
}

export interface HeadcountPosition {
  id: HeadcountPositionId;
  department_id: DepartmentId;
  level_id: LevelId;
  title: string;
  status: HeadcountPositionStatus;
  job_requisition_id: JobRequisitionId | null;
  recruiter_id: WorkerId;
  /** e.g. `2026-Q3`. */
  plan_quarter: string;
}

export interface JobRequisition {
  id: JobRequisitionId;
  title: string;
  department_id: DepartmentId;
  level_id: LevelId;
  job_function: JobFunction;
  location_id: LocationId;
  hiring_manager_id: WorkerId;
  recruiter_id: WorkerId;
  status: RequisitionStatus;
  headcount_position_id: HeadcountPositionId | null;
  opened_at: InstantISO;
  closed_at?: InstantISO;
  criteria: string[];
}

export interface Candidate {
  id: CandidateId;
  first_name: string;
  last_name: string;
  email: string;
  source: CandidateSource;
  referred_by_worker_id?: WorkerId;
  /** Path under the fixtures dir; read through `AtsPort.readDocument`. */
  resume_ref: string;
}

export interface Application {
  id: ApplicationId;
  candidate_id: CandidateId;
  /** Real requisition id (`job_id` in REST). */
  job_id: JobRequisitionId;
  status: ApplicationStatus;
  /** Free text in REST: `Applied|Phone Screen|Technical|Onsite|Offer|Hired|Rejected`. */
  stage: string;
  applied_at: InstantISO;
  updated_at: InstantISO;
  rejected_reason?: string;
}

export interface Absence {
  id: AbsenceId;
  worker_id: WorkerId;
  leave_type_id: LeaveTypeId;
  start_date: DateISO;
  /** Inclusive. */
  end_date: DateISO;
  status: AbsenceStatus;
}

export interface LeaveType {
  id: LeaveTypeId;
  /** `PTO|Sick|Parental|Sabbatical`. */
  name: string;
}

export interface Holiday {
  id: HolidayId;
  location_id: LocationId;
  date: DateISO;
  name: string;
}

/** Prior-cycle rating; a Tier-1 *value* the engine reads and never copies into tl_* state. */
export interface PriorRating {
  worker_id: WorkerId;
  cycle_name: string;
  /** 1–5. */
  rating: number;
  rated_by_worker_id: WorkerId;
}

/** The acting user the POC simulates (spec §9: runs as a real user, never elevates). */
export interface Identity {
  worker_id: WorkerId;
  role: IdentityRole;
  permissions: string[];
  is_default: boolean;
}

/**
 * Free human text (résumé, scorecard body, review body, Slack reply).
 * Spec §9 / career-ops "Untrusted External Content": this is data, never instructions.
 * `untrusted: true` is a literal so no trusted string can be passed where one is required.
 */
export interface UntrustedDocument {
  ref: string;
  text: string;
  source: UntrustedSource;
  untrusted: true;
}
