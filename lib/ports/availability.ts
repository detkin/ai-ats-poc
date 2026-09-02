/**
 * lib/ports/availability.ts — may this person be nudged, and when can they meet?
 *
 * Owns: `AvailabilityPort`. Rippling absence is authoritative for *whether to act at all*;
 * Google Calendar free/busy is a secondary signal used only for slot finding (spec §4).
 * `placeHold` is the only write, and only on the acting user's calendars.
 *
 * Public interface: `AvailabilityPort`, `AbsenceAnswer`, `QuietHoursAnswer`, `Slot`,
 * `SlotQuery`, `HoldInput`, `HoldResult`.
 *
 * Rippling backing (research 06):
 *   absenceOn / listAbsences -> codemode.lookup_absence, codemode.search_leave_types
 *                               | REST GET /leave-requests, /leave-types; holiday calendar
 *   quietHours               -> codemode.search_work_locations (work hours + timezone)
 *   findFreeSlots / placeHold-> NOT in Rippling's API. Google Calendar freebusy/events in the
 *                               POC; an internal build calls Rippling Smart Scheduling instead.
 *
 * Spec: docs/SPEC.md §4, §7 (detect), §8 loop 2; docs/PLAN.md §2.3.
 */

import type { Absence, DateISO, InstantISO, WorkerId } from '#lib/types/tier1.ts';

/** `source` names which authority answered — never Google Calendar (spec §4). */
export interface AbsenceAnswer {
  absent: boolean;
  reason?: string;
  /** Last day of the absence, inclusive, when known. */
  until?: DateISO;
  source: 'rippling.absence' | 'holiday';
}

export interface QuietHoursAnswer {
  quiet: boolean;
  reason?: string;
}

export interface Slot {
  start_at: InstantISO;
  end_at: InstantISO;
  worker_ids: WorkerId[];
}

export interface SlotQuery {
  from: InstantISO;
  to: InstantISO;
  duration_min: number;
}

export interface HoldInput {
  title: string;
  attendees: WorkerId[];
}

export interface HoldResult {
  hold_ref: string;
}

export interface AvailabilityPort {
  /** Authoritative: absent → never nudge, never schedule. */
  absenceOn(workerId: WorkerId, dateISO: DateISO): Promise<AbsenceAnswer>;
  listAbsences(workerId: WorkerId, range: { from: DateISO; to: DateISO }): Promise<Absence[]>;
  /** Outside the worker's location work hours, on a weekend, or on a local holiday. */
  quietHours(workerId: WorkerId, instantISO: InstantISO): Promise<QuietHoursAnswer>;

  /** M2. Composed: Rippling absence first, gcal free/busy second. */
  findFreeSlots(workerIds: WorkerId[], q: SlotQuery): Promise<Slot[]>;
  /** M2. Allowlisted write — a calendar hold on the acting user's calendar. */
  placeHold(slot: Slot, input: HoldInput): Promise<HoldResult>;
}
