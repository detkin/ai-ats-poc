/**
 * tests/adapters/availability.test.ts — absence is authoritative; quiet hours are local.
 *
 * Proves the loop-1 preconditions on the committed fixtures (fixtures/README.md):
 * `w_0009` is on approved PTO over the anchor and returns 2026-09-04 (`until` 2026-09-03),
 * `w_0033` is on parental leave until 2026-10-31, a US worker is absent by `holiday` on Labor
 * Day, a PENDING absence is *not* an absence, and a weekend is quiet hours rather than
 * absence. Quiet hours are evaluated in the worker's location timezone.
 *
 * Spec: docs/SPEC.md §4, §7 step 1, §8 loop 1; docs/PLAN.md §4 block B1.2 (tests).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FixtureAvailabilityAdapter,
  NotImplementedYetError,
  localParts,
} from '#lib/adapters/fixture/availability.ts';
import { repoRoot } from '#lib/config.ts';
import { loadTenant } from '#lib/fixtures/index.ts';
import { POLICY_FILENAME, loadPolicy } from '#lib/policy/index.ts';
import { join } from 'node:path';

const ANCHOR_DATE = '2026-09-02';
const LABOR_DAY = '2026-09-07';
const SF_WORKER = 'w_0021'; // HRBP, San Francisco (America/Los_Angeles, 09:00–18:00)
const BLR_WORKER = 'w_0009'; // Manager, Infrastructure, Bangalore (Asia/Kolkata, 10:00–19:00)

let availability: FixtureAvailabilityAdapter;

beforeAll(() => {
  const bundle = loadTenant(join(repoRoot(), 'fixtures', 'tenant'));
  const policy = loadPolicy(join(repoRoot(), 'tenant', POLICY_FILENAME));
  availability = new FixtureAvailabilityAdapter(bundle, policy);
});

afterAll(() => undefined);

describe('absenceOn — Rippling absence is authoritative', () => {
  it('reports approved PTO with the day the person comes back', async () => {
    const answer = await availability.absenceOn(BLR_WORKER, ANCHOR_DATE);
    expect(answer.absent).toBe(true);
    expect(answer.source).toBe('rippling.absence');
    expect(answer.reason).toBe('PTO');
    expect(answer.until).toBe('2026-09-03');
  });

  it('reports parental leave running to the end of October', async () => {
    const answer = await availability.absenceOn('w_0033', ANCHOR_DATE);
    expect(answer.absent).toBe(true);
    expect(answer.reason).toBe('Parental');
    expect(answer.until).toBe('2026-10-31');
  });

  it('treats a location holiday as absence, sourced as holiday', async () => {
    const answer = await availability.absenceOn(SF_WORKER, LABOR_DAY);
    expect(answer.absent).toBe(true);
    expect(answer.source).toBe('holiday');
    expect(answer.reason).toBe('Labor Day');
    expect(answer.until).toBe(LABOR_DAY);
  });

  it('does not treat a PENDING absence as absence', async () => {
    // abs_0010: w_0072, 2026-09-01 → 2026-09-05, PENDING (fixtures/README.md).
    const answer = await availability.absenceOn('w_0072', ANCHOR_DATE);
    expect(answer.absent).toBe(false);
    const rows = await availability.listAbsences('w_0072', { from: ANCHOR_DATE, to: ANCHOR_DATE });
    expect(rows.some((row) => row.status === 'PENDING')).toBe(true);
  });

  it('does not treat a weekend as absence', async () => {
    // 2026-09-05 is a Saturday; the SF worker has no leave row over it.
    const answer = await availability.absenceOn(SF_WORKER, '2026-09-05');
    expect(answer.absent).toBe(false);
  });

  it('says nothing about a clear day, and lists only overlapping rows', async () => {
    expect((await availability.absenceOn(SF_WORKER, ANCHOR_DATE)).absent).toBe(false);
    const june = await availability.listAbsences(BLR_WORKER, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(june.map((row) => row.id)).toEqual(['abs_0012']);
  });
});

describe('quietHours — the worker location decides', () => {
  it('is not quiet for an SF worker at 09:00 Pacific', async () => {
    const answer = await availability.quietHours(SF_WORKER, '2026-09-02T16:00:00Z');
    expect(answer.quiet).toBe(false);
  });

  it('is quiet for an SF worker at 21:00 Pacific', async () => {
    const answer = await availability.quietHours(SF_WORKER, '2026-09-02T04:00:00Z');
    expect(answer.quiet).toBe(true);
    expect(answer.reason).toContain('America/Los_Angeles');
  });

  it('is quiet on a Saturday, inside working hours', async () => {
    const answer = await availability.quietHours(SF_WORKER, '2026-09-05T18:00:00Z');
    expect(answer.quiet).toBe(true);
    expect(answer.reason).toContain('weekend');
  });

  it('is quiet for a Bangalore worker at 21:30 IST — the same instant the SF worker is free', async () => {
    const answer = await availability.quietHours(BLR_WORKER, '2026-09-02T16:00:00Z');
    expect(answer.quiet).toBe(true);
  });

  it('is quiet on a local holiday', async () => {
    const answer = await availability.quietHours(SF_WORKER, '2026-09-07T17:00:00Z');
    expect(answer.quiet).toBe(true);
    expect(answer.reason).toContain('Labor Day');
  });

  it('reads the instant in the location timezone', () => {
    expect(localParts(new Date('2026-09-02T16:00:00Z'), 'America/Los_Angeles')).toEqual({
      date: '2026-09-02',
      minutes: 9 * 60,
      weekday: 3,
    });
    expect(localParts(new Date('2026-09-02T16:00:00Z'), 'Asia/Kolkata')).toEqual({
      date: '2026-09-02',
      minutes: 21 * 60 + 30,
      weekday: 3,
    });
  });
});

describe('scheduling is M2', () => {
  it('throws NotImplementedYetError rather than inventing a slot', async () => {
    await expect(
      availability.findFreeSlots([SF_WORKER], {
        from: '2026-09-03T16:00:00Z',
        to: '2026-09-04T16:00:00Z',
        duration_min: 45,
      }),
    ).rejects.toThrow(NotImplementedYetError);
    await expect(
      availability.placeHold(
        { start_at: '2026-09-03T16:00:00Z', end_at: '2026-09-03T17:00:00Z', worker_ids: [] },
        { title: 'Onsite', attendees: [] },
      ),
    ).rejects.toThrow(/M2/);
  });
});
