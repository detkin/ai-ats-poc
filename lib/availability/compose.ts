/**
 * lib/availability/compose.ts — availability is Rippling-first, and this is where that is code.
 *
 * Owns: `composeAvailability(absence, freebusy, opts?)`, which builds the one `AvailabilityPort`
 * the runtime hands out. Two authorities go in and they are **not** equals:
 *
 *   - **Rippling absence** (`absenceOn`, `listAbsences`, `quietHours`) is authoritative for
 *     whether a person may be scheduled or contacted at all. Approved leave, a location
 *     holiday, a weekend, a time outside the location's work hours — all of it comes from
 *     here, and all of it is checked *before* any calendar is read.
 *   - **Google Calendar free/busy** (`lib/ports/freebusy.ts`) supplies the single signal
 *     Rippling's API does not expose: meeting-level busy blocks. It can only ever *remove*
 *     candidate slots. It can never add one, and it is never consulted about a person
 *     Rippling says is away (spec §4: "never nudge or hold against Google Calendar alone").
 *
 * **The seam.** On an internal build this composition collapses: Rippling's own calendar
 * layer already federates Google/O365 through the Workspace connector and holds
 * Rippling-native events (PTO, holidays, interviews booked by Smart Scheduling) that never
 * reach the backing Google calendar, and `placeHold` becomes a **Smart Scheduling** call
 * rather than a calendar event insert. `opts.holdWriter` exists for exactly that swap: reads
 * can stay on Google while the write moves.
 *
 * Public interface: `composeAvailability`, `ComposeOptions`, `AbsenceAuthority`,
 * `AbsenceWinsError`, `SLOT_GRID_MINUTES`, `MAX_CANDIDATE_SLOTS`.
 *
 * Determinism (spec §10): candidate starts walk a fixed 30-minute grid from `q.from`, so
 * the same inputs always yield the same slots in the same order — earliest first.
 *
 * Spec: docs/SPEC.md §4, §8 loop 2, §9; docs/PLAN.md §2.3, §5 block B2.1.
 */

import { dateOf, parseInstant } from '#lib/engine/time.ts';
import type {
  AbsenceAnswer,
  AvailabilityPort,
  HoldInput,
  HoldResult,
  QuietHoursAnswer,
  Slot,
  SlotQuery,
} from '#lib/ports/availability.ts';
import type { BusyBlock, FreeBusyPort, HoldWriter } from '#lib/ports/freebusy.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type { Absence, DateISO, InstantISO, WorkerId } from '#lib/types/tier1.ts';

/** Candidate slots start on the half hour, in UTC. */
export const SLOT_GRID_MINUTES = 30;

/** Guard rail: a query wider than this many grid steps is answered with what fits. */
export const MAX_CANDIDATE_SLOTS = 5_000;

const MS_PER_MINUTE = 60_000;

/**
 * The authoritative half of the composition — the Rippling-backed adapter. Named as its own
 * type so the composition cannot accidentally be handed a Google-backed object.
 */
export type AbsenceAuthority = Pick<AvailabilityPort, 'absenceOn' | 'listAbsences' | 'quietHours'>;

export interface ComposeOptions {
  /**
   * Where a hold is actually written. Defaults to `freebusy` (Google, in the POC); an
   * internal build passes Smart Scheduling here and keeps Google for the reads.
   */
  holdWriter?: HoldWriter;
}

/**
 * A hold was refused because Rippling says an attendee is away that day. This is the rule of
 * spec §4 made into an exception: a free Google calendar is not permission to book somebody
 * who is on approved leave or whose location is on holiday.
 */
export class AbsenceWinsError extends TalentLoopsError {
  readonly workerId: WorkerId;
  readonly date: DateISO;
  readonly answer: AbsenceAnswer;

  constructor(workerId: WorkerId, date: DateISO, answer: AbsenceAnswer) {
    super(
      'ABSENCE_WINS',
      `Refusing to hold time on ${date} for ${workerId}: ${answer.source} reports them ` +
        `absent${answer.reason === undefined ? '' : ` (${answer.reason})`}. ` +
        'Rippling absence is authoritative; a free calendar does not override it (spec §4).',
    );
    this.name = 'AbsenceWinsError';
    this.workerId = workerId;
    this.date = date;
    this.answer = answer;
  }
}

/** `YYYY-MM-DDTHH:MM:SSZ` — the second-precision instant shape used across the project. */
function instantOf(ms: number): InstantISO {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Round `ms` up to the next `step` boundary (epoch-aligned, so 30 minutes means :00/:30). */
function ceilTo(ms: number, step: number): number {
  const remainder = ((ms % step) + step) % step;
  return remainder === 0 ? ms : ms + (step - remainder);
}

/** De-duplicated attendee list in id order, so a slot's `worker_ids` is stable. */
function normalizeWorkerIds(workerIds: readonly WorkerId[]): WorkerId[] {
  return [...new Set(workerIds)].sort();
}

/** The UTC calendar dates a `[start, end)` interval touches. Usually one, two across midnight. */
function datesTouched(startMs: number, endMs: number): DateISO[] {
  const first = dateOf(instantOf(startMs));
  const last = dateOf(instantOf(Math.max(startMs, endMs - 1)));
  return first === last ? [first] : [first, last];
}

/** `true` when a busy block overlaps `[startMs, endMs)`. Touching edges do not overlap. */
function overlaps(block: BusyBlock, startMs: number, endMs: number): boolean {
  return parseInstant(block.start_at) < endMs && parseInstant(block.end_at) > startMs;
}

/**
 * Build the composed Availability port.
 *
 * ```ts
 * const availability = composeAvailability(
 *   new FixtureAvailabilityAdapter(bundle, policy),   // Rippling absence — authoritative
 *   new GcalFixtureAdapter({ … }),                    // free/busy — secondary, labelled seam
 * );
 * ```
 */
export function composeAvailability(
  absence: AbsenceAuthority,
  freebusy: FreeBusyPort,
  opts: ComposeOptions = {},
): AvailabilityPort {
  const holdWriter: HoldWriter = opts.holdWriter ?? freebusy;

  /** One `absenceOn` call per worker per date, however many slots ask about it. */
  const absenceCache = new Map<string, Promise<AbsenceAnswer>>();
  const absenceOnCached = (workerId: WorkerId, date: DateISO): Promise<AbsenceAnswer> => {
    const key = `${workerId}|${date}`;
    const hit = absenceCache.get(key);
    if (hit !== undefined) return hit;
    const answer = absence.absenceOn(workerId, date);
    absenceCache.set(key, answer);
    return answer;
  };

  /** Same for quiet hours, which is asked twice per candidate slot (start and end). */
  const quietCache = new Map<string, Promise<QuietHoursAnswer>>();
  const quietHoursCached = (workerId: WorkerId, instant: InstantISO): Promise<QuietHoursAnswer> => {
    const key = `${workerId}|${instant}`;
    const hit = quietCache.get(key);
    if (hit !== undefined) return hit;
    const answer = absence.quietHours(workerId, instant);
    quietCache.set(key, answer);
    return answer;
  };

  /** Rippling first: is anybody away on any date this interval touches? */
  const anyoneAbsent = async (
    workerIds: readonly WorkerId[],
    startMs: number,
    endMs: number,
  ): Promise<{ worker_id: WorkerId; date: DateISO; answer: AbsenceAnswer } | null> => {
    for (const workerId of workerIds) {
      for (const date of datesTouched(startMs, endMs)) {
        const answer = await absenceOnCached(workerId, date);
        if (answer.absent) return { worker_id: workerId, date, answer };
      }
    }
    return null;
  };

  return {
    /* ---------------------------------------- authoritative: straight delegation */

    async absenceOn(workerId: WorkerId, dateISO: DateISO): Promise<AbsenceAnswer> {
      return absence.absenceOn(workerId, dateISO);
    },

    async listAbsences(
      workerId: WorkerId,
      range: { from: DateISO; to: DateISO },
    ): Promise<Absence[]> {
      return absence.listAbsences(workerId, range);
    },

    async quietHours(workerId: WorkerId, instantISO: InstantISO): Promise<QuietHoursAnswer> {
      return absence.quietHours(workerId, instantISO);
    },

    /* -------------------------------------------------------- composed: slots */

    /**
     * Every `duration_min` window on the 30-minute grid inside `[q.from, q.to)` where each
     * attendee is, in this order: (1) not absent per Rippling on any date the window touches,
     * (2) inside their location's work hours at both ends of the window — the same
     * quiet-hours rule that governs nudges, and (3) free of Google busy blocks.
     *
     * The order matters as much as the answer: a person Rippling reports as away is dropped
     * before their calendar is looked at, so a conveniently empty calendar can never book
     * somebody who is on leave.
     */
    async findFreeSlots(workerIds: WorkerId[], q: SlotQuery): Promise<Slot[]> {
      const attendees = normalizeWorkerIds(workerIds);
      if (attendees.length === 0) return [];
      if (q.duration_min <= 0) return [];

      const step = SLOT_GRID_MINUTES * MS_PER_MINUTE;
      const duration = q.duration_min * MS_PER_MINUTE;
      const windowStart = parseInstant(q.from);
      const windowEnd = parseInstant(q.to);
      if (windowEnd - windowStart < duration) return [];

      const busyByWorker = new Map<WorkerId, BusyBlock[]>();
      for (const block of await freebusy.busy(attendees, { from: q.from, to: q.to })) {
        const list = busyByWorker.get(block.worker_id);
        if (list === undefined) busyByWorker.set(block.worker_id, [block]);
        else list.push(block);
      }

      const slots: Slot[] = [];
      let steps = 0;
      for (
        let startMs = ceilTo(windowStart, step);
        startMs + duration <= windowEnd && steps < MAX_CANDIDATE_SLOTS;
        startMs += step, steps += 1
      ) {
        const endMs = startMs + duration;

        // (1) Rippling absence, before any calendar is consulted.
        if ((await anyoneAbsent(attendees, startMs, endMs)) !== null) continue;

        // (2) Work hours / weekends / holidays, per attendee location.
        let quiet = false;
        for (const workerId of attendees) {
          const atStart = await quietHoursCached(workerId, instantOf(startMs));
          if (atStart.quiet) {
            quiet = true;
            break;
          }
          const atEnd = await quietHoursCached(workerId, instantOf(endMs - 1_000));
          if (atEnd.quiet) {
            quiet = true;
            break;
          }
        }
        if (quiet) continue;

        // (3) Only now, the secondary signal.
        const busy = attendees.some((workerId) =>
          (busyByWorker.get(workerId) ?? []).some((block) => overlaps(block, startMs, endMs)),
        );
        if (busy) continue;

        slots.push({
          start_at: instantOf(startMs),
          end_at: instantOf(endMs),
          worker_ids: attendees,
        });
      }
      return slots;
    },

    /**
     * The one allowlisted calendar write (`WRITE_ALLOWLIST.availability`). It refuses with
     * `AbsenceWinsError` if Rippling reports any attendee away on a date the slot touches,
     * and only then delegates to the hold writer. There is no path from a caller to Google
     * that skips this check — that is the whole reason the composition exists.
     */
    async placeHold(slot: Slot, input: HoldInput): Promise<HoldResult> {
      const attendees = normalizeWorkerIds(
        input.attendees.length > 0 ? input.attendees : slot.worker_ids,
      );
      const startMs = parseInstant(slot.start_at);
      const endMs = parseInstant(slot.end_at);
      const away = await anyoneAbsent(attendees, startMs, Math.max(endMs, startMs + 1));
      if (away !== null) throw new AbsenceWinsError(away.worker_id, away.date, away.answer);
      return holdWriter.placeHold(slot, input);
    },
  };
}
