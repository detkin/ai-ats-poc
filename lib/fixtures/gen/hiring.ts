/**
 * lib/fixtures/gen/hiring.ts — headcount plan, requisitions, candidates, applications.
 *
 * Owns: the ATS side of the fixture tenant. The pipeline is laid out by hand because the
 * demos depend on exact rows: four ACTIVE candidates at `Onsite` on `req_staff_eng`
 * (loop 2), seven candidates rejected at `Onsite`/`Offer` on a requisition closed on
 * 2026-05-01 (loop 4's silver medalists), one HIRED, two referrals, and an off-plan
 * requisition with no headcount position (loop 3).
 *
 * Public interface: `HEADCOUNT_POSITIONS`, `REQUISITIONS`, `REQ_IDS`, `generateCandidates`,
 * `generateApplications`, `APPLICATION_SPECS`, `INJECTED_RESUME_CANDIDATES`.
 *
 * Spec: docs/SPEC.md §3 (Tier 1 read-only), §8 loops 2–4; docs/PLAN.md §2.1, §3 B0.4.
 */

import type {
  Application,
  ApplicationStatus,
  Candidate,
  CandidateSource,
  HeadcountPosition,
  JobRequisition,
} from '#lib/types/tier1.ts';
import { PINNED } from '#lib/fixtures/gen/catalog.ts';
import { ANCHOR_DATE, EMAIL_DOMAIN } from '#lib/fixtures/gen/bundle.ts';
import { instantAt, toDayNumber, fromDayNumber } from '#lib/fixtures/gen/dates.ts';
import {
  CANDIDATE_FAMILY_NAMES,
  CANDIDATE_GIVEN_NAMES,
  emailLocalPart,
} from '#lib/fixtures/gen/names.ts';
import type { Rng } from '#lib/fixtures/gen/rng.ts';

export const REQ_IDS = {
  staff_eng: 'req_staff_eng',
  ae: 'req_ae',
  designer: 'req_designer',
  senior_eng_closed: 'req_senior_eng_closed',
} as const;

/** Design's team lead is w_0014 (eighth team in `TEAM_SPECS`); Sales' is w_0015. */
const DESIGN_LEAD = 'w_0014';

export const HEADCOUNT_POSITIONS: HeadcountPosition[] = [
  {
    id: 'hcp_0001',
    department_id: 'dept_eng',
    level_id: 'lvl_L6',
    title: 'Staff Software Engineer',
    status: 'OPEN',
    job_requisition_id: REQ_IDS.staff_eng,
    recruiter_id: PINNED.recruiter,
    plan_quarter: '2026-Q3',
  },
  {
    id: 'hcp_0002',
    department_id: 'dept_sales',
    level_id: 'lvl_L4',
    title: 'Account Executive',
    status: 'OPEN',
    job_requisition_id: REQ_IDS.ae,
    recruiter_id: PINNED.recruiter,
    plan_quarter: '2026-Q3',
  },
  {
    id: 'hcp_0003',
    department_id: 'dept_eng',
    level_id: 'lvl_L5',
    title: 'Senior Software Engineer',
    status: 'FILLED',
    job_requisition_id: REQ_IDS.senior_eng_closed,
    recruiter_id: PINNED.recruiter,
    plan_quarter: '2026-Q1',
  },
  {
    id: 'hcp_0004',
    department_id: 'dept_product',
    level_id: 'lvl_L5',
    title: 'Senior Product Manager',
    status: 'PLANNED',
    job_requisition_id: null,
    recruiter_id: PINNED.recruiter,
    plan_quarter: '2026-Q4',
  },
  {
    id: 'hcp_0005',
    department_id: 'dept_eng',
    level_id: 'lvl_L4',
    title: 'Software Engineer II',
    status: 'PLANNED',
    job_requisition_id: null,
    recruiter_id: PINNED.recruiter,
    plan_quarter: '2026-Q4',
  },
  {
    id: 'hcp_0006',
    department_id: 'dept_cs',
    level_id: 'lvl_L4',
    title: 'Customer Success Manager',
    status: 'PLANNED',
    job_requisition_id: null,
    recruiter_id: PINNED.recruiter,
    plan_quarter: '2026-Q4',
  },
];

export const REQUISITIONS: JobRequisition[] = [
  {
    id: REQ_IDS.staff_eng,
    title: 'Staff Software Engineer',
    department_id: 'dept_eng',
    level_id: 'lvl_L6',
    job_function: 'engineering',
    location_id: 'loc_sf',
    hiring_manager_id: PINNED.hiring_manager,
    recruiter_id: PINNED.recruiter,
    status: 'OPEN',
    headcount_position_id: 'hcp_0001',
    opened_at: '2026-07-06T16:00:00Z',
    criteria: [
      'Eight or more years building distributed backend systems',
      'Has owned a multi-region service through a migration',
      'Mentors senior engineers and reviews design documents',
      'Comfortable with Go or Rust and with PostgreSQL at scale',
    ],
  },
  {
    id: REQ_IDS.ae,
    title: 'Account Executive',
    department_id: 'dept_sales',
    level_id: 'lvl_L4',
    job_function: 'sales',
    location_id: 'loc_nyc',
    hiring_manager_id: PINNED.pto_manager_long,
    recruiter_id: PINNED.recruiter,
    status: 'OPEN',
    headcount_position_id: 'hcp_0002',
    opened_at: '2026-07-20T16:00:00Z',
    criteria: [
      'Three or more years closing mid-market SaaS deals',
      'Track record against a quota above $900k',
      'Experience selling into operations and facilities teams',
    ],
  },
  {
    id: REQ_IDS.designer,
    title: 'Product Designer',
    department_id: 'dept_design',
    level_id: 'lvl_L5',
    job_function: 'design',
    location_id: 'loc_remote_us',
    hiring_manager_id: DESIGN_LEAD,
    recruiter_id: PINNED.recruiter,
    status: 'OPEN',
    // Off-plan: no headcount position backs this requisition (loop 3's approval path).
    headcount_position_id: null,
    opened_at: '2026-08-10T16:00:00Z',
    criteria: [
      'Portfolio of shipped end-to-end product work',
      'Comfortable running research with industrial users',
      'Has contributed to a design system used by several teams',
    ],
  },
  {
    id: REQ_IDS.senior_eng_closed,
    title: 'Senior Software Engineer',
    department_id: 'dept_eng',
    level_id: 'lvl_L5',
    job_function: 'engineering',
    location_id: 'loc_sf',
    hiring_manager_id: PINNED.hiring_manager,
    recruiter_id: PINNED.recruiter,
    status: 'CLOSED',
    headcount_position_id: 'hcp_0003',
    opened_at: '2026-01-15T17:00:00Z',
    closed_at: '2026-05-01T16:00:00Z',
    criteria: [
      'Five or more years on production backend services',
      'Strong testing and code review habits',
      'Familiar with event-driven architectures',
    ],
  },
];

/** The two candidates whose résumés carry prompt-injection text (spec §9). */
export const INJECTED_RESUME_CANDIDATES = ['cand_0003', 'cand_0033'] as const;

/** Referrals are pinned so `generate.test.ts` can assert exactly two exist. */
const REFERRALS: Record<string, string> = {
  cand_0005: 'w_0025',
  cand_0012: 'w_0086',
};

const NON_REFERRAL_SOURCES: readonly CandidateSource[] = ['inbound', 'sourced', 'agency'];
const NON_REFERRAL_WEIGHTS = [50, 32, 18] as const;

export const CANDIDATE_COUNT = 40;

export function candidateId(oneBasedIndex: number): string {
  return `cand_${String(oneBasedIndex).padStart(4, '0')}`;
}

export function generateCandidates(rng: Rng): Candidate[] {
  const usedNames = new Set<string>();
  const usedEmails = new Set<string>();
  const candidates: Candidate[] = [];
  for (let i = 1; i <= CANDIDATE_COUNT; i += 1) {
    const id = candidateId(i);
    let first = rng.pick(CANDIDATE_GIVEN_NAMES);
    let last = rng.pick(CANDIDATE_FAMILY_NAMES);
    let guard = 0;
    while (usedNames.has(`${first} ${last}`) && guard < 50) {
      first = rng.pick(CANDIDATE_GIVEN_NAMES);
      last = rng.pick(CANDIDATE_FAMILY_NAMES);
      guard += 1;
    }
    usedNames.add(`${first} ${last}`);

    const base = `${emailLocalPart(first)}.${emailLocalPart(last)}`;
    let local = base;
    let suffix = 2;
    while (usedEmails.has(local)) {
      local = `${base}${suffix}`;
      suffix += 1;
    }
    usedEmails.add(local);

    const referrer = REFERRALS[id];
    const source: CandidateSource = referrer
      ? 'referral'
      : rng.weighted(NON_REFERRAL_SOURCES, NON_REFERRAL_WEIGHTS);
    candidates.push({
      id,
      first_name: first,
      last_name: last,
      email: `${local}@candidates.${EMAIL_DOMAIN}`,
      source,
      ...(referrer ? { referred_by_worker_id: referrer } : {}),
      resume_ref: `resumes/${id}.md`,
    });
  }
  return candidates;
}

interface ApplicationSpec {
  job_id: string;
  status: ApplicationStatus;
  stage: string;
  /** Inclusive window the `applied_at` date is drawn from. */
  applied_from: string;
  applied_to: string;
  /** Fixed close-out instant for rows whose outcome is dated by the requisition. */
  decided_at?: string;
}

function block(
  job_id: string,
  status: ApplicationStatus,
  stage: string,
  count: number,
  applied_from: string,
  applied_to: string,
  decided_at?: string,
): ApplicationSpec[] {
  return Array.from({ length: count }, () => ({
    job_id,
    status,
    stage,
    applied_from,
    applied_to,
    ...(decided_at ? { decided_at } : {}),
  }));
}

const CLOSED_DECIDED_AT = '2026-05-01T16:00:00Z';

/**
 * 44 applications over 40 candidates. Indices 40–43 reuse `cand_0001`…`cand_0004`, which
 * lands them on the closed requisition — so the four people now at `Onsite` on
 * `req_staff_eng` are returning applicants, which is the story loop 4 tells.
 */
export const APPLICATION_SPECS: ApplicationSpec[] = [
  // req_staff_eng — 14
  ...block(REQ_IDS.staff_eng, 'ACTIVE', 'Onsite', 4, '2026-07-08', '2026-07-24'),
  ...block(REQ_IDS.staff_eng, 'ACTIVE', 'Technical', 3, '2026-07-20', '2026-08-06'),
  ...block(REQ_IDS.staff_eng, 'ACTIVE', 'Phone Screen', 3, '2026-08-03', '2026-08-18'),
  ...block(REQ_IDS.staff_eng, 'ACTIVE', 'Applied', 2, '2026-08-17', '2026-08-28'),
  ...block(REQ_IDS.staff_eng, 'REJECTED', 'Rejected', 2, '2026-07-10', '2026-08-01'),
  // req_ae — 10
  ...block(REQ_IDS.ae, 'HIRED', 'Hired', 1, '2026-07-22', '2026-07-24', '2026-08-24T18:00:00Z'),
  ...block(REQ_IDS.ae, 'ACTIVE', 'Onsite', 2, '2026-07-24', '2026-08-05'),
  ...block(REQ_IDS.ae, 'ACTIVE', 'Phone Screen', 3, '2026-08-04', '2026-08-19'),
  ...block(REQ_IDS.ae, 'ACTIVE', 'Applied', 2, '2026-08-18', '2026-08-27'),
  ...block(REQ_IDS.ae, 'REJECTED', 'Rejected', 2, '2026-07-23', '2026-08-08'),
  // req_designer — 8
  ...block(REQ_IDS.designer, 'ACTIVE', 'Onsite', 1, '2026-08-11', '2026-08-14'),
  ...block(REQ_IDS.designer, 'ACTIVE', 'Technical', 2, '2026-08-12', '2026-08-20'),
  ...block(REQ_IDS.designer, 'ACTIVE', 'Applied', 3, '2026-08-19', '2026-08-28'),
  ...block(REQ_IDS.designer, 'ARCHIVED', 'Applied', 2, '2026-08-11', '2026-08-21'),
  // req_senior_eng_closed — 12 (the silver-medalist pool)
  ...block(
    REQ_IDS.senior_eng_closed,
    'REJECTED',
    'Onsite',
    4,
    '2026-02-02',
    '2026-03-06',
    CLOSED_DECIDED_AT,
  ),
  ...block(
    REQ_IDS.senior_eng_closed,
    'REJECTED',
    'Offer',
    3,
    '2026-02-09',
    '2026-03-13',
    CLOSED_DECIDED_AT,
  ),
  ...block(
    REQ_IDS.senior_eng_closed,
    'REJECTED',
    'Technical',
    3,
    '2026-02-16',
    '2026-03-20',
    CLOSED_DECIDED_AT,
  ),
  ...block(
    REQ_IDS.senior_eng_closed,
    'ARCHIVED',
    'Phone Screen',
    2,
    '2026-02-23',
    '2026-03-20',
    CLOSED_DECIDED_AT,
  ),
];

const REJECTION_REASONS = [
  'Stronger profiles at this stage',
  'Depth of distributed systems experience',
  'Requisition closed before a decision',
  'Compensation expectations outside the band',
  'Withdrew for timing reasons',
] as const;

export function generateApplications(rng: Rng): Application[] {
  const anchorDay = toDayNumber(ANCHOR_DATE);
  return APPLICATION_SPECS.map((spec, index) => {
    const candidateIndex = index < CANDIDATE_COUNT ? index + 1 : index - CANDIDATE_COUNT + 1;
    const appliedDay = rng.int(toDayNumber(spec.applied_from), toDayNumber(spec.applied_to));
    const appliedAt = instantAt(fromDayNumber(appliedDay), 15, 30);
    const drift = rng.int(3, 25);
    const updatedDay = Math.min(appliedDay + drift, anchorDay - 1);
    const updatedAt = spec.decided_at ?? instantAt(fromDayNumber(updatedDay), 17);
    const needsReason = spec.status === 'REJECTED';
    const reason = REJECTION_REASONS[index % REJECTION_REASONS.length] ?? REJECTION_REASONS[0];
    return {
      id: `app_${String(index + 1).padStart(4, '0')}`,
      candidate_id: candidateId(candidateIndex),
      job_id: spec.job_id,
      status: spec.status,
      stage: spec.stage,
      applied_at: appliedAt,
      updated_at: updatedAt,
      ...(needsReason ? { rejected_reason: reason } : {}),
    };
  });
}
