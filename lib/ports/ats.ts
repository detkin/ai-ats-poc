/**
 * lib/ports/ats.ts — requisitions, candidates, applications, headcount (Tier 1).
 *
 * Owns: `AtsPort`. Reads are the engine's only view of the real pipeline; it stores ids and
 * re-reads `status`/`stage` every tick rather than mirroring them (spec §3). The two write
 * methods are optional and land in M3 — `createDraftHire` is the one native staged action
 * Rippling exposes, `createRequisition` is REST-only.
 *
 * Public interface: `AtsPort`, `RequisitionQuery`, `ApplicationQuery`,
 * `HeadcountPositionQuery`, `DraftHireInput`, `RequisitionInput`.
 *
 * Rippling backing (research 06 — ATS is REST-only; MCP redacts candidates/reqs/headcount):
 *   getRequisition / listRequisitions   -> REST GET /ats/job-requisitions[/{id}]
 *   getCandidate                        -> REST GET /ats/candidates/{id}
 *   getApplication / listApplications   -> REST GET /ats/candidate-applications
 *   listHeadcountPositions / get…       -> REST GET /headcount-positions (expand=job_requisition,recruiter)
 *   readDocument                        -> résumé/attachment fetch (fixture file in the POC)
 *   createRequisition (M3)              -> REST POST /ats/job-requisitions  (scope job-requisitions-write)
 *   createDraftHire  (M3)               -> codemode.create_draft_hire | REST POST /draft-hires
 * There is no interview, scorecard, offer or pipeline-stage surface: that gap is Tier 3.
 *
 * Spec: docs/SPEC.md §2, §3, §8 loops 2–4; docs/PLAN.md §2.3, §2.4.
 */

import type {
  Application,
  ApplicationId,
  ApplicationStatus,
  Candidate,
  CandidateId,
  DateISO,
  DepartmentId,
  HeadcountPosition,
  HeadcountPositionId,
  HeadcountPositionStatus,
  JobFunction,
  JobRequisition,
  JobRequisitionId,
  LevelId,
  LocationId,
  RequisitionStatus,
  UntrustedDocument,
  WorkerId,
} from '#lib/types/tier1.ts';

export interface RequisitionQuery {
  status?: RequisitionStatus;
  department_id?: DepartmentId;
}

export interface ApplicationQuery {
  job_id?: JobRequisitionId;
  status?: ApplicationStatus;
  /** Real ATS stage string; free text in Rippling. */
  stage?: string;
}

export interface HeadcountPositionQuery {
  department_id?: DepartmentId;
  status?: HeadcountPositionStatus;
}

/** M3. Mirrors REST `POST /ats/job-requisitions`. */
export interface RequisitionInput {
  title: string;
  department_id: DepartmentId;
  level_id: LevelId;
  job_function: JobFunction;
  location_id: LocationId;
  hiring_manager_id: WorkerId;
  recruiter_id: WorkerId;
  headcount_position_id: HeadcountPositionId | null;
  criteria: string[];
}

/** M3. Mirrors `codemode.create_draft_hire` — creates a draft for human review, not a hire. */
export interface DraftHireInput {
  candidate_id: CandidateId;
  application_id: ApplicationId;
  job_requisition_id: JobRequisitionId;
  start_date: DateISO;
}

export interface AtsPort {
  getRequisition(id: JobRequisitionId): Promise<JobRequisition | null>;
  listRequisitions(q: RequisitionQuery): Promise<JobRequisition[]>;
  getCandidate(id: CandidateId): Promise<Candidate | null>;
  getApplication(id: ApplicationId): Promise<Application | null>;
  listApplications(q: ApplicationQuery): Promise<Application[]>;
  listHeadcountPositions(q: HeadcountPositionQuery): Promise<HeadcountPosition[]>;
  getHeadcountPosition(id: HeadcountPositionId): Promise<HeadcountPosition | null>;
  /** Résumés and attachments. Always untrusted: data, never instructions (spec §9). */
  readDocument(ref: string): Promise<UntrustedDocument>;

  /** M3, not on the write allowlist — a requisition create is a decision of record. */
  createRequisition?(input: RequisitionInput): Promise<JobRequisition>;
  /** M3. The one allowlisted ATS write (spec §9); still lands as a draft for a human. */
  createDraftHire?(input: DraftHireInput): Promise<{ draft_hire_ref: string }>;
}
