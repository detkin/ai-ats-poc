/**
 * lib/fixtures/gen/time-off.ts — leave types, absences and holidays.
 *
 * Owns: the absence table the loop-1 demo turns on. Every row here is hand-placed rather
 * than drawn, because the scenario needs exact answers: two managers with several reports
 * away over the anchor date (one back on 2026-09-04, one on 2026-09-09), a parental leave
 * running to the end of October, other approved overlaps, and non-overlapping past/future
 * and PENDING rows so tests can prove the absence filter is doing real work.
 *
 * Public interface: `LEAVE_TYPES`, `generateAbsences`, `generateHolidays`.
 *
 * Spec: docs/SPEC.md §4 (availability, Rippling-first), §8 loop 1; docs/PLAN.md §3 B0.4.
 */

import type { Absence, Holiday, LeaveType } from '#lib/types/tier1.ts';
import { PINNED } from '#lib/fixtures/gen/catalog.ts';

export const LEAVE_TYPES: LeaveType[] = [
  { id: 'lt_pto', name: 'PTO' },
  { id: 'lt_sick', name: 'Sick' },
  { id: 'lt_parental', name: 'Parental' },
  { id: 'lt_sabbatical', name: 'Sabbatical' },
];

interface AbsenceSpec {
  worker_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  status: 'APPROVED' | 'PENDING';
}

/**
 * Order matters only for id allocation (`abs_0001`…). Rows 1–9 overlap the anchor date
 * 2026-09-02 and are APPROVED; 10–11 overlap but are PENDING; 12–17 do not overlap.
 */
const ABSENCE_SPECS: AbsenceSpec[] = [
  // 1–2: managers with ≥ 3 direct reports, away over the anchor.
  {
    worker_id: PINNED.pto_manager_short,
    leave_type_id: 'lt_pto',
    start_date: '2026-08-31',
    end_date: '2026-09-03',
    status: 'APPROVED',
  },
  {
    worker_id: PINNED.pto_manager_long,
    leave_type_id: 'lt_pto',
    start_date: '2026-08-24',
    end_date: '2026-09-08',
    status: 'APPROVED',
  },
  // 3: parental leave running through October.
  {
    worker_id: PINNED.parental_leave,
    leave_type_id: 'lt_parental',
    start_date: '2026-07-13',
    end_date: '2026-10-31',
    status: 'APPROVED',
  },
  // 4–9: other approved absences overlapping the anchor.
  {
    worker_id: 'w_0041',
    leave_type_id: 'lt_pto',
    start_date: '2026-09-01',
    end_date: '2026-09-04',
    status: 'APPROVED',
  },
  {
    worker_id: 'w_0058',
    leave_type_id: 'lt_pto',
    start_date: '2026-09-01',
    end_date: '2026-09-03',
    status: 'APPROVED',
  },
  {
    worker_id: 'w_0067',
    leave_type_id: 'lt_sick',
    start_date: '2026-09-02',
    end_date: '2026-09-02',
    status: 'APPROVED',
  },
  {
    worker_id: 'w_0085',
    leave_type_id: 'lt_pto',
    start_date: '2026-08-28',
    end_date: '2026-09-07',
    status: 'APPROVED',
  },
  {
    worker_id: 'w_0104',
    leave_type_id: 'lt_pto',
    start_date: '2026-09-02',
    end_date: '2026-09-11',
    status: 'APPROVED',
  },
  {
    worker_id: 'w_0119',
    leave_type_id: 'lt_sabbatical',
    start_date: '2026-08-03',
    end_date: '2026-09-25',
    status: 'APPROVED',
  },
  // 10–11: overlap the anchor but are not approved — must not suppress a nudge.
  {
    worker_id: 'w_0072',
    leave_type_id: 'lt_pto',
    start_date: '2026-09-01',
    end_date: '2026-09-05',
    status: 'PENDING',
  },
  {
    worker_id: 'w_0093',
    leave_type_id: 'lt_pto',
    start_date: '2026-08-30',
    end_date: '2026-09-06',
    status: 'PENDING',
  },
  // 12–14: past, approved, well clear of the anchor.
  {
    worker_id: PINNED.pto_manager_short,
    leave_type_id: 'lt_pto',
    start_date: '2026-06-15',
    end_date: '2026-06-19',
    status: 'APPROVED',
  },
  {
    worker_id: 'w_0028',
    leave_type_id: 'lt_sick',
    start_date: '2026-04-06',
    end_date: '2026-04-07',
    status: 'APPROVED',
  },
  {
    worker_id: 'w_0077',
    leave_type_id: 'lt_pto',
    start_date: '2026-07-06',
    end_date: '2026-07-17',
    status: 'APPROVED',
  },
  // 15–17: future, clear of the anchor.
  {
    worker_id: PINNED.hiring_manager,
    leave_type_id: 'lt_pto',
    start_date: '2026-09-21',
    end_date: '2026-09-25',
    status: 'APPROVED',
  },
  {
    worker_id: PINNED.hrbp,
    leave_type_id: 'lt_pto',
    start_date: '2026-11-23',
    end_date: '2026-11-27',
    status: 'APPROVED',
  },
  {
    worker_id: PINNED.recruiter,
    leave_type_id: 'lt_pto',
    start_date: '2026-12-21',
    end_date: '2026-12-31',
    status: 'PENDING',
  },
];

export function generateAbsences(): Absence[] {
  return ABSENCE_SPECS.map((spec, index) => ({
    id: `abs_${String(index + 1).padStart(4, '0')}`,
    worker_id: spec.worker_id,
    leave_type_id: spec.leave_type_id,
    start_date: spec.start_date,
    end_date: spec.end_date,
    status: spec.status,
  }));
}

const US_LOCATIONS = ['loc_sf', 'loc_nyc', 'loc_remote_us'] as const;

/** US Labor Day (the quiet-hours case right after the anchor) plus Thanksgiving and India. */
export function generateHolidays(): Holiday[] {
  const holidays: Holiday[] = [];
  for (const locationId of US_LOCATIONS) {
    const suffix = locationId.replace(/^loc_/, '');
    holidays.push({
      id: `hol_us_labor_day_2026_${suffix}`,
      location_id: locationId,
      date: '2026-09-07',
      name: 'Labor Day',
    });
  }
  for (const locationId of US_LOCATIONS) {
    const suffix = locationId.replace(/^loc_/, '');
    holidays.push({
      id: `hol_us_thanksgiving_2026_${suffix}`,
      location_id: locationId,
      date: '2026-11-26',
      name: 'Thanksgiving Day',
    });
  }
  holidays.push(
    {
      id: 'hol_in_independence_day_2026_blr',
      location_id: 'loc_blr',
      date: '2026-08-15',
      name: 'Independence Day',
    },
    {
      id: 'hol_in_gandhi_jayanti_2026_blr',
      location_id: 'loc_blr',
      date: '2026-10-02',
      name: 'Gandhi Jayanti',
    },
    {
      id: 'hol_in_diwali_2026_blr',
      location_id: 'loc_blr',
      date: '2026-11-08',
      name: 'Diwali',
    },
  );
  return holidays;
}
