/**
 * lib/adapters/fixture/ats.ts — requisitions, candidates, applications, headcount, documents.
 *
 * Owns: `FixtureAtsAdapter`, a read-only view over the fixture tenant's ATS tables plus
 * `readDocument`, the one door untrusted free text comes through. Every document it returns
 * carries `untrusted: true`; callers run `detectInstructionText` on the body and record a
 * `tl_anomaly` rather than obeying anything they find (spec §9).
 *
 * `createRequisition` and `createDraftHire` are deliberately absent in M1: both are optional
 * on `AtsPort`, and a runtime that does not implement them cannot accidentally perform them.
 *
 * Public interface: `FixtureAtsAdapter` (implements `AtsPort`), `DocumentNotFoundError`.
 *
 * Rippling calls this stands in for (see lib/ports/ats.ts): REST GET /ats/job-requisitions,
 * /ats/candidates/{id}, /ats/candidate-applications, /headcount-positions; the ATS surface is
 * REST-only (the MCP redacts candidates, requisitions and headcount).
 *
 * Spec: docs/SPEC.md §2, §3, §9; docs/PLAN.md §2.3.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import type { TenantBundle } from '#lib/fixtures/index.ts';
import type {
  ApplicationQuery,
  AtsPort,
  HeadcountPositionQuery,
  RequisitionQuery,
} from '#lib/ports/ats.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type {
  Application,
  ApplicationId,
  Candidate,
  CandidateId,
  HeadcountPosition,
  HeadcountPositionId,
  JobRequisition,
  JobRequisitionId,
  UntrustedDocument,
  UntrustedSource,
} from '#lib/types/tier1.ts';

/** A document ref resolved to nothing inside the fixtures dir. */
export class DocumentNotFoundError extends TalentLoopsError {
  readonly ref: string;

  constructor(ref: string) {
    super('DOCUMENT_NOT_FOUND', `no document at ref "${ref}" under the fixtures directory`);
    this.name = 'DocumentNotFoundError';
    this.ref = ref;
  }
}

/** Directory prefix → the `UntrustedDocument.source` it carries. */
const SOURCE_BY_PREFIX: readonly [string, UntrustedSource][] = [
  ['resumes/', 'resume'],
  ['scorecards/', 'scorecard'],
  ['reviews/', 'review'],
  ['slack/', 'slack'],
];

function sourceForRef(ref: string): UntrustedSource {
  for (const [prefix, source] of SOURCE_BY_PREFIX) {
    if (ref.startsWith(prefix)) return source;
  }
  return 'resume';
}

export class FixtureAtsAdapter implements AtsPort {
  private readonly bundle: TenantBundle;
  private readonly fixturesDir: string;

  constructor(bundle: TenantBundle, fixturesDir: string) {
    this.bundle = bundle;
    this.fixturesDir = resolve(fixturesDir);
  }

  async getRequisition(id: JobRequisitionId): Promise<JobRequisition | null> {
    const found = this.bundle.job_requisitions.find((r) => r.id === id);
    return found === undefined ? null : { ...found, criteria: [...found.criteria] };
  }

  async listRequisitions(q: RequisitionQuery): Promise<JobRequisition[]> {
    return this.bundle.job_requisitions
      .filter((r) => {
        if (q.status !== undefined && r.status !== q.status) return false;
        if (q.department_id !== undefined && r.department_id !== q.department_id) return false;
        return true;
      })
      .map((r) => ({ ...r, criteria: [...r.criteria] }));
  }

  async getCandidate(id: CandidateId): Promise<Candidate | null> {
    const found = this.bundle.candidates.find((c) => c.id === id);
    return found === undefined ? null : { ...found };
  }

  async getApplication(id: ApplicationId): Promise<Application | null> {
    const found = this.bundle.applications.find((a) => a.id === id);
    return found === undefined ? null : { ...found };
  }

  async listApplications(q: ApplicationQuery): Promise<Application[]> {
    return this.bundle.applications
      .filter((a) => {
        if (q.job_id !== undefined && a.job_id !== q.job_id) return false;
        if (q.status !== undefined && a.status !== q.status) return false;
        if (q.stage !== undefined && a.stage !== q.stage) return false;
        return true;
      })
      .map((a) => ({ ...a }));
  }

  async listHeadcountPositions(q: HeadcountPositionQuery): Promise<HeadcountPosition[]> {
    return this.bundle.headcount_positions
      .filter((p) => {
        if (q.department_id !== undefined && p.department_id !== q.department_id) return false;
        if (q.status !== undefined && p.status !== q.status) return false;
        return true;
      })
      .map((p) => ({ ...p }));
  }

  async getHeadcountPosition(id: HeadcountPositionId): Promise<HeadcountPosition | null> {
    const found = this.bundle.headcount_positions.find((p) => p.id === id);
    return found === undefined ? null : { ...found };
  }

  /**
   * Résumé and attachment bodies. Served from the loaded bundle when the ref is one of the
   * generated résumés, otherwise read from a path *inside* the fixtures directory — a ref
   * that escapes it (absolute, or containing `..`) is refused rather than followed.
   */
  async readDocument(ref: string): Promise<UntrustedDocument> {
    const fromBundle = this.bundle.resumes[ref];
    if (fromBundle !== undefined) {
      return { ref, text: fromBundle, source: sourceForRef(ref), untrusted: true };
    }

    if (typeof ref !== 'string' || ref.length === 0 || isAbsolute(ref)) {
      throw new DocumentNotFoundError(String(ref));
    }
    const normalized = normalize(ref);
    if (normalized.startsWith('..' + sep) || normalized === '..') {
      throw new DocumentNotFoundError(ref);
    }
    const path = join(this.fixturesDir, normalized);
    if (!path.startsWith(this.fixturesDir + sep) || !existsSync(path)) {
      throw new DocumentNotFoundError(ref);
    }
    return {
      ref,
      text: readFileSync(path, 'utf8'),
      source: sourceForRef(ref),
      untrusted: true,
    };
  }
}
