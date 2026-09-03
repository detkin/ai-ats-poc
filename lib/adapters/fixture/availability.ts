/**
 * lib/adapters/fixture/availability.ts — "may this person be nudged?" over the fixtures.
 *
 * Owns: `FixtureAvailabilityAdapter`. Rippling absence is authoritative (spec §4): an
 * APPROVED absence covering the date, or a holiday at the worker's location, means absent —
 * no nudge, no hold, ever. A PENDING absence is not an absence. Weekends are *not* absence:
 * they are quiet hours, which is a different question with a different answer (a due date is
 * not moved because Saturday exists).
 *
 * Quiet hours are computed with `Intl.DateTimeFormat` (no dependency, no hand-rolled offset
 * table), gated by `tenant/policy.yml quiet_hours`. Three resolutions, three different rules —
 * this is the precedence the rest of the system relies on (docs/DECISIONS.md D27):
 *
 *  - **Timezone: the person wins.** `Worker.timezone` when it is set and `Intl` accepts it,
 *    else `Location.timezone`, else `quiet_hours.default_timezone`. Rippling carries the zone
 *    on the profile, not on the work location, and a remote worker's location is a synthetic
 *    placeholder standing in the tenant's default zone — deciding from it would mean somebody
 *    in Ljubljana could only ever be nudged during California office hours. An unparseable
 *    `Worker.timezone` simply falls through to the next source; nothing else happens.
 *  - **Work hours: the location wins,** because hours are a property of the office, not of the
 *    person. `quiet_hours.default_work_hours` fills in when the location carries none or is
 *    the synthetic `loc_unassigned` (the bridge's parking spot for REMOTE people).
 *  - **Holidays: the location wins,** for the same reason; `loc_unassigned` has none.
 *
 * `findFreeSlots` / `placeHold` are M2 (Google Calendar composition, block B2.1) and throw
 * `NotImplementedYetError` rather than returning a plausible lie.
 *
 * Public interface: `FixtureAvailabilityAdapter` (implements `AvailabilityPort`),
 * `NotImplementedYetError`, `localParts`, `LocalParts`, `isValidTimeZone`.
 *
 * Rippling calls this stands in for: codemode.lookup_absence, codemode.search_leave_types,
 * codemode.search_work_locations | REST GET /leave-requests, /leave-types, /work-locations.
 *
 * Spec: docs/SPEC.md §4, §7 step 1, §8 loop 1; docs/PLAN.md §2.3.
 */

import { UNASSIGNED_LOCATION_ID } from '#lib/adapters/bridge/map.ts';
import type { TenantBundle } from '#lib/fixtures/index.ts';
import type { TenantPolicy } from '#lib/policy/index.ts';
import type {
  AbsenceAnswer,
  AvailabilityPort,
  HoldInput,
  HoldResult,
  QuietHoursAnswer,
  Slot,
  SlotQuery,
} from '#lib/ports/availability.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type {
  Absence,
  DateISO,
  InstantISO,
  Location,
  WorkHours,
  Worker,
  WorkerId,
} from '#lib/types/tier1.ts';

/** A port method that exists in the contract but lands in a later milestone. */
export class NotImplementedYetError extends TalentLoopsError {
  readonly port: string;
  readonly fn: string;

  constructor(port: string, fn: string, milestone: string) {
    super(
      'NOT_IMPLEMENTED_YET',
      `${port}.${fn} is not implemented in this milestone (lands in ${milestone}).`,
    );
    this.name = 'NotImplementedYetError';
    this.port = port;
    this.fn = fn;
  }
}

/** A wall-clock instant as seen at a location. */
export interface LocalParts {
  /** `YYYY-MM-DD` local date. */
  date: DateISO;
  /** Minutes since local midnight. */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday, local. */
  weekday: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Split an instant into local date/time-of-day/weekday for `timeZone`. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;
  const hour = Number(parts.hour ?? '0');
  const minute = Number(parts.minute ?? '0');
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAY_INDEX[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/**
 * `true` when `Intl` recognises `zone` as an IANA timezone. A profile carrying junk must fall
 * through to the next source rather than throw a `RangeError` deep inside a tick.
 */
export function isValidTimeZone(zone: string | undefined | null): zone is string {
  if (typeof zone !== 'string' || zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** `HH:MM`, 24-hour. A location with a blank or malformed value carries no hours at all. */
function isWorkHours(hours: WorkHours | undefined): hours is WorkHours {
  const shaped = (value: string | undefined): boolean =>
    typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value);
  return hours !== undefined && shaped(hours.start) && shaped(hours.end);
}

/** `HH:MM` → minutes since midnight; `NaN`-safe (a bad value never silences a nudge). */
function toMinutes(hhmm: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (match === null) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Inclusive date-range containment; ISO dates compare correctly as strings. */
function covers(absence: Absence, date: DateISO): boolean {
  return absence.start_date <= date && date <= absence.end_date;
}

export class FixtureAvailabilityAdapter implements AvailabilityPort {
  private readonly bundle: TenantBundle;
  private readonly policy: TenantPolicy;

  constructor(bundle: TenantBundle, policy: TenantPolicy) {
    this.bundle = bundle;
    this.policy = policy;
  }

  /** The worker and the location they are filed under — both, or a named error. */
  private placeOf(workerId: WorkerId): { worker: Worker; location: Location } {
    const worker = this.bundle.workers.find((w) => w.id === workerId);
    if (worker === undefined) {
      throw new TalentLoopsError('WORKER_NOT_FOUND', `no worker "${workerId}" in the fixtures`);
    }
    const location = this.bundle.locations.find((l) => l.id === worker.location_id);
    if (location === undefined) {
      throw new TalentLoopsError(
        'LOCATION_NOT_FOUND',
        `worker "${workerId}" points at unknown location "${worker.location_id}"`,
      );
    }
    return { worker, location };
  }

  private locationOf(workerId: WorkerId): Location {
    return this.placeOf(workerId).location;
  }

  /**
   * Timezone precedence: the person, then their location, then the tenant default. See the
   * file header — on a bridged tenant the location is often a placeholder and the profile is
   * the only true answer.
   */
  private zoneOf(worker: Worker, location: Location): string {
    if (isValidTimeZone(worker.timezone)) return worker.timezone;
    if (isValidTimeZone(location.timezone)) return location.timezone;
    return this.policy.quiet_hours.default_timezone;
  }

  /**
   * Work hours come from the location, because they describe an office. `loc_unassigned` is
   * not an office — it is where the bridge parks people Rippling marks REMOTE — so it, and any
   * location with no usable hours, falls back to `quiet_hours.default_work_hours`.
   */
  private hoursOf(location: Location): WorkHours {
    if (location.id !== UNASSIGNED_LOCATION_ID && isWorkHours(location.work_hours)) {
      return location.work_hours;
    }
    return this.policy.quiet_hours.default_work_hours;
  }

  private leaveTypeName(leaveTypeId: string): string {
    return this.bundle.leave_types.find((t) => t.id === leaveTypeId)?.name ?? 'Leave';
  }

  /**
   * APPROVED leave first (`source: 'rippling.absence'`), then a holiday at the worker's
   * location (`source: 'holiday'`). When several approved absences overlap, the one running
   * latest wins, so `until` is the day the person is actually back.
   */
  async absenceOn(workerId: WorkerId, dateISO: DateISO): Promise<AbsenceAnswer> {
    const location = this.locationOf(workerId);

    const approved = this.bundle.absences
      .filter((a) => a.worker_id === workerId && a.status === 'APPROVED' && covers(a, dateISO))
      .sort((a, b) => (a.end_date < b.end_date ? 1 : a.end_date > b.end_date ? -1 : 0));
    const leave = approved[0];
    if (leave !== undefined) {
      return {
        absent: true,
        reason: this.leaveTypeName(leave.leave_type_id),
        until: leave.end_date,
        source: 'rippling.absence',
      };
    }

    const holiday = this.bundle.holidays.find(
      (h) => h.location_id === location.id && h.date === dateISO,
    );
    if (holiday !== undefined) {
      return { absent: true, reason: holiday.name, until: dateISO, source: 'holiday' };
    }

    return { absent: false, source: 'rippling.absence' };
  }

  /** Every absence row overlapping the range, PENDING included — this is a listing, not a gate. */
  async listAbsences(
    workerId: WorkerId,
    range: { from: DateISO; to: DateISO },
  ): Promise<Absence[]> {
    return this.bundle.absences
      .filter(
        (a) => a.worker_id === workerId && a.start_date <= range.to && a.end_date >= range.from,
      )
      .map((a) => ({ ...a }));
  }

  /**
   * Quiet when the time *where the person is* falls outside their work hours, on a weekend, or
   * on a holiday at their location — each gated by its `tenant/policy.yml quiet_hours` flag.
   * The clock is read in the worker's own timezone (see the file header for the precedence);
   * the hours and the holiday calendar are the location's. A worker who is on leave is
   * *absent*, which is a stronger answer; ask `absenceOn` for that.
   */
  async quietHours(workerId: WorkerId, instantISO: InstantISO): Promise<QuietHoursAnswer> {
    const { worker, location } = this.placeOf(workerId);
    const instant = new Date(instantISO);
    if (Number.isNaN(instant.getTime())) {
      throw new TalentLoopsError('BAD_INSTANT', `"${instantISO}" is not a valid instant`);
    }
    const zone = this.zoneOf(worker, location);
    const local = localParts(instant, zone);
    const quiet = this.policy.quiet_hours;

    if (quiet.holidays) {
      const holiday = this.bundle.holidays.find(
        (h) => h.location_id === location.id && h.date === local.date,
      );
      if (holiday !== undefined) {
        return { quiet: true, reason: `${holiday.name} at ${location.name}` };
      }
    }

    if (quiet.weekends && (local.weekday === 0 || local.weekday === 6)) {
      return { quiet: true, reason: `weekend in ${zone} (${local.date})` };
    }

    if (quiet.respect_location_hours) {
      const hours = this.hoursOf(location);
      const start = toMinutes(hours.start, 0);
      const end = toMinutes(hours.end, 24 * 60);
      if (local.minutes < start || local.minutes >= end) {
        return {
          quiet: true,
          reason:
            `outside ${hours.start}–${hours.end} ` +
            `${zone} (local ${local.date} ${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')})`,
        };
      }
    }

    return { quiet: false };
  }

  /** M2 (block B2.1): composition with the Google Calendar free/busy fixture. */
  async findFreeSlots(_workerIds: WorkerId[], _q: SlotQuery): Promise<Slot[]> {
    throw new NotImplementedYetError('availability', 'findFreeSlots', 'M2');
  }

  /** M2 (block B2.1): allowlisted calendar write on the acting user's calendar. */
  async placeHold(_slot: Slot, _input: HoldInput): Promise<HoldResult> {
    throw new NotImplementedYetError('availability', 'placeHold', 'M2');
  }
}
