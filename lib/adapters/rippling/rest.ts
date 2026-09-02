/**
 * lib/adapters/rippling/rest.ts — the Rippling REST surface, as stubs that fail loudly.
 *
 * Owns: `REST_BASE_URL`, `REST_RESOURCES` (the paths the POC would call, from
 * docs/research/rippling-06-api-mcp-surface.md), `REST_BACKING` (port method → request), and
 * the two ports Rippling serves only over REST — `RipplingAts` and `RipplingBands`. The MCP
 * redacts candidates, applications, requisitions, headcount and compensation by design, so
 * these can never move to `codemode.*`.
 *
 * Every method throws `RipplingNotConnectedError` naming its request. `createRequisition` is
 * present and *not* on the write allowlist: opening a req is a decision of record and goes
 * through `bin/propose.mjs`. `createDraftHire` is the one allowlisted ATS write (spec §9) and
 * lands in M3, when a tenant exists.
 *
 * Public interface: `REST_BASE_URL`, `REST_RESOURCES`, `REST_BACKING`, `RipplingAts`,
 * `RipplingBands`.
 *
 * Spec: docs/SPEC.md §2, §9; docs/PLAN.md §2.3; docs/QUESTIONS.md Q2.
 */

import { RipplingNotConnectedError } from '#lib/adapters/rippling/mcp.ts';
import type {
  ApplicationQuery,
  AtsPort,
  DraftHireInput,
  HeadcountPositionQuery,
  RequisitionInput,
  RequisitionQuery,
} from '#lib/ports/ats.ts';
import type { BandQuery, BandsPort, WorkerCompensation } from '#lib/ports/bands.ts';
import type {
  Application,
  ApplicationId,
  Candidate,
  CandidateId,
  CompBand,
  HeadcountPosition,
  HeadcountPositionId,
  JobRequisition,
  JobRequisitionId,
  UntrustedDocument,
  WorkerId,
} from '#lib/types/tier1.ts';

/** Rippling Platform API base (research 06). */
export const REST_BASE_URL = 'https://rest.ripplingapis.com';

/** The REST resources the POC's read paths need. */
export const REST_RESOURCES = {
  workers: '/workers',
  job_requisitions: '/ats/job-requisitions',
  candidates: '/ats/candidates',
  candidate_applications: '/ats/candidate-applications',
  headcount_positions: '/headcount-positions',
  compensation_bands: '/compensation-bands',
  draft_hires: '/draft-hires',
  documents: '/ats/documents',
} as const;

/** Port method → the REST request that would serve it. */
export const REST_BACKING = {
  ats: {
    getRequisition: `GET ${REST_RESOURCES.job_requisitions}/{id}`,
    listRequisitions: `GET ${REST_RESOURCES.job_requisitions}`,
    getCandidate: `GET ${REST_RESOURCES.candidates}/{id}`,
    getApplication: `GET ${REST_RESOURCES.candidate_applications}/{id}`,
    listApplications: `GET ${REST_RESOURCES.candidate_applications}`,
    listHeadcountPositions: `GET ${REST_RESOURCES.headcount_positions}?expand=job_requisition,recruiter`,
    getHeadcountPosition: `GET ${REST_RESOURCES.headcount_positions}/{id}`,
    readDocument: `GET ${REST_RESOURCES.documents}/{ref}`,
    createRequisition: `POST ${REST_RESOURCES.job_requisitions}`,
    createDraftHire: `POST ${REST_RESOURCES.draft_hires}`,
  },
  bands: {
    listBands: `GET ${REST_RESOURCES.compensation_bands}`,
    findBand: `GET ${REST_RESOURCES.compensation_bands}`,
    getWorkerCompensation: `GET ${REST_RESOURCES.workers}/{id}?expand=compensation`,
  },
} as const;

export class RipplingAts implements AtsPort {
  async getRequisition(_id: JobRequisitionId): Promise<JobRequisition | null> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.getRequisition);
  }
  async listRequisitions(_q: RequisitionQuery): Promise<JobRequisition[]> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.listRequisitions);
  }
  async getCandidate(_id: CandidateId): Promise<Candidate | null> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.getCandidate);
  }
  async getApplication(_id: ApplicationId): Promise<Application | null> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.getApplication);
  }
  async listApplications(_q: ApplicationQuery): Promise<Application[]> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.listApplications);
  }
  async listHeadcountPositions(_q: HeadcountPositionQuery): Promise<HeadcountPosition[]> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.listHeadcountPositions);
  }
  async getHeadcountPosition(_id: HeadcountPositionId): Promise<HeadcountPosition | null> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.getHeadcountPosition);
  }
  async readDocument(_ref: string): Promise<UntrustedDocument> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.readDocument);
  }
  /** M3. Not allowlisted: a requisition create is a decision of record. */
  async createRequisition(_input: RequisitionInput): Promise<JobRequisition> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.createRequisition);
  }
  /** M3. The one allowlisted ATS write; still lands as a draft for a human. */
  async createDraftHire(_input: DraftHireInput): Promise<{ draft_hire_ref: string }> {
    throw new RipplingNotConnectedError(REST_BACKING.ats.createDraftHire);
  }
}

export class RipplingBands implements BandsPort {
  async listBands(): Promise<CompBand[]> {
    throw new RipplingNotConnectedError(REST_BACKING.bands.listBands);
  }
  async findBand(_q: BandQuery): Promise<CompBand | null> {
    throw new RipplingNotConnectedError(REST_BACKING.bands.findBand);
  }
  async getWorkerCompensation(_workerId: WorkerId): Promise<WorkerCompensation> {
    throw new RipplingNotConnectedError(REST_BACKING.bands.getWorkerCompensation);
  }
}
