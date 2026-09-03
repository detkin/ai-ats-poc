/**
 * tests/availability/compose.test.ts — Rippling absence wins, and the order is the proof.
 *
 * Covers spec §4's rule as a truth table: absent per Rippling means no slot and a refused
 * hold *however free the calendar looks*; present per Rippling but busy on the calendar means
 * no slot; both clear means a slot; quiet hours (work hours, weekends, holidays) drop a slot
 * before the calendar is consulted; and the ordering is deterministic, earliest first.
 *
 * Then the real thing: the committed fixture tenant's `req_staff_eng` panel over the week of
 * 2026-09-07, which is what block B2.2's demo books against.
 *
 * Spec: docs/SPEC.md §4, §8 loop 2; docs/PLAN.md §5 block B2.1.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixtureAvailabilityAdapter } from '#lib/adapters/fixture/availability.ts';
import { GcalFixtureAdapter } from '#lib/adapters/gcal/index.ts';
import { AbsenceWinsError, composeAvailability } from '#lib/availability/compose.ts';
import { repoRoot } from '#lib/config.ts';
import { loadTenant } from '#lib/fixtures/index.ts';
import { STAFF_ENG_PANEL, STAFF_ENG_SLOT } from '#lib/fixtures/gen/calendar.ts';
import type { TenantBundle } from '#lib/fixtures/index.ts';
import { POLICY_FILENAME, loadPolicy } from '#lib/policy/index.ts';
import type { AbsenceAnswer, AvailabilityPort, QuietHoursAnswer } from '#lib/ports/availability.ts';
import type { AbsenceAuthority } from '#lib/availability/compose.ts';
import type { BusyBlock, FreeBusyPort } from '#lib/ports/freebusy.ts';
import type { Absence, WorkerId } from '#lib/types/tier1.ts';

/* --------------------------------------------------------------------- stubs */

interface StubOptions {
  absentDates?: string[];
  quietInstants?: string[];
  busy?: { worker_id: WorkerId; start_at: string; end_at: string }[];
}

/** Records what the composition asked, so the *order* of the questions can be asserted. */
interface Asked {
  absence: string[];
  busy: number;
}

function stubs(options: StubOptions): {
  absence: AbsenceAuthority;
  freebusy: FreeBusyPort;
  asked: Asked;
  holds: { attendees: WorkerId[]; title: string }[];
} {
  const asked: Asked = { absence: [], busy: 0 };
  const holds: { attendees: WorkerId[]; title: string }[] = [];

  const absence: AbsenceAuthority = {
    async absenceOn(workerId, dateISO): Promise<AbsenceAnswer> {
      asked.absence.push(`${workerId}|${dateISO}`);
      return (options.absentDates ?? []).includes(dateISO)
        ? { absent: true, reason: 'PTO', until: dateISO, source: 'rippling.absence' }
        : { absent: false, source: 'rippling.absence' };
    },
    async listAbsences(): Promise<Absence[]> {
      return [];
    },
    async quietHours(_workerId, instantISO): Promise<QuietHoursAnswer> {
      return (options.quietInstants ?? []).includes(instantISO)
        ? { quiet: true, reason: 'outside work hours' }
        : { quiet: false };
    },
  };

  const freebusy: FreeBusyPort = {
    async busy(workerIds): Promise<BusyBlock[]> {
      asked.busy += 1;
      const wanted = new Set(workerIds);
      return (options.busy ?? [])
        .filter((block) => wanted.has(block.worker_id))
        .map((block) => ({ ...block, source: 'gcal' as const }));
    },
    async placeHold(slot, input) {
      holds.push({ attendees: [...input.attendees], title: input.title });
      return { hold_ref: 'hold_stub' };
    },
  };

  return { absence, freebusy, asked, holds };
}

const DAY = { from: '2026-09-09T16:00:00Z', to: '2026-09-09T19:00:00Z', duration_min: 60 };
const PAIR: WorkerId[] = ['w_0001', 'w_0002'];

/* ---------------------------------------------------------------- truth table */

describe('composeAvailability — the truth table of spec §4', () => {
  it('gives no slot and refuses the hold when Rippling says absent, however free the calendar', async () => {
    const { absence, freebusy, asked, holds } = stubs({ absentDates: ['2026-09-09'] });
    const availability = composeAvailability(absence, freebusy);

    expect(await availability.findFreeSlots(PAIR, DAY)).toEqual([]);
    await expect(
      availability.placeHold(
        { start_at: DAY.from, end_at: '2026-09-09T17:00:00Z', worker_ids: PAIR },
        { title: 'Onsite', attendees: PAIR },
      ),
    ).rejects.toBeInstanceOf(AbsenceWinsError);

    expect(holds).toEqual([]);
    expect(asked.absence.length).toBeGreaterThan(0);
  });

  it('gives no slot when Rippling is clear but the calendar is busy', async () => {
    const { absence, freebusy } = stubs({
      busy: [
        { worker_id: 'w_0002', start_at: '2026-09-09T15:00:00Z', end_at: '2026-09-09T19:00:00Z' },
      ],
    });
    expect(await composeAvailability(absence, freebusy).findFreeSlots(PAIR, DAY)).toEqual([]);
  });

  it('gives slots when both authorities are clear, earliest first', async () => {
    const { absence, freebusy } = stubs({});
    const slots = await composeAvailability(absence, freebusy).findFreeSlots(PAIR, DAY);
    expect(slots.map((slot) => slot.start_at)).toEqual([
      '2026-09-09T16:00:00Z',
      '2026-09-09T16:30:00Z',
      '2026-09-09T17:00:00Z',
      '2026-09-09T17:30:00Z',
      '2026-09-09T18:00:00Z',
    ]);
    expect(slots[0]).toEqual({
      start_at: '2026-09-09T16:00:00Z',
      end_at: '2026-09-09T17:00:00Z',
      worker_ids: PAIR,
    });
  });

  it('drops a slot that falls inside quiet hours before any calendar is read', async () => {
    const { absence, freebusy } = stubs({
      quietInstants: ['2026-09-09T16:00:00Z', '2026-09-09T16:30:00Z'],
    });
    const slots = await composeAvailability(absence, freebusy).findFreeSlots(PAIR, DAY);
    expect(slots.map((slot) => slot.start_at)).toEqual([
      '2026-09-09T17:00:00Z',
      '2026-09-09T17:30:00Z',
      '2026-09-09T18:00:00Z',
    ]);
  });

  it('is deterministic: the same query twice gives the same slots', async () => {
    const { absence, freebusy } = stubs({
      busy: [
        { worker_id: 'w_0001', start_at: '2026-09-09T16:30:00Z', end_at: '2026-09-09T17:00:00Z' },
      ],
    });
    const availability = composeAvailability(absence, freebusy);
    expect(await availability.findFreeSlots(PAIR, DAY)).toEqual(
      await availability.findFreeSlots(PAIR, DAY),
    );
  });

  it('normalizes attendees: duplicates collapse and order is by id', async () => {
    const { absence, freebusy } = stubs({});
    const slots = await composeAvailability(absence, freebusy).findFreeSlots(
      ['w_0002', 'w_0001', 'w_0002'],
      DAY,
    );
    expect(slots[0]?.worker_ids).toEqual(['w_0001', 'w_0002']);
  });
});

describe('composeAvailability — delegation and the hold write', () => {
  it('passes absenceOn, listAbsences and quietHours straight through', async () => {
    const { absence, freebusy } = stubs({
      absentDates: ['2026-09-09'],
      quietInstants: ['2026-09-09T16:00:00Z'],
    });
    const availability = composeAvailability(absence, freebusy);
    expect((await availability.absenceOn('w_0001', '2026-09-09')).absent).toBe(true);
    expect((await availability.quietHours('w_0001', '2026-09-09T16:00:00Z')).quiet).toBe(true);
    expect(
      await availability.listAbsences('w_0001', { from: '2026-09-01', to: '2026-09-30' }),
    ).toEqual([]);
  });

  it('delegates the hold when everybody is present', async () => {
    const { absence, freebusy, holds } = stubs({});
    const result = await composeAvailability(absence, freebusy).placeHold(
      { start_at: DAY.from, end_at: '2026-09-09T17:00:00Z', worker_ids: PAIR },
      { title: 'Onsite', attendees: PAIR },
    );
    expect(result).toEqual({ hold_ref: 'hold_stub' });
    expect(holds).toEqual([{ attendees: PAIR, title: 'Onsite' }]);
  });

  it('writes the hold through opts.holdWriter when one is given (the Smart Scheduling swap)', async () => {
    const { absence, freebusy, holds } = stubs({});
    const elsewhere: { title: string }[] = [];
    const availability = composeAvailability(absence, freebusy, {
      holdWriter: {
        async placeHold(_slot, input) {
          elsewhere.push({ title: input.title });
          return { hold_ref: 'hold_smart_scheduling' };
        },
      },
    });
    const result = await availability.placeHold(
      { start_at: DAY.from, end_at: '2026-09-09T17:00:00Z', worker_ids: PAIR },
      { title: 'Onsite', attendees: PAIR },
    );
    expect(result.hold_ref).toBe('hold_smart_scheduling');
    expect(elsewhere).toHaveLength(1);
    expect(holds).toEqual([]);
  });
});

/* ------------------------------------------------------- the fixture tenant */

describe('the req_staff_eng panel over the week of 2026-09-07', () => {
  let bundle: TenantBundle;
  let availability: AvailabilityPort;
  let dataDir: string;

  beforeAll(() => {
    const fixturesDir = join(repoRoot(), 'fixtures', 'tenant');
    dataDir = mkdtempSync(join(tmpdir(), 'tl-compose-'));
    bundle = loadTenant(fixturesDir);
    availability = composeAvailability(
      new FixtureAvailabilityAdapter(
        bundle,
        loadPolicy(join(repoRoot(), 'tenant', POLICY_FILENAME)),
      ),
      new GcalFixtureAdapter({
        fixturesDir,
        dataDir,
        actorWorkerId: 'w_0114',
        now: () => new Date('2026-09-02T16:00:00Z'),
      }),
    );
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  const week = { from: '2026-09-07T00:00:00Z', to: '2026-09-12T00:00:00Z', duration_min: 60 };

  it('offers exactly one hour on 2026-09-09, and it is the earliest slot of the week', async () => {
    const slots = await availability.findFreeSlots([...STAFF_ENG_PANEL], week);
    const wednesday = slots.filter((slot) => slot.start_at.startsWith('2026-09-09'));
    expect(wednesday).toHaveLength(1);
    expect(wednesday[0]?.start_at).toBe(STAFF_ENG_SLOT.start_at);
    expect(wednesday[0]?.end_at).toBe(STAFF_ENG_SLOT.end_at);
    expect(slots[0]?.start_at).toBe(STAFF_ENG_SLOT.start_at);
  });

  it('offers nothing on Labor Day, because absence is asked before any calendar', async () => {
    const slots = await availability.findFreeSlots([...STAFF_ENG_PANEL], week);
    expect(slots.filter((slot) => slot.start_at.startsWith('2026-09-07'))).toEqual([]);
    // …and the fixture calendar has no block that day at all, so only absence can explain it.
    expect(bundle.calendar_busy.filter((row) => row.start_at.startsWith('2026-09-07'))).toEqual([]);
  });

  it('offers nothing on 2026-09-08, because one panel member is busy all day', async () => {
    const slots = await availability.findFreeSlots([...STAFF_ENG_PANEL], week);
    expect(slots.filter((slot) => slot.start_at.startsWith('2026-09-08'))).toEqual([]);
  });

  it('refuses a hold for somebody Rippling has on approved leave', async () => {
    // `w_0009` is on PTO across the anchor and has no calendar block whatsoever.
    await expect(
      availability.placeHold(
        {
          start_at: '2026-09-02T17:00:00Z',
          end_at: '2026-09-02T18:00:00Z',
          worker_ids: ['w_0009'],
        },
        { title: 'Onsite', attendees: ['w_0009'] },
      ),
    ).rejects.toThrow(/absent/i);
  });

  it('writes a hold for a free panel and returns a hold_ref', async () => {
    const result = await availability.placeHold(
      { ...STAFF_ENG_SLOT, worker_ids: [...STAFF_ENG_PANEL] },
      { title: 'Onsite — req_staff_eng', attendees: [...STAFF_ENG_PANEL] },
    );
    expect(result.hold_ref).toMatch(/^hold_[0-9a-f]{8}$/);
  });
});
