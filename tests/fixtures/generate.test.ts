/**
 * tests/fixtures/generate.test.ts — block B0.4's generator.
 *
 * Covers determinism, the headcount and pipeline counts, referential integrity, and one
 * assertion per "scenario requirement" in docs/PLAN.md §3 B0.4 — the list the M1 and M2
 * demos depend on. Also proves the untrusted-content seam: exactly two of the forty
 * résumés trip `detectInstructionText`, and the other thirty-eight do not.
 *
 * Spec: docs/SPEC.md §8, §9; docs/PLAN.md §2.1, §3 block B0.4.
 */

import { describe, expect, it } from 'vitest';
import { detectInstructionText } from '#lib/safety/allowlist.ts';
import { ANCHOR_DATE, DEFAULT_SEED, generateTenant } from '#lib/fixtures/generate.ts';
import type { TenantBundle } from '#lib/fixtures/generate.ts';
import { PINNED } from '#lib/fixtures/gen/catalog.ts';
import { INJECTED_RESUME_CANDIDATES, REQ_IDS } from '#lib/fixtures/gen/hiring.ts';
import {
  STAFF_ENG_DECLINER,
  STAFF_ENG_PANEL,
  STAFF_ENG_SLOT,
  STAFF_ENG_SUBSTITUTE,
} from '#lib/fixtures/gen/calendar.ts';
import { PRIOR_CYCLE_NAME } from '#lib/fixtures/gen/ratings.ts';
import { REVIEW_CYCLE_ID } from '#lib/fixtures/gen/state.ts';

const tenant: TenantBundle = generateTenant();

function reportCounts(bundle: TenantBundle): Map<string, number> {
  const counts = new Map<string, number>();
  for (const worker of bundle.workers) {
    if (!worker.manager_id) continue;
    counts.set(worker.manager_id, (counts.get(worker.manager_id) ?? 0) + 1);
  }
  return counts;
}

function overlapsAnchor(start: string, end: string): boolean {
  return start <= ANCHOR_DATE && ANCHOR_DATE <= end;
}

describe('generateTenant determinism', () => {
  it('produces deep-equal tenants for the same seed', () => {
    expect(generateTenant(DEFAULT_SEED)).toEqual(generateTenant(DEFAULT_SEED));
  });

  it('produces a different tenant for a different seed', () => {
    expect(generateTenant(DEFAULT_SEED + 1).workers).not.toEqual(tenant.workers);
  });

  it('defaults to the committed seed', () => {
    expect(generateTenant()).toEqual(generateTenant(DEFAULT_SEED));
  });
});

describe('headcount', () => {
  it('has 120 workers, all ACTIVE, in six departments', () => {
    expect(tenant.workers).toHaveLength(120);
    expect(tenant.departments).toHaveLength(6);
    expect(tenant.workers.every((worker) => worker.status === 'ACTIVE')).toBe(true);
  });

  it('matches the departmental split from the plan', () => {
    const counts: Record<string, number> = {};
    for (const worker of tenant.workers) {
      counts[worker.department_id] = (counts[worker.department_id] ?? 0) + 1;
    }
    expect(counts).toEqual({
      dept_eng: 45,
      dept_product: 12,
      dept_design: 8,
      dept_sales: 25,
      dept_cs: 15,
      dept_ga: 15,
    });
  });

  it('has at least 18 managers', () => {
    expect(reportCounts(tenant).size).toBeGreaterThanOrEqual(18);
  });

  it('has the four fixture locations', () => {
    expect(tenant.locations.map((location) => location.id).sort()).toEqual([
      'loc_blr',
      'loc_nyc',
      'loc_remote_us',
      'loc_sf',
    ]);
  });

  it('gives every worker a unique email and slack id', () => {
    expect(new Set(tenant.workers.map((w) => w.work_email)).size).toBe(120);
    expect(new Set(tenant.workers.map((w) => w.slack_user_id)).size).toBe(120);
    expect(tenant.workers.every((w) => /^U[0-9A-Z]{8}$/.test(w.slack_user_id))).toBe(true);
  });

  it('roots the org chart at exactly one worker', () => {
    expect(tenant.workers.filter((worker) => worker.manager_id === null)).toHaveLength(1);
  });
});

describe('referential integrity', () => {
  const workerIds = new Set(tenant.workers.map((w) => w.id));
  const levelIds = new Set(tenant.levels.map((l) => l.id));
  const teamIds = new Set(tenant.teams.map((t) => t.id));
  const departmentIds = new Set(tenant.departments.map((d) => d.id));
  const locationIds = new Set(tenant.locations.map((l) => l.id));
  const requisitionIds = new Set(tenant.job_requisitions.map((r) => r.id));
  const candidateIds = new Set(tenant.candidates.map((c) => c.id));

  it('resolves every worker reference', () => {
    for (const worker of tenant.workers) {
      expect(levelIds.has(worker.level_id)).toBe(true);
      expect(teamIds.has(worker.team_id)).toBe(true);
      expect(departmentIds.has(worker.department_id)).toBe(true);
      expect(locationIds.has(worker.location_id)).toBe(true);
      if (worker.manager_id !== null) expect(workerIds.has(worker.manager_id)).toBe(true);
    }
  });

  it('resolves every application, absence, rating and identity reference', () => {
    for (const application of tenant.applications) {
      expect(candidateIds.has(application.candidate_id)).toBe(true);
      expect(requisitionIds.has(application.job_id)).toBe(true);
    }
    const leaveTypeIds = new Set(tenant.leave_types.map((t) => t.id));
    for (const absence of tenant.absences) {
      expect(workerIds.has(absence.worker_id)).toBe(true);
      expect(leaveTypeIds.has(absence.leave_type_id)).toBe(true);
    }
    for (const rating of tenant.prior_ratings) {
      expect(workerIds.has(rating.worker_id)).toBe(true);
      expect(workerIds.has(rating.rated_by_worker_id)).toBe(true);
    }
    for (const identity of tenant.identities) {
      expect(workerIds.has(identity.worker_id)).toBe(true);
    }
    for (const holiday of tenant.holidays) {
      expect(locationIds.has(holiday.location_id)).toBe(true);
    }
  });

  it('gives every candidate a résumé that exists', () => {
    for (const candidate of tenant.candidates) {
      expect(tenant.resumes[candidate.resume_ref]).toBeTypeOf('string');
    }
    expect(Object.keys(tenant.resumes)).toHaveLength(40);
  });
});

describe('scenario requirement: identities', () => {
  it('names an HRBP default, a recruiter and a hiring manager', () => {
    const byRole = Object.fromEntries(tenant.identities.map((i) => [i.role, i]));
    expect(byRole.hrbp?.worker_id).toBe(PINNED.hrbp);
    expect(byRole.hrbp?.is_default).toBe(true);
    expect(byRole.recruiter?.worker_id).toBe(PINNED.recruiter);
    expect(byRole.manager?.worker_id).toBe(PINNED.hiring_manager);
    expect(tenant.identities.filter((i) => i.is_default)).toHaveLength(1);
    expect(byRole.hrbp?.permissions).toContain('custom_objects.write');
    expect(byRole.hrbp?.permissions).toContain('slack.send_as_user');
  });
});

describe('scenario requirement: absences over the anchor date', () => {
  const approvedOverlapping = tenant.absences.filter(
    (absence) =>
      absence.status === 'APPROVED' && overlapsAnchor(absence.start_date, absence.end_date),
  );

  it('has at least eight approved absences covering 2026-09-02', () => {
    expect(approvedOverlapping.length).toBeGreaterThanOrEqual(8);
  });

  it('includes two managers with at least three reports each, returning on the plan dates', () => {
    const counts = reportCounts(tenant);
    const short = approvedOverlapping.find((a) => a.worker_id === PINNED.pto_manager_short);
    const long = approvedOverlapping.find((a) => a.worker_id === PINNED.pto_manager_long);
    expect(short?.end_date).toBe('2026-09-03');
    expect(long?.end_date).toBe('2026-09-08');
    expect(counts.get(PINNED.pto_manager_short) ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts.get(PINNED.pto_manager_long) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('includes one parental leave running through October', () => {
    const parental = approvedOverlapping.filter((a) => a.leave_type_id === 'lt_parental');
    expect(parental).toHaveLength(1);
    expect(parental[0]?.worker_id).toBe(PINNED.parental_leave);
    expect(parental[0]?.end_date).toBe('2026-10-31');
  });

  it('includes at least five other approved overlaps', () => {
    const others = approvedOverlapping.filter(
      (absence) =>
        absence.worker_id !== PINNED.pto_manager_short &&
        absence.worker_id !== PINNED.pto_manager_long &&
        absence.leave_type_id !== 'lt_parental',
    );
    expect(others.length).toBeGreaterThanOrEqual(5);
  });

  it('includes PENDING overlaps and non-overlapping rows so filters can be told apart', () => {
    const pendingOverlaps = tenant.absences.filter(
      (a) => a.status === 'PENDING' && overlapsAnchor(a.start_date, a.end_date),
    );
    const nonOverlapping = tenant.absences.filter((a) => !overlapsAnchor(a.start_date, a.end_date));
    expect(pendingOverlaps.length).toBeGreaterThanOrEqual(2);
    expect(nonOverlapping.some((a) => a.end_date < ANCHOR_DATE)).toBe(true);
    expect(nonOverlapping.some((a) => a.start_date > ANCHOR_DATE)).toBe(true);
  });
});

describe('scenario requirement: holidays', () => {
  it('has US Labor Day on 2026-09-07 and three India holidays', () => {
    const labor = tenant.holidays.filter((h) => h.name === 'Labor Day');
    expect(labor.length).toBeGreaterThanOrEqual(1);
    expect(labor.every((h) => h.date === '2026-09-07')).toBe(true);
    expect(tenant.holidays.filter((h) => h.location_id === 'loc_blr')).toHaveLength(3);
  });
});

describe('scenario requirement: comp bands', () => {
  it('covers every level × job function × location group', () => {
    expect(tenant.comp_bands).toHaveLength(tenant.levels.length * 6 * 2);
    expect(tenant.comp_bands.every((band) => band.min < band.mid && band.mid < band.max)).toBe(
      true,
    );
  });

  it('puts about ten workers outside their band, on both sides', () => {
    const groupOf = new Map(tenant.locations.map((l) => [l.id, l.location_group]));
    const bands = new Map(
      tenant.comp_bands.map((b) => [`${b.level_id}|${b.job_function}|${b.location_group}`, b]),
    );
    const below: string[] = [];
    const above: string[] = [];
    for (const worker of tenant.workers) {
      const band = bands.get(
        `${worker.level_id}|${worker.job_function}|${groupOf.get(worker.location_id) ?? '?'}`,
      );
      expect(band).toBeDefined();
      if (!band) continue;
      if (worker.compensation.base_annual < band.min) below.push(worker.id);
      if (worker.compensation.base_annual > band.max) above.push(worker.id);
    }
    expect(below).toEqual([...PINNED.below_band].sort());
    expect(above).toEqual([...PINNED.above_band].sort());
    expect(below.length + above.length).toBe(10);
  });
});

describe('scenario requirement: prior ratings', () => {
  it('rates every worker who started before 2026-01-01 and has a manager', () => {
    const expected = tenant.workers.filter(
      (worker) => worker.manager_id !== null && worker.start_date < '2026-01-01',
    );
    expect(tenant.prior_ratings).toHaveLength(expected.length);
    expect(tenant.prior_ratings.every((r) => r.cycle_name === PRIOR_CYCLE_NAME)).toBe(true);
    const managerOf = new Map(tenant.workers.map((w) => [w.id, w.manager_id]));
    for (const rating of tenant.prior_ratings) {
      expect(rating.rated_by_worker_id).toBe(managerOf.get(rating.worker_id));
    }
  });

  it('has exactly one calibration outlier: a manager averaging 4.5+ over 4+ reports', () => {
    const byManager = new Map<string, number[]>();
    for (const rating of tenant.prior_ratings) {
      const bucket = byManager.get(rating.rated_by_worker_id) ?? [];
      bucket.push(rating.rating);
      byManager.set(rating.rated_by_worker_id, bucket);
    }
    const outliers = [...byManager.entries()].filter(
      ([, ratings]) =>
        ratings.length >= 4 && ratings.reduce((a, b) => a + b, 0) / ratings.length >= 4.5,
    );
    expect(outliers.map(([id]) => id)).toEqual([PINNED.outlier_manager]);
  });
});

describe('scenario requirement: requisitions and headcount', () => {
  const byId = Object.fromEntries(tenant.job_requisitions.map((r) => [r.id, r]));

  it('has three open requisitions and one closed on 2026-05-01', () => {
    expect(tenant.job_requisitions.filter((r) => r.status === 'OPEN')).toHaveLength(3);
    expect(byId[REQ_IDS.senior_eng_closed]?.status).toBe('CLOSED');
    expect(byId[REQ_IDS.senior_eng_closed]?.closed_at).toBe('2026-05-01T16:00:00Z');
  });

  it('places req_staff_eng at L6 in SF against an on-plan headcount position', () => {
    const req = byId[REQ_IDS.staff_eng];
    expect(req?.level_id).toBe('lvl_L6');
    expect(req?.location_id).toBe('loc_sf');
    expect(req?.hiring_manager_id).toBe(PINNED.hiring_manager);
    const position = tenant.headcount_positions.find((p) => p.id === req?.headcount_position_id);
    expect(position?.status).toBe('OPEN');
    expect(position?.job_requisition_id).toBe(REQ_IDS.staff_eng);
  });

  it('places req_ae at L4 in NYC and leaves req_designer off-plan', () => {
    expect(byId[REQ_IDS.ae]?.level_id).toBe('lvl_L4');
    expect(byId[REQ_IDS.ae]?.location_id).toBe('loc_nyc');
    expect(byId[REQ_IDS.designer]?.level_id).toBe('lvl_L5');
    expect(byId[REQ_IDS.designer]?.location_id).toBe('loc_remote_us');
    expect(byId[REQ_IDS.designer]?.headcount_position_id).toBeNull();
  });

  it('keeps some headcount positions PLANNED for the approval loop', () => {
    expect(tenant.headcount_positions.filter((p) => p.status === 'PLANNED').length).toBeGreaterThan(
      0,
    );
  });
});

describe('scenario requirement: candidates and applications', () => {
  it('has 40 candidates and 44 applications', () => {
    expect(tenant.candidates).toHaveLength(40);
    expect(tenant.applications).toHaveLength(44);
  });

  it('has at least three ACTIVE candidates at Onsite on req_staff_eng', () => {
    const onsite = tenant.applications.filter(
      (a) => a.job_id === REQ_IDS.staff_eng && a.status === 'ACTIVE' && a.stage === 'Onsite',
    );
    expect(onsite.length).toBeGreaterThanOrEqual(3);
  });

  it('has at least six silver medalists rejected at Onsite or Offer about four months ago', () => {
    const silver = tenant.applications.filter(
      (a) =>
        a.job_id === REQ_IDS.senior_eng_closed &&
        a.status === 'REJECTED' &&
        (a.stage === 'Onsite' || a.stage === 'Offer'),
    );
    expect(silver.length).toBeGreaterThanOrEqual(6);
    expect(silver.every((a) => a.updated_at === '2026-05-01T16:00:00Z')).toBe(true);
  });

  it('has exactly two referrals and exactly one hire', () => {
    const referrals = tenant.candidates.filter((c) => c.source === 'referral');
    expect(referrals).toHaveLength(2);
    expect(referrals.every((c) => typeof c.referred_by_worker_id === 'string')).toBe(true);
    expect(tenant.applications.filter((a) => a.status === 'HIRED')).toHaveLength(1);
  });

  it('gives every REJECTED application a reason and nobody else one', () => {
    for (const application of tenant.applications) {
      if (application.status === 'REJECTED')
        expect(application.rejected_reason).toBeTypeOf('string');
      else expect(application.rejected_reason).toBeUndefined();
    }
  });

  it('never dates an application after the anchor', () => {
    for (const application of tenant.applications) {
      expect(application.applied_at <= application.updated_at).toBe(true);
      expect(application.updated_at.slice(0, 10) <= ANCHOR_DATE).toBe(true);
    }
  });
});

describe('scenario requirement: untrusted résumés', () => {
  it('trips the instruction detector on exactly the two injected résumés', () => {
    const anomalous: string[] = [];
    for (const [ref, body] of Object.entries(tenant.resumes)) {
      if (detectInstructionText(body).anomalous) anomalous.push(ref);
    }
    expect(anomalous.sort()).toEqual(
      [...INJECTED_RESUME_CANDIDATES].map((id) => `resumes/${id}.md`).sort(),
    );
    expect(Object.keys(tenant.resumes).length - anomalous.length).toBe(38);
  });

  it('records which rule each injected résumé fires', () => {
    const first = tenant.resumes['resumes/cand_0003.md'] ?? '';
    const second = tenant.resumes['resumes/cand_0033.md'] ?? '';
    expect(detectInstructionText(first).rule).toBe('ignore_prior_instructions');
    expect(detectInstructionText(second).rule).toBe('ai_addressed');
  });
});

describe('scenario requirement: the seeded review cycle', () => {
  it('ships one configured, unopened H2 2026 cycle owned by the HRBP', () => {
    expect(tenant.state.cycles).toHaveLength(1);
    const cycle = tenant.state.cycles[0];
    expect(cycle?.id).toBe(REVIEW_CYCLE_ID);
    expect(cycle?.type).toBe('review');
    expect(cycle?.status).toBe('configured');
    expect(cycle?.opened_at).toBeNull();
    expect(cycle?.owner_worker_id).toBe(PINNED.hrbp);
    expect(cycle?.created_by).toBe(PINNED.hrbp);
    expect(cycle?.deadline).toBe('2026-09-18T23:59:59Z');
    expect(cycle?.policy_ref).toBe('tenant/policy.yml');
    expect(cycle?.scope.department_ids).toHaveLength(6);
  });

  it('leaves every other state collection empty — cycle.mjs open creates the tasks', () => {
    expect(tenant.state.tasks).toEqual([]);
    expect(tenant.state.nudges).toEqual([]);
    expect(tenant.state.packets).toEqual([]);
    expect(tenant.state.proposed_actions).toEqual([]);
    expect(tenant.state.matches).toEqual([]);
    expect(tenant.state.interview_slots).toEqual([]);
    expect(tenant.state.scorecards).toEqual([]);
    expect(tenant.state.review_submissions).toEqual([]);
    expect(tenant.state.anomalies).toEqual([]);
  });
});

describe('scenario requirement: the Google Calendar seam (loop 2)', () => {
  const busy = tenant.calendar_busy;

  it('covers the week of 2026-09-07 and points only at real workers', () => {
    expect(busy.length).toBeGreaterThan(0);
    const workerIds = new Set(tenant.workers.map((worker) => worker.id));
    for (const block of busy) {
      expect(workerIds.has(block.worker_id)).toBe(true);
      expect(block.start_at < block.end_at).toBe(true);
      expect(block.start_at >= '2026-09-07').toBe(true);
      expect(block.start_at < '2026-09-12').toBe(true);
    }
  });

  it('says nothing about absence: no block falls on Labor Day', () => {
    // 2026-09-07 is a holiday at SF, NYC and Remote (US); absence answers that, not gcal.
    expect(busy.filter((block) => block.start_at.startsWith('2026-09-07'))).toEqual([]);
  });

  it('blocks one panel member out for the whole of 2026-09-08', () => {
    const tuesday = busy.filter(
      (block) => block.start_at.startsWith('2026-09-08') && block.end_at > '2026-09-08T22:00:00Z',
    );
    expect(tuesday).toHaveLength(1);
    expect(STAFF_ENG_PANEL).toContain(tuesday[0]?.worker_id);
  });

  it('leaves the whole panel free over the chosen 2026-09-09 slot, and the substitute too', () => {
    const clashes = busy.filter(
      (block) =>
        [...STAFF_ENG_PANEL, STAFF_ENG_SUBSTITUTE].includes(block.worker_id) &&
        block.start_at < STAFF_ENG_SLOT.end_at &&
        block.end_at > STAFF_ENG_SLOT.start_at,
    );
    expect(clashes).toEqual([]);
  });

  it('names a decliner on the panel and a substitute who is not', () => {
    expect(STAFF_ENG_PANEL).toContain(STAFF_ENG_DECLINER);
    expect(STAFF_ENG_PANEL).not.toContain(STAFF_ENG_SUBSTITUTE);
    const decliner = tenant.workers.find((worker) => worker.id === STAFF_ENG_DECLINER);
    const substitute = tenant.workers.find((worker) => worker.id === STAFF_ENG_SUBSTITUTE);
    expect(substitute?.team_id).toBe(decliner?.team_id);
    expect(substitute?.level_id).toBe(decliner?.level_id);
    expect(substitute?.status).toBe('ACTIVE');
    const absent = tenant.absences.filter(
      (absence) =>
        absence.worker_id === STAFF_ENG_SUBSTITUTE &&
        absence.status === 'APPROVED' &&
        absence.start_date <= '2026-09-09' &&
        absence.end_date >= '2026-09-09',
    );
    expect(absent).toEqual([]);
  });
});
